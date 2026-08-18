/**
 * Three-Check repetition: a repeat of the board is not a repeat of the position.
 *
 * `repetitionKey` has always folded the delivered-check counters into the key for `threecheck`,
 * because a player wins on the third check and two boards that look alike are different games if
 * one side is two checks closer to winning. But the key is built from `Position.snapshot()`, and
 * that used to round-trip through FEN, which cannot spell the counters — so every three-check
 * position reported `0+0` and the counters could never tell two keys apart.
 *
 * The result was not a lost annotation, it was a lost game: the sequence below repeated the board
 * three times while White delivered two checks, and was declared a threefold draw with White one
 * check from winning. ADR-0099 §4 recorded the snapshot loss as latent on the grounds that the key
 * used only the first four FEN fields; it did not, and this is the game that proves it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '@chess-platform/core';
import { Game, repetitionKey } from '../src/game';
import type { GameEvent } from '../src/events';

/** White's rook checks along the e-file and retreats; Black's king steps aside and back. */
const SHUFFLE_FEN = '4k3/8/8/8/8/8/8/3R3K w - - 0 1';
/** Two full shuffles: the board returns to its start twice, with a check delivered each time. */
const TWO_SHUFFLES = ['d1e1', 'e8f8', 'e1d1', 'f8e8', 'd1e1', 'e8f8', 'e1d1', 'f8e8'];

const TIME_CONTROL = {
  initialMs: 600_000,
  incrementMs: 0,
  delayMs: 0,
  kind: 'increment',
} as const;

function newGame(variant: 'threecheck' | 'standard', initialFen?: string) {
  return Game.create({
    gameId: `test-${variant}`,
    variant,
    ...(initialFen === undefined ? {} : { initialFen }),
    timeControl: TIME_CONTROL,
    players: { white: 'white', black: 'black' },
    at: 0,
  });
}

/** Play `ucis`, stopping early if the game ends. Returns the game and its full event history. */
function playAll(ucis: readonly string[], variant: 'threecheck' | 'standard', initialFen?: string) {
  const created = newGame(variant, initialFen);
  let game = created.game;
  const events: GameEvent[] = [...created.events];
  let at = 1_000;
  for (const uci of ucis) {
    const result = game.playMove(uci, at);
    game = result.game;
    events.push(...result.events);
    at += 1_000;
    if (result.events.some((event) => event.type === 'GameEnded')) break;
  }
  return { game, events };
}

test('the same board with different delivered-check counts is a different position', () => {
  let pos = Position.fromFen(SHUFFLE_FEN, 'threecheck');
  const keys = [repetitionKey(pos.snapshot())];
  for (const uci of TWO_SHUFFLES) {
    pos = pos.play(uci);
    keys.push(repetitionKey(pos.snapshot()));
  }

  // The starting layout occurs three times across the line, once per completed shuffle.
  const layout = keys.filter((key) => key.startsWith('4k3/8/8/8/8/8/8/3R3K w'));
  assert.equal(layout.length, 3, 'the line must return to the same board three times');
  assert.equal(
    new Set(layout).size,
    3,
    'the three occurrences differ by delivered checks and must not share a key',
  );
  assert.deepEqual(layout, [
    '4k3/8/8/8/8/8/8/3R3K w - - 0+0',
    '4k3/8/8/8/8/8/8/3R3K w - - 1+0',
    '4k3/8/8/8/8/8/8/3R3K w - - 2+0',
  ]);
});

test('the same board with the same delivered-check counts is still the same position', () => {
  // Guards the other direction: the counters must discriminate, not simply make every key unique.
  const a = Position.fromFen(SHUFFLE_FEN, 'threecheck');
  const b = Position.fromFen(SHUFFLE_FEN, 'threecheck');
  assert.equal(repetitionKey(a.snapshot()), repetitionKey(b.snapshot()));

  const afterCheckA = Position.fromFen(SHUFFLE_FEN, 'threecheck').play('d1e1');
  const afterCheckB = Position.fromFen(SHUFFLE_FEN, 'threecheck').play('d1e1');
  assert.equal(
    repetitionKey(afterCheckA.snapshot()),
    repetitionKey(afterCheckB.snapshot()),
    'identical boards with identical counters must still collide, or repetition never fires',
  );
});

test('a three-check game is not drawn by repetition while the check counts are climbing', () => {
  const { game } = playAll(TWO_SHUFFLES, 'threecheck', SHUFFLE_FEN);
  const state = game.snapshot();

  assert.equal(
    state.moves.length,
    TWO_SHUFFLES.length,
    'the game must run the whole line instead of ending part-way',
  );
  assert.deepEqual(
    state.status,
    { over: false },
    'this was declared a threefold draw before the snapshot carried the counters',
  );
  assert.deepEqual(
    state.position.snapshot().checkCount,
    { w: 2, b: 0 },
    'two checks have been delivered, which is exactly why it is not a repetition',
  );
});

test('the game that used to be drawn is won on the third check', () => {
  // The point of the variant, and the outcome the false draw was taking away.
  const { game } = playAll([...TWO_SHUFFLES, 'd1e1'], 'threecheck', SHUFFLE_FEN);
  const state = game.snapshot();

  assert.deepEqual(state.status, {
    over: true,
    result: '1-0',
    termination: 'variant',
    winner: 'w',
  });
  assert.deepEqual(state.position.snapshot().checkCount, { w: 3, b: 0 });
});

test('a genuine repetition still draws a three-check game when no check intervenes', () => {
  // Without this the fix could "work" by making threefold unreachable in the variant entirely.
  const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  const { game } = playAll(shuffle, 'threecheck');
  const state = game.snapshot();

  assert.ok(state.status.over, 'a knight shuffle with no checks is a real repetition');
  assert.equal(state.status.over && state.status.termination, 'threefold');
  assert.deepEqual(
    state.position.snapshot().checkCount,
    { w: 0, b: 0 },
    'no check was delivered, so the counters never separated the occurrences',
  );
});

test('replaying a three-check history reproduces the live game exactly', () => {
  // Live play and the reducer both build repetition keys from `position.snapshot()`, so a lossy
  // snapshot corrupted them together. They must agree on the counters and on the outcome.
  const { game, events } = playAll([...TWO_SHUFFLES, 'd1e1'], 'threecheck', SHUFFLE_FEN);
  const replayed = Game.fromEvents(events);

  const live = game.snapshot();
  const back = replayed.snapshot();

  assert.deepEqual(back.status, live.status, 'replay must reach the same result');
  assert.deepEqual(
    back.position.snapshot().checkCount,
    live.position.snapshot().checkCount,
    'replay must reach the same delivered-check counts',
  );
  assert.equal(back.position.fen(), live.position.fen());
  assert.deepEqual(
    [...back.repetition.entries()].sort(),
    [...live.repetition.entries()].sort(),
    'replay must build the same repetition identities',
  );
});
