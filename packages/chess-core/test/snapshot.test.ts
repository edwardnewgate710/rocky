/**
 * `Position.snapshot()` must hand back the whole position, and hand back a copy.
 *
 * It used to be `parseFen(this.fen(), variant)`. FEN is the six standard fields, and the
 * Three-Check counters are not among them, so every snapshot silently reset them to zero. The
 * damage was not confined to anything reading `checkCount` directly: `repetitionKey` folds the
 * counters into the key for `threecheck` and is built from this snapshot, so three-check positions
 * compared equal on counters that were always zero (see `../src/repetition.ts` and ADR-0099 §4).
 *
 * These tests pin the two properties that failure violated — completeness and isolation — rather
 * than the one field that happened to be missing, because the next field added to `PositionState`
 * will be dropped the same way if only `checkCount` is checked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';
import type { PositionState, Variant } from '../src/types';

/** Every field `PositionState` declares. A field added without being cloned fails test 2. */
const POSITION_STATE_FIELDS = [
  'board',
  'castling',
  'checkCount',
  'epSquare',
  'fullmoves',
  'halfmoves',
  'pockets',
  'turn',
  'variant',
] as const;

const ALL_VARIANTS: readonly Variant[] = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
];

/** A rook that can check along the e-file, and a king that can step aside and back. */
const CHECK_SHUFFLE_FEN = '4k3/8/8/8/8/8/8/3R3K w - - 0 1';

function play(pos: Position, ucis: readonly string[]): Position {
  let cur = pos;
  for (const uci of ucis) cur = cur.play(uci);
  return cur;
}

test('a snapshot keeps the Three-Check counters the position actually holds', () => {
  const start = Position.fromFen(CHECK_SHUFFLE_FEN, 'threecheck');

  assert.deepEqual(
    start.snapshot().checkCount,
    { w: 0, b: 0 },
    'nothing has been delivered yet',
  );

  // Re1+ is a real check, produced by playing a legal move rather than by writing the counter.
  const afterWhiteCheck = start.play('d1e1');
  assert.deepEqual(
    afterWhiteCheck.snapshot().checkCount,
    { w: 1, b: 0 },
    'the check White just delivered must survive the snapshot',
  );

  // Black's rook answers with a check of its own, so both counters are non-zero independently.
  const both = play(Position.fromFen('r3k3/8/8/8/8/8/8/4K2R w - - 0 1', 'threecheck'), [
    'h1h8', // Rh8+ along the eighth rank
    'e8e7', // Ke7 steps off it
    'h8h5', // the rook leaves the first rank clear
    'a8a1', // Ra1+ , Black checks the white king on e1
  ]);
  assert.deepEqual(
    both.snapshot().checkCount,
    { w: 1, b: 1 },
    'each side keeps its own delivered-check count',
  );
});

test('a snapshot carries every field of the position state, not just the ones FEN can spell', () => {
  // Crazyhouse, because it is the variant whose state is richest: a capture fills a pocket, and a
  // double push sets an en-passant square, so several fields are simultaneously non-default.
  const pos = play(Position.initial('crazyhouse'), [
    'e2e4',
    'd7d5',
    'e4d5', // White captures, so White's pocket holds a pawn
    'd8d5', // Black recaptures, so Black's pocket holds a pawn
    'b1c3', // develops, and attacks the queen
    'd5a5', // queen steps away; halfmove clock is running
    'g1f3',
    'e7e5', // a double push, which sets a real en-passant target
  ]);

  const snap = pos.snapshot();

  assert.deepEqual(
    Object.keys(snap).sort(),
    [...POSITION_STATE_FIELDS],
    'a field added to PositionState must be cloned too, or it is dropped on every snapshot',
  );

  // The state really is non-default in the places that matter, so the comparison below has teeth.
  assert.equal(snap.turn, 'w');
  assert.notEqual(snap.epSquare, -1, 'the double push must leave an en-passant square');
  assert.ok(snap.fullmoves > 1);
  assert.ok(snap.pockets.w.length > 0 && snap.pockets.b.length > 0, 'both pockets hold a capture');
  assert.equal(snap.variant, 'crazyhouse');

  // Two snapshots of the same position must agree in full — including the board array, the pockets
  // and the counters, which a shallow or FEN-mediated copy would not reproduce.
  assert.deepEqual(snap, pos.snapshot());
});

test('a snapshot is detached: mutating it cannot reach back into the position', () => {
  const pos = play(Position.initial('crazyhouse'), ['e2e4', 'd7d5', 'e4d5']);
  const before = pos.snapshot();
  const fenBefore = pos.fen();

  const scribble = pos.snapshot();
  scribble.board[0] = 'q';
  scribble.pockets.w.push('r');
  scribble.pockets.b.push('n');
  scribble.checkCount.w = 3;
  scribble.checkCount.b = 3;
  scribble.turn = 'b';
  scribble.epSquare = 0;
  scribble.halfmoves = 99;

  assert.deepEqual(
    pos.snapshot(),
    before,
    'the position must be unchanged after its snapshot was written all over',
  );
  assert.equal(pos.fen(), fenBefore);
});

test('the Three-Check counters are detached too, so a caller cannot rewrite history', () => {
  const pos = Position.fromFen(CHECK_SHUFFLE_FEN, 'threecheck').play('d1e1');
  const snap = pos.snapshot();
  snap.checkCount.w = 3;

  assert.deepEqual(
    pos.snapshot().checkCount,
    { w: 1, b: 0 },
    'a shared counter object would let a caller hand the game to White',
  );
});

test('every supported variant survives a snapshot with its own state intact', () => {
  for (const variant of ALL_VARIANTS) {
    const pos = Position.initial(variant);
    const snap: PositionState = pos.snapshot();

    assert.equal(snap.variant, variant, `${variant}: the variant itself must be carried`);
    assert.deepEqual(
      Object.keys(snap).sort(),
      [...POSITION_STATE_FIELDS],
      `${variant}: every field must be present`,
    );
    assert.deepEqual(snap, pos.snapshot(), `${variant}: snapshots must be reproducible`);
    assert.ok(Array.isArray(snap.pockets.w) && Array.isArray(snap.pockets.b));
    assert.deepEqual(snap.checkCount, { w: 0, b: 0 }, `${variant}: a fresh position has no checks`);

    // The board must be a copy per snapshot, in every variant, not a shared reference.
    const first = pos.snapshot();
    first.board[0] = null;
    assert.notDeepEqual(first.board, pos.snapshot().board, `${variant}: board must be copied`);
  }
});
