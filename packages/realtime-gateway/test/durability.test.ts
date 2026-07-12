/**
 * Durable Game Authority (M14 increment 2): every event is persisted to the
 * injected {@link EventLog} before its broadcast fans out, so a game survives
 * eviction from the hot cache or a process restart and rehydrates *exactly* —
 * same state, same legal moves, same resumable broadcast history.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type GameEvent, type TimeControl } from '@chess-platform/game';
import { GameAuthority, AuthorityError } from '../src/authority';
import { InMemoryPubSub, gameChannel } from '../src/pubsub';
import { InMemoryEventLog, type EventLog, type LoggedEvent } from '../src/event-log';
import type { Broadcast } from '../src/protocol';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };
const NOW = () => 1_000;

/** Create a game and play 1.e4 e5 so there is real history to persist. */
async function playedGame(store: EventLog) {
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, NOW, store);
  await authority.createGame({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
  });
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' });
  return { authority, pubsub };
}

test('events are persisted to the durable log and reconstruct the same game', async () => {
  const store = new InMemoryEventLog();
  const { authority } = await playedGame(store);

  const logged = await store.load('g1');
  // GameCreated + MovePlayed + MovePlayed.
  assert.equal(logged.length, 3);
  assert.equal(logged[0]!.event.type, 'GameCreated');
  assert.deepEqual(logged.map((e) => e.seq), [0, 1, 2]);

  const rebuilt = Game.fromEvents(logged.map((e) => e.event));
  assert.equal(rebuilt.fen, authority.getState('g1').fen);
});

test('a game evicted from the hot cache rehydrates to an identical state', async () => {
  const store = new InMemoryEventLog();
  const { authority } = await playedGame(store);

  const before = authority.getState('g1');
  const missedBefore = authority.getMissedSince('g1', 0);

  authority.evict('g1');
  assert.equal(authority.has('g1'), false);
  assert.throws(() => authority.getState('g1'), (e) => e instanceof AuthorityError && e.code === 'unknown_game');

  assert.equal(await authority.ensureLoaded('g1'), true);
  assert.deepEqual(authority.getState('g1'), before);
  assert.deepEqual(authority.getMissedSince('g1', 0), missedBefore);
});

test('a fresh authority (restart) rehydrates a game from a shared durable log', async () => {
  const store = new InMemoryEventLog();
  const { authority: first } = await playedGame(store);
  const before = first.getState('g1');
  const missedBefore = first.getMissedSince('g1', 0);

  // Simulate a process restart: a brand-new authority backed by the same log.
  const restarted = new GameAuthority(new InMemoryPubSub(), NOW, store);
  assert.equal(restarted.has('g1'), false, 'cold cache after restart');
  assert.equal(await restarted.knows('g1'), true, 'but the durable log knows it');

  assert.equal(await restarted.ensureLoaded('g1'), true);
  assert.deepEqual(restarted.getState('g1'), before);
  assert.deepEqual(restarted.getMissedSince('g1', 0), missedBefore);
});

test('rehydrated broadcasts match the live broadcasts exactly', async () => {
  const store = new InMemoryEventLog();
  const live: Broadcast[] = [];
  const pubsub = new InMemoryPubSub();
  pubsub.subscribe(gameChannel('g1'), (m) => live.push(m));
  const authority = new GameAuthority(pubsub, NOW, store);
  await authority.createGame({ gameId: 'g1', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true });
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' });

  const restarted = new GameAuthority(new InMemoryPubSub(), NOW, store);
  await restarted.ensureLoaded('g1');
  // getMissedSince(0) returns the full broadcast history it rebuilt on hydration.
  assert.deepEqual(restarted.getMissedSince('g1', 0), live);
});

test('play continues after rehydration at the correct durable sequence', async () => {
  const store = new InMemoryEventLog();
  const { authority: first } = await playedGame(store);

  const restarted = new GameAuthority(new InMemoryPubSub(), NOW, store);
  await restarted.ensureLoaded('g1');

  // White to move again after e4 e5; a further move must persist at seq 3, not
  // collide with a stale head — proving persistedSeq was reconstructed.
  await restarted.apply('g1', 'alice', { kind: 'move', uci: 'g1f3' });
  const logged = await store.load('g1');
  assert.deepEqual(logged.map((e: LoggedEvent) => e.seq), [0, 1, 2, 3]);
  assert.equal(restarted.getState('g1').ply, 3);
});

test('a rehydrated game reconstructs terminal state and empty legal moves', async () => {
  const store = new InMemoryEventLog();
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, NOW, store);
  await authority.createGame({ gameId: 'g1', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true });
  // Fool's mate.
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'f2f3' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'e7e5' });
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'g2g4' });
  await authority.apply('g1', 'bob', { kind: 'move', uci: 'd8h4' });

  const restarted = new GameAuthority(new InMemoryPubSub(), NOW, store);
  await restarted.ensureLoaded('g1');
  const s = restarted.getState('g1');
  assert.equal(s.status.over, true);
  assert.deepEqual(s.legalMoves, {});
});

test('a persist failure aborts the command: no state change, no broadcast', async () => {
  // A store that can be told to reject the next append.
  class FlakyStore implements EventLog {
    private readonly inner = new InMemoryEventLog();
    failNext = false;
    append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number> {
      if (this.failNext) return Promise.reject(new Error('disk full'));
      return this.inner.append(gameId, expectedSeq, events);
    }
    load(gameId: string): Promise<readonly LoggedEvent[]> {
      return this.inner.load(gameId);
    }
    exists(gameId: string): Promise<boolean> {
      return this.inner.exists(gameId);
    }
  }

  const store = new FlakyStore();
  const pubsub = new InMemoryPubSub();
  const seen: Broadcast[] = [];
  pubsub.subscribe(gameChannel('g1'), (m) => seen.push(m));
  const authority = new GameAuthority(pubsub, NOW, store);
  await authority.createGame({ gameId: 'g1', timeControl: TC, players: { white: 'alice', black: 'bob' }, rated: true });

  store.failNext = true;
  await assert.rejects(
    authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' }),
    (e) => e instanceof AuthorityError && e.code === 'invalid_command',
  );

  // In-memory state untouched (still the opening) and nothing was broadcast.
  assert.equal(authority.getState('g1').ply, 0);
  assert.equal(seen.length, 0);

  // Recovery: once the store accepts again, the same move applies cleanly.
  store.failNext = false;
  await authority.apply('g1', 'alice', { kind: 'move', uci: 'e2e4' });
  assert.equal(authority.getState('g1').ply, 1);
  assert.equal(seen.length, 1);
});
