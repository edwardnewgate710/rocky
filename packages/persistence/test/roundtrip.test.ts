import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '../src/event-store';
import { uuidv7 } from '../src/ids';

// Roadmap M4 acceptance: events produced by playing a game -> event store ->
// Game.fromEvents -> state identical to the live game.
test('play -> store -> load -> Game.fromEvents reproduces state exactly', async () => {
  const store = new InMemoryEventStore(() => 1000);
  const gameId = uuidv7();
  const timeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const };

  let { game, events } = Game.create({
    gameId,
    timeControl,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 1000,
  });
  let head = await store.append(gameId, -1, events);

  let t = 2000;
  for (const uci of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']) {
    ({ game, events } = game.playMove(uci, t));
    head = await store.append(gameId, head, events);
    t += 1000;
  }

  const stored = await store.load(gameId);
  const rebuilt = Game.fromEvents(stored.map((s) => s.event));

  const live = game.snapshot();
  const back = rebuilt.snapshot();
  assert.equal(back.position.fen(), live.position.fen());
  assert.equal(back.ply, live.ply);
  assert.deepEqual(back.clock.remaining, live.clock.remaining);
  assert.deepEqual(back.status, live.status);
  assert.deepEqual(back.moves.map((m) => m.san), live.moves.map((m) => m.san));
  assert.equal(head, stored.length - 1);
});
