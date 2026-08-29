/**
 * End-to-end Chess960 gameplay loop, driven by a **real `GameAuthority`**.
 *
 * The companion to `e2e-live-loop.test.ts`, and the test that would fail if any part of Phase B were
 * only nominally wired: the authority computes legal moves with the perft-verified engine, its
 * broadcasts go through the JSON codec, and the client stack — GameSync ⇄ AuthoritativeMoveOracle ⇄
 * BoardInteraction — resolves the gestures. No hand-written legal-move fixtures anywhere.
 *
 * **The game starts from position 700, not 518.** `RBQKNNBR` puts the king on d1 and the rooks on a1
 * and h1, so a board that quietly fell back to the traditional array cannot pass a single assertion
 * here. That is the point of choosing it: 518 *is* standard chess, so an accidentally-standard game
 * would sail through a test written against the default.
 *
 * The castle is the other half. Queenside from d1 lands the king on c1 — where an ordinary one-square
 * step also lands — so `d1a1` and `d1c1` are two different legal moves that a client resolving by
 * king destination could not tell apart (ADR-0136 §4, ADR-0137).
 *
 * The realtime-gateway is a test-only devDependency; ADR-0003's no-core-in-web guardrail governs the
 * production bundle, not tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from '../src/net/ws-client.js';
import { GameSync } from '../src/net/game-sync.js';
import { AuthoritativeMoveOracle } from '../src/net/authoritative-oracle.js';
import { BoardInteraction } from '../src/core/interaction.js';
import { FakeSocketFactory, ManualScheduler } from './support/fake-socket.js';

import {
  GameAuthority,
  InMemoryPubSub,
  encode,
  type ServerMessage,
  type Broadcast,
} from '@chess-platform/realtime-gateway';

const TC = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' as const };

const SP700 = 700;
const SP700_FEN = 'rbqknnbr/pppppppp/8/8/8/8/PPPPPPPP/RBQKNNBR w KQkq - 0 1';

/** White's back rank as eight characters, file a first, `.` for empty. FEN run-length-encodes. */
function whiteBackRank(fen: string): string {
  const rank = fen.split(' ')[0]!.split('/')[7]!;
  return [...rank].map((c) => (/\d/.test(c) ? '.'.repeat(Number(c)) : c)).join('');
}

async function createChess960Authority() {
  const pubsub = new InMemoryPubSub();
  let clock = 1_000;
  const now = () => (clock += 10);
  const authority = new GameAuthority(pubsub, now);
  await authority.createGame({
    gameId: 'g960',
    variant: 'chess960',
    chess960StartId: SP700,
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: false,
  });
  return { authority, pubsub };
}

function setupClient(token: string) {
  const factory = new FakeSocketFactory();
  const scheduler = new ManualScheduler();
  const client = new WsClient({
    url: 'wss://example.test/ws',
    factory: factory.factory,
    scheduler,
    now: () => 0,
    rng: () => 0,
    heartbeatMs: 0,
    reconnect: { baseDelayMs: 10, maxDelayMs: 10, jitter: 'none' },
  });
  const sync = new GameSync(client, { gameId: 'g960', token });
  return { factory, scheduler, client, sync };
}

const flush = () => new Promise((r) => setImmediate(r));

test('e2e chess960: the server-chosen arrangement reaches the client and is played on', async () => {
  const { authority, pubsub } = await createChess960Authority();
  const { factory, sync } = setupClient('token-alice');

  const oracle = new AuthoritativeMoveOracle({ getLegalMoves: () => sync.getState().legalMoves });
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  pubsub.subscribe('game:g960', (msg: Broadcast) => {
    factory.last.emit(JSON.parse(encode(msg as ServerMessage)));
  });

  sync.start();
  factory.last.open();

  const initialState = authority.getState('g960');
  factory.last.emit({ t: 'joined', gameId: 'g960', role: 'white', state: initialState });

  // The board the client was handed is the one the server chose — not standard chess.
  assert.equal(sync.getState().snapshot!.fen, SP700_FEN);
  assert.equal(sync.getState().snapshot!.variant, 'chess960');
  assert.equal(sync.getState().snapshot!.chess960StartId, SP700);
  assert.equal(whiteBackRank(SP700_FEN), 'RBQKNNBR', 'king on d1, rooks on a1 and h1');

  interaction.setPosition(sync.getState().snapshot!.fen);
  interaction.setTurn(true);

  // Clear the queenside path: c-pawn, queen up the c-file, bishop off b1. Each move is resolved by
  // the client from the authority's own legal-move map, then applied on the authority.
  const opening: readonly (readonly [string, string, 'alice' | 'bob'])[] = [
    ['c2', 'c4', 'alice'], ['h7', 'h6', 'bob'],
    ['c1', 'c3', 'alice'], ['g7', 'g6', 'bob'],
    ['b1', 'c2', 'alice'], ['a7', 'a6', 'bob'],
  ];

  for (const [from, to, who] of opening) {
    if (who === 'alice') {
      interaction.setPosition(authority.getState('g960').fen);
      interaction.setTurn(true);
      interaction.tap(from);
      const r = interaction.tap(to);
      assert.equal(r.kind, 'move', `${from}${to} should resolve as a move`);
    }
    await authority.apply('g960', who, { kind: 'move', uci: `${from}${to}` });
    await flush();
  }

  // --- The castle ---
  interaction.setPosition(authority.getState('g960').fen);
  interaction.setTurn(true);

  const kingDests = oracle.destinations('d1');
  assert.ok(
    kingDests.includes('a1'),
    `the server offers the rook square as the castling destination, got ${JSON.stringify(kingDests)}`,
  );
  assert.ok(kingDests.includes('c1'), 'and the ordinary king step is offered alongside it');

  interaction.tap('d1');
  const castle = interaction.tap('a1');
  assert.equal(castle.kind, 'move');
  if (castle.kind !== 'move') throw new Error('unreachable');
  assert.deepEqual(
    castle.move,
    { from: 'd1', to: 'a1' },
    'the client submits king-takes-rook, not the king destination',
  );

  const uci = `${castle.move.from}${castle.move.to}`;
  assert.ok(sync.submitMove(uci), 'the move is accepted for submission');
  await authority.apply('g960', 'alice', { kind: 'move', uci });
  await flush();

  // The server played the castle, not a one-square king step.
  const after = authority.getState('g960');
  assert.equal(
    whiteBackRank(after.fen),
    '..KRNNBR',
    'king on c1 and rook on d1: the rook moved, so this was a castle',
  );
  assert.equal(after.ply, 7);

  sync.stop();
});

test('e2e chess960: a reconnect resumes the same game, same arrangement', async () => {
  const { authority, pubsub } = await createChess960Authority();
  const { factory, scheduler, sync } = setupClient('token-alice');

  let deliverToClient = true;
  pubsub.subscribe('game:g960', (msg: Broadcast) => {
    if (!deliverToClient) return;
    factory.last.emit(JSON.parse(encode(msg as ServerMessage)));
  });

  sync.start();
  factory.last.open();
  factory.last.emit({ t: 'joined', gameId: 'g960', role: 'white', state: authority.getState('g960') });
  assert.equal(sync.getState().snapshot!.chess960StartId, SP700);

  sync.submitMove('e2e4');
  await authority.apply('g960', 'alice', { kind: 'move', uci: 'e2e4' });
  await flush();

  // Drop the socket; Bob moves while the client is offline.
  factory.last.serverClose(1006, '', false);
  deliverToClient = false;
  scheduler.runNext();
  await authority.apply('g960', 'bob', { kind: 'move', uci: 'e7e5' });
  await flush();

  factory.last.open();
  deliverToClient = true;
  factory.last.emit({ t: 'joined', gameId: 'g960', role: 'white', state: authority.getState('g960') });
  assert.deepEqual(JSON.parse(factory.last.sent[1]!), { t: 'resume', gameId: 'g960', lastPly: 1 });

  factory.last.emit({
    t: 'resumed', gameId: 'g960',
    state: authority.getState('g960'),
    missed: authority.getMissedSince('g960', 1),
  });

  const snapshot = sync.getState().snapshot!;
  assert.equal(snapshot.chess960StartId, SP700, 'the same arrangement came back');
  assert.equal(snapshot.variant, 'chess960');
  assert.notEqual(snapshot.fen, SP700_FEN, 'and the board is where the game actually got to');
  assert.ok(Object.keys(sync.getState().legalMoves).length > 0, 'play can continue');

  sync.stop();
});

test('e2e chess960: the game rebuilds from its durable log after eviction', async () => {
  // The process-restart case. `evict` drops the hot copy; the next access rehydrates from the event
  // log alone — which is where the whole contract has to hold, because it is the only thing that
  // survives a restart.
  const { authority } = await createChess960Authority();

  await authority.apply('g960', 'alice', { kind: 'move', uci: 'e2e4' });
  const before = authority.getState('g960');

  authority.evict('g960');
  assert.equal(authority.has('g960'), false, 'the hot copy is gone');

  assert.equal(await authority.ensureLoaded('g960'), true);
  const after = authority.getState('g960');

  assert.equal(after.chess960StartId, SP700, 'rebuilt from the log with the arrangement intact');
  assert.equal(after.fen, before.fen, 'and at exactly the position it was at');
  assert.equal(after.variant, 'chess960');
});
