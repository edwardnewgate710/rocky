import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, repetitionKey } from '../src/game';
import type { GameEvent } from '../src/events';
import type { TimeControl } from '../src/clock';

const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

function newGame() {
  return Game.create({
    gameId: 'g1',
    timeControl: TC,
    players: { white: 'alice', black: 'bob' },
    rated: true,
    at: 0,
  });
}

test('a fresh game is ongoing with White to move', () => {
  const { game } = newGame();
  assert.equal(game.status.over, false);
  assert.equal(game.turn, 'w');
});

test('playing moves advances the game and records SAN', () => {
  let { game } = newGame();
  let t = 1_000;
  for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
    ({ game } = game.playMove(uci, (t += 2_000)));
  }
  const snap = game.snapshot();
  assert.equal(snap.ply, 3);
  assert.deepEqual(snap.moves.map((m) => m.san), ['e4', 'e5', 'Nf3']);
  assert.equal(game.turn, 'b');
});

test('scholar\'s mate ends the game as checkmate 1-0', () => {
  let { game } = newGame();
  let t = 0;
  const line = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  let allEvents: GameEvent[] = [];
  for (const uci of line) {
    const res = game.playMove(uci, (t += 1_000));
    game = res.game;
    allEvents = allEvents.concat(res.events);
  }
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'checkmate');
    assert.equal(game.status.result, '1-0');
  }
  // A GameEnded event was emitted alongside the final move.
  assert.ok(allEvents.some((e) => e.type === 'GameEnded'));
});

test('event sourcing: a game reconstructs exactly from its event log', () => {
  let { game, events } = newGame();
  const log: GameEvent[] = [...events];
  let t = 0;
  for (const uci of ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3']) {
    const res = game.playMove(uci, (t += 4_000));
    game = res.game;
    log.push(...res.events);
  }
  const rebuilt = Game.fromEvents(log);
  assert.equal(rebuilt.fen, game.fen);
  assert.equal(rebuilt.snapshot().ply, game.snapshot().ply);
  assert.deepEqual(rebuilt.snapshot().clock.remaining, game.snapshot().clock.remaining);
  assert.deepEqual(
    rebuilt.snapshot().moves.map((m) => m.san),
    game.snapshot().moves.map((m) => m.san),
  );
});

test('resignation ends the game for the opponent', () => {
  let { game } = newGame();
  ({ game } = game.playMove('e2e4', 1_000));
  ({ game } = game.resign('b', 2_000));
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.result, '1-0');
    assert.equal(game.status.termination, 'resignation');
    assert.equal(game.status.winner, 'w');
  }
});

test('draw offer then accept ends in agreement', () => {
  let { game } = newGame();
  ({ game } = game.playMove('e2e4', 1_000));
  ({ game } = game.offerDraw('w', 1_500));
  ({ game } = game.acceptDraw('b', 2_000));
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.result, '1/2-1/2');
    assert.equal(game.status.termination, 'agreement');
  }
});

test('cannot accept your own draw offer', () => {
  let { game } = newGame();
  ({ game } = game.offerDraw('w', 1_000));
  assert.throws(() => game.acceptDraw('w', 2_000), /No draw offer/);
});

test('illegal move is rejected', () => {
  const { game } = newGame();
  assert.throws(() => game.playMove('e2e5', 1_000), /Illegal move|No legal move/);
});

test('flagging on the clock ends the game by timeout', () => {
  const short: TimeControl = { initialMs: 5_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };
  let { game } = Game.create({
    gameId: 'g2', timeControl: short, players: { white: 'a', black: 'b' }, at: 0,
  });
  ({ game } = game.playMove('e2e4', 1_000)); // white used 1s
  // Black tries to move 10s later -> flagged.
  const res = game.playMove('e7e5', 11_000);
  game = res.game;
  assert.equal(game.status.over, true);
  if (game.status.over) {
    assert.equal(game.status.termination, 'timeout');
    assert.equal(game.status.result, '1-0');
  }
});

test('abort is allowed early and forbidden after both move', () => {
  let { game } = newGame();
  ({ game } = game.playMove('e2e4', 1_000));
  ({ game } = game.playMove('e7e5', 2_000));
  assert.throws(() => game.abort(3_000), /no longer be aborted/);
});

test('scale: reconstruct many games from their logs quickly', () => {
  const N = 2_000;
  const line = ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6'];
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    let { game, events } = Game.create({
      gameId: `sim-${i}`, timeControl: TC, players: { white: 'x', black: 'y' }, at: 0,
    });
    const log: GameEvent[] = [...events];
    let t = 0;
    for (const uci of line) {
      const res = game.playMove(uci, (t += 1_000));
      game = res.game;
      log.push(...res.events);
    }
    const rebuilt = Game.fromEvents(log);
    assert.equal(rebuilt.fen, game.fen);
  }
  const ms = Date.now() - start;
  // Informational: ensures the aggregate is fast enough for high concurrency.
  console.log(`reconstructed ${N} games in ${ms}ms (${(ms / N).toFixed(3)}ms/game)`);
  assert.ok(ms < 20_000);
});

// ── Threefold repetition ───────────────────────────────────────────────────

test('M3 (acceptance): threefold repetition ends the game as a draw', () => {
  let { game } = newGame();
  let t = 1_000;
  // 1.Nf3 Nf6 2.Ng1 Ng8 3.Nf3 Nf6 4.Ng1 Ng8
  // After 4...Ng8 the starting position has appeared 3 times.
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const uci of moves) {
    const result = game.playMove(uci, (t += 2_000));
    game = result.game;
  }
  assert.equal(game.status.over, true, 'game should be over after threefold repetition');
  if (game.status.over) {
    assert.equal(game.status.termination, 'threefold');
    assert.equal(game.status.result, '1/2-1/2');
    assert.equal(game.status.winner, null);
  }
});

test('threefold: en-passant difference is NOT a repeat', () => {
  // The repetition key includes the en-passant square (FEN field 4).
  // After 1.e4 the position has EP square e3; after 1.e3 there is no EP square.
  // These produce different keys even though the piece placement is almost the same.
  const fenAfterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const fenAfterE3 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  assert.notEqual(
    repetitionKey(fenAfterE4),
    repetitionKey(fenAfterE3),
    'positions with different EP squares must have different repetition keys',
  );
});

test('threefold: castling-rights difference is NOT a repeat', () => {
  // If White plays Ra1-a2-a1, the Q-side castling right is lost.
  // The piece placement returns to the original, but castling rights differ.
  // Demonstrate via FENs: same placement, different castling.
  const fenWithCastling = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const fenWithoutQCastling = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1';
  assert.notEqual(
    repetitionKey(fenWithCastling),
    repetitionKey(fenWithoutQCastling),
    'positions with different castling rights must have different repetition keys',
  );
});

test('threefold: event-sourcing invariant — fromEvents reconstructs the same draw', () => {
  let { game, events } = newGame();
  const log: GameEvent[] = [...events];
  let t = 1_000;
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const uci of moves) {
    const res = game.playMove(uci, (t += 2_000));
    game = res.game;
    log.push(...res.events);
  }
  const rebuilt = Game.fromEvents(log);
  // The rebuilt game must have the same status (byte-identical object).
  assert.deepEqual(rebuilt.status, game.status);
  assert.equal(rebuilt.status.over, true);
  if (rebuilt.status.over) {
    assert.equal(rebuilt.status.termination, 'threefold');
    assert.equal(rebuilt.status.result, '1/2-1/2');
    assert.equal(rebuilt.status.winner, null);
  }
  // Repetition history must also match.
  assert.deepEqual(rebuilt.snapshot().repetition, game.snapshot().repetition);
});

test('threefold: a game that ends by threefold rejects further commands', () => {
  let { game } = newGame();
  let t = 1_000;
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const uci of moves) {
    ({ game } = game.playMove(uci, (t += 2_000)));
  }
  assert.equal(game.status.over, true);
  // Further moves are rejected.
  assert.throws(() => game.playMove('g1f3', (t += 2_000)), /already over/);
  // Resignation is rejected.
  assert.throws(() => game.resign('w', (t += 1_000)), /already over/);
  // Draw offer is rejected.
  assert.throws(() => game.offerDraw('w', (t += 1_000)), /already over/);
});
