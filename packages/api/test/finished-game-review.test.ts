import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { DurableFinishedGameReviewArchive } from '../src/game-review/finished-game-review.js';

test('finished-game review captures each pre-move position during one forward replay', async () => {
  const gameId = '00000000-0000-4000-8000-000000000099';
  const store = new InMemoryEventStore(() => 1_000);
  const created = Game.create({
    gameId,
    players: { white: 'white-player', black: 'black-player' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'increment' },
    at: 1_000,
  });
  let game = created.game;
  let head = await store.append(gameId, -1, created.events);
  const expectedFens: string[] = [];

  for (const [uci, at] of [['e2e4', 2_000], ['e7e5', 3_000], ['g1f3', 4_000]] as const) {
    expectedFens.push(game.fen);
    const played = game.playMove(uci, at);
    game = played.game;
    head = await store.append(gameId, head, played.events);
  }
  const resigned = game.resign('b', 5_000);
  await store.append(gameId, head, resigned.events);

  const reviewed = await new DurableFinishedGameReviewArchive(store).finishedGameForReview(gameId);

  assert.ok(reviewed);
  assert.deepEqual(reviewed.moves.map((move) => move.fenBefore), expectedFens);
  assert.deepEqual(reviewed.moves.map((move) => move.uci), ['e2e4', 'e7e5', 'g1f3']);
});

test('finished-game review returns no archive record while the authoritative game is live', async () => {
  const gameId = '00000000-0000-4000-8000-000000000088';
  const store = new InMemoryEventStore(() => 1_000);
  const created = Game.create({
    gameId,
    players: { white: 'white-player', black: 'black-player' },
    timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'increment' },
    at: 1_000,
  });
  const head = await store.append(gameId, -1, created.events);
  const played = created.game.playMove('e2e4', 2_000);
  await store.append(gameId, head, played.events);

  const reviewed = await new DurableFinishedGameReviewArchive(store).finishedGameForReview(gameId);

  assert.equal(reviewed, undefined);
});
