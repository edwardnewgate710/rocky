/**
 * The Three-Check FEN codec: what it emits, what it accepts, and where the clocks are.
 *
 * Internally the counters are checks **delivered**, counting up; the FEN carries checks
 * **remaining**, counting down from three, in field five. Getting that inversion or that position
 * wrong is not a cosmetic error — the field sits between the en-passant square and the halfmove
 * clock, so a parser that reads it as a clock shifts both clocks by one and silently rewrites the
 * fifty-move state. That is why the clock assertions here are as prominent as the counter ones.
 *
 * The canonical form is the one Fairy-Stockfish 14 emits. See ADR-0120.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFen, toFen, FenError } from '../src/fen';
import { THREE_CHECK_LIMIT, deliveredFromRemaining, remainingFromDelivered } from '../src/check-counters';
import { Position } from '../src/position';
import type { Variant } from '../src/types';

const BOARD = '4k3/8/8/8/8/8/8/3R3K';

/** Every rule set the platform supports. */
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

/** Delivered counts a real game can reach, including the boundary where the game is already won. */
const DELIVERED_CASES: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 1],
  [3, 0],
  [0, 3],
];

test('the conversion between delivered and remaining is exact in both directions', () => {
  for (const [w, b] of DELIVERED_CASES) {
    const remaining = remainingFromDelivered({ w, b });
    assert.deepEqual(remaining, { w: THREE_CHECK_LIMIT - w, b: THREE_CHECK_LIMIT - b });
    assert.deepEqual(deliveredFromRemaining(remaining), { w, b }, 'the round trip must be lossless');
  }
});

test('a Three-Check position serialises its counters as remaining, in field five', () => {
  const state = parseFen(`${BOARD} w - - 0 1`, 'threecheck');
  state.checkCount = { w: 1, b: 2 };

  const fields = toFen(state).split(' ');
  assert.equal(fields.length, 7, 'canonical Three-Check FEN has seven fields');
  assert.equal(fields[4], '2+1', 'remaining, White first: 3-1 and 3-2');
  assert.equal(fields[5], '0', 'the halfmove clock stays the halfmove clock');
  assert.equal(fields[6], '1', 'and the fullmove counter stays the fullmove counter');
});

test('every delivered pair survives a serialise/parse round trip', () => {
  for (const [w, b] of DELIVERED_CASES) {
    const state = parseFen(`${BOARD} w - - 17 42`, 'threecheck');
    state.checkCount = { w, b };

    const back = parseFen(toFen(state), 'threecheck');
    assert.deepEqual(back.checkCount, { w, b }, `delivered ${w}+${b} must survive`);
    assert.equal(back.halfmoves, 17, 'the halfmove clock must survive with it');
    assert.equal(back.fullmoves, 42, 'and the fullmove counter');
  }
});

test('all three accepted spellings agree, and canonicalise on output', () => {
  // Legacy six-field, canonical remaining, and trailing delivered — the same position each time.
  const legacy = parseFen(`${BOARD} w - - 17 42`, 'threecheck');
  const canonical = parseFen(`${BOARD} w - - 2+3 17 42`, 'threecheck');
  const trailing = parseFen(`${BOARD} w - - 17 42 +1+0`, 'threecheck');

  assert.deepEqual(legacy.checkCount, { w: 0, b: 0 }, 'no counters means none delivered');
  assert.deepEqual(canonical.checkCount, { w: 1, b: 0 }, '2 remaining is 1 delivered');
  assert.deepEqual(trailing.checkCount, { w: 1, b: 0 }, 'the trailing form is already delivered');

  assert.deepEqual(canonical.checkCount, trailing.checkCount, 'the two spellings mean the same');
  assert.equal(
    toFen(canonical),
    toFen(trailing),
    'input spelling must not survive into output — one canonical form leaves the codec',
  );
  assert.equal(toFen(trailing), `${BOARD} w - - 2+3 17 42`);
});

test('the clocks are read from the right place in every accepted spelling', () => {
  for (const fen of [
    `${BOARD} w - - 17 42`,
    `${BOARD} w - - 2+3 17 42`,
    `${BOARD} w - - 17 42 +1+0`,
  ]) {
    const state = parseFen(fen, 'threecheck');
    assert.equal(state.halfmoves, 17, `halfmove clock misread from "${fen}"`);
    assert.equal(state.fullmoves, 42, `fullmove counter misread from "${fen}"`);
  }
});

test('a malformed or out-of-range counter field is refused, not reinterpreted', () => {
  const bad = [
    `${BOARD} w - - 4+3 0 1`, // beyond the limit
    `${BOARD} w - - 3+9 0 1`, // beyond the limit, other side
    `${BOARD} w - - 2+ 0 1`, // truncated
    `${BOARD} w - - +2 0 1`, // half a delivered form
    `${BOARD} w - - 0 1 +9+0`, // trailing form beyond the limit
  ];
  for (const fen of bad) {
    assert.throws(
      () => parseFen(fen, 'threecheck'),
      FenError,
      `"${fen}" must be refused rather than read as a clock`,
    );
  }
});

test('a counter field that is misplaced or surplus is refused, not dropped', () => {
  // An earlier version recognised the trailing form only on an exact `+N+M` and let everything else
  // fall through to the legacy reading — so `+2+` and a stray field after a valid counter were
  // silently discarded and the position came back out as `3+3`, two checks lighter than it went in.
  // Raised in the Qodo and CodeRabbit reviews of PR #140.
  const bad = [
    `${BOARD} w - - 0 1 +2+0 7`, // a counter, then a surplus field
    `${BOARD} w - - 0 1 +2+`, // truncated trailing counter
    `${BOARD} w - - 17 42 +2`, // half a trailing counter
    `${BOARD} w - - 0 1 2+0`, // the canonical spelling in the trailing position
    `${BOARD} w - - 2+3 17 42 9`, // a surplus field after a valid canonical counter
    `${BOARD} w - - 17 42 9 +2+0`, // a surplus field *before* an otherwise valid trailing counter
    `${BOARD} w - - 2+ 1`, // six fields, with a malformed counter where the halfmove clock belongs
    `${BOARD} w - - 2+3 17 +1+0`, // both spellings at once, which is a contradiction not a spelling
    `${BOARD} w - - +1+0 17 42`, // the trailing spelling in the canonical position
    `${BOARD} w - - 2+3 17`, // canonical layout announced, then cut short of its fullmove
    `${BOARD} w - - 2+3`, // canonical layout announced, then no clocks at all
  ];
  for (const fen of bad) {
    assert.throws(
      () => parseFen(fen, 'threecheck'),
      FenError,
      `"${fen}" must be refused rather than quietly read as a fresh position`,
    );
  }
});

test('a move clock too large to represent exactly is refused rather than rounded', () => {
  // `Number('9007199254740993')` is `9007199254740992`, so the value changed as it was read and the
  // FEN coming back out described a different position. The bound applies to every variant, since
  // the clock reader is shared and the defect predates the counters. Raised in the Qodo review of
  // PR #140.
  assert.throws(() => parseFen(`${BOARD} w - - 3+3 9007199254740993 1`, 'threecheck'), FenError);
  assert.throws(
    () => parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 9007199254740993 1'),
    FenError,
    'standard chess reads its clocks through the same code and had the same defect',
  );

  // The bound is only that: ordinary clocks, and the long-standing tolerance for a non-numeric
  // token, both stay exactly as they were.
  const ordinary = parseFen(`${BOARD} w - - 2+3 17 42`, 'threecheck');
  assert.equal(ordinary.halfmoves, 17);
  assert.equal(ordinary.fullmoves, 42);
  assert.equal(toFen(ordinary), `${BOARD} w - - 2+3 17 42`, 'and still round-trips exactly');

  const junk = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - - -');
  assert.equal(junk.halfmoves, 0, 'a non-numeric clock still falls back rather than throwing');
  assert.equal(junk.fullmoves, 1);
});

test('a truncated FEN without a counter keeps the tolerance every variant has', () => {
  // The strictness above is about a FEN that *announces* the canonical layout and then stops short.
  // A six-field Three-Check FEN never announced it, so it keeps the same tolerance a five-field
  // standard FEN has always had — and the two must stay in step, or Three-Check becomes stricter
  // than standard for reasons that have nothing to do with the counters.
  const threecheck = parseFen(`${BOARD} w - - 17`, 'threecheck');
  const standard = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 17');

  assert.equal(threecheck.halfmoves, 17);
  assert.equal(threecheck.fullmoves, 1, 'the absent fullmove takes its default');
  assert.deepEqual(threecheck.checkCount, { w: 0, b: 0 }, 'and no counter means none delivered');
  assert.equal(standard.halfmoves, threecheck.halfmoves, 'standard behaves identically');
  assert.equal(standard.fullmoves, threecheck.fullmoves);
});

test('a Three-Check FEN read without its variant is refused, not silently re-read', () => {
  // The counter sits where the halfmove clock belongs, so reading one under another rule set is
  // worse than useless: `... 2+3 17 42` parsed as standard gave halfmove 0 and fullmove 17 — both
  // clocks wrong, the counters gone, and nothing said so.
  //
  // Reachable because this codec now *emits* seven-field FENs: a transport can preserve the FEN
  // while dropping the separate variant. Raised in the CodeRabbit review of PR #140.
  assert.throws(() => parseFen(`${BOARD} w - - 2+3 17 42`), FenError, 'canonical form, no variant');
  assert.throws(() => parseFen(`${BOARD} w - - 17 42 +1+0`), FenError, 'trailing form, no variant');

  // Six fields, so the counter is the only thing wrong with it: no field-count rule can be what
  // refuses this one. Without it the cases above prove refusal but not *why* — a future
  // "too many fields" check under non-Three-Check variants would keep them green while the
  // counter guard itself rotted. Raised in the CodeRabbit review of PR #140.
  assert.throws(
    () => parseFen(`${BOARD} w - - 2+3 17`),
    FenError,
    'a counter in field five is refused on its own, with no surplus field to blame',
  );
  assert.throws(
    () => parseFen(`${BOARD} w - - 2+3 17 42`, 'crazyhouse'),
    FenError,
    'and under any other variant, not only the default',
  );

  // Everything that does not carry counters is untouched, for every variant.
  for (const variant of ALL_VARIANTS) {
    const initial = Position.initial(variant);
    assert.equal(parseFen(initial.fen(), variant).variant, variant, `${variant} still round-trips`);
  }
  const standard = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 17 42');
  assert.equal(standard.halfmoves, 17);
  assert.equal(standard.fullmoves, 42);
});

test('the counter field belongs to Three-Check alone', () => {
  const others: readonly Variant[] = [
    'standard',
    'chess960',
    'kingofthehill',
    'atomic',
    'crazyhouse',
    'horde',
    'racingkings',
  ];
  for (const variant of others) {
    const fields = Position.initial(variant).fen().split(' ');
    assert.equal(fields.length, 6, `${variant} must keep the standard six fields`);
    assert.equal(fields[4], '0', `${variant}: field five is still the halfmove clock`);
  }

  const threecheck = Position.initial('threecheck').fen().split(' ');
  assert.equal(threecheck.length, 7);
  assert.equal(threecheck[4], '3+3', 'a fresh Three-Check game has three checks left each');
});

test('playing checks moves the emitted counters down, one side at a time', () => {
  let pos = Position.fromFen(`${BOARD} w - - 3+3 0 1`, 'threecheck');
  assert.match(pos.fen(), / 3\+3 /);

  pos = pos.play('d1e1'); // Re1+
  assert.match(pos.fen(), / 2\+3 /, "White's remaining count falls on White's check");

  pos = pos.play('e8f8').play('e1d1').play('f8e8').play('d1e1'); // and again
  assert.match(pos.fen(), / 1\+3 /, 'Black is untouched throughout');
});
