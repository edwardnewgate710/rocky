/**
 * The 960 starting positions.
 *
 * These tests are exhaustive rather than sampled. The generator is a chain of four divisions and a
 * table lookup, and an off-by-one in any of them produces arrangements that are individually
 * plausible — right pieces, right count — while being the wrong 960. Checking a handful of ids
 * would pass against a generator that silently emitted the same position twice, or that never
 * emitted some legal arrangement at all. Both are caught only by enumerating the whole domain.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHESS960_POSITIONS,
  CHESS960_STANDARD_ID,
  chess960BackRank,
  chess960Fen,
} from '../src/chess960';
import { Position } from '../src/position';

const ALL_IDS = Array.from({ length: CHESS960_POSITIONS }, (_, id) => id);

/** Files b, d, f and h are the light squares of rank 1; a, c, e and g are the dark ones. */
const isLightFile = (file: number): boolean => file % 2 === 1;

const filesOf = (backRank: string, piece: string): number[] =>
  [...backRank].flatMap((ch, file) => (ch === piece ? [file] : []));

test('there are exactly 960 arrangements and no two are the same', () => {
  const seen = new Map<string, number>();
  for (const id of ALL_IDS) {
    const arrangement = chess960BackRank(id);
    const previous = seen.get(arrangement);
    assert.equal(previous, undefined, `id ${id} repeats the arrangement already given by id ${previous}`);
    seen.set(arrangement, id);
  }
  assert.equal(seen.size, CHESS960_POSITIONS);
});

test('every arrangement holds exactly one army: two rooks, two knights, two bishops, a queen and a king', () => {
  for (const id of ALL_IDS) {
    const arrangement = chess960BackRank(id);
    assert.equal(arrangement.length, 8, `id ${id} does not fill the back rank`);
    const counts: Record<string, number> = {};
    for (const ch of arrangement) counts[ch] = (counts[ch] ?? 0) + 1;
    assert.deepEqual(
      counts,
      { R: 2, N: 2, B: 2, Q: 1, K: 1 },
      `id ${id} (${arrangement}) is not a legal army`,
    );
  }
});

test('the bishops always stand on opposite-coloured squares', () => {
  for (const id of ALL_IDS) {
    const arrangement = chess960BackRank(id);
    const [first, second] = filesOf(arrangement, 'B');
    assert.notEqual(
      isLightFile(first),
      isLightFile(second),
      `id ${id} (${arrangement}) puts both bishops on the same colour`,
    );
  }
});

test('the king always stands strictly between the two rooks', () => {
  for (const id of ALL_IDS) {
    const arrangement = chess960BackRank(id);
    const [queensideRook, kingsideRook] = filesOf(arrangement, 'R');
    const king = arrangement.indexOf('K');
    assert.ok(
      queensideRook < king && king < kingsideRook,
      `id ${id} (${arrangement}) does not enclose the king: rooks at ${queensideRook}/${kingsideRook}, king at ${king}`,
    );
  }
});

test('id 518 is the traditional array', () => {
  assert.equal(chess960BackRank(CHESS960_STANDARD_ID), 'RNBQKBNR');
  assert.equal(CHESS960_STANDARD_ID, 518);
});

test('generation is deterministic: the same id gives the same arrangement every time', () => {
  // A generator that reached for entropy would still satisfy every invariant above while making
  // each position unreproducible, which is the specific failure this guards.
  const first = ALL_IDS.map(chess960BackRank);
  const second = ALL_IDS.map(chess960BackRank);
  assert.deepEqual(second, first);
});

test('an id outside 0..959, or one that is not a whole number, is refused', () => {
  for (const id of [-1, 960, 1000, 1.5, NaN, Infinity]) {
    assert.throws(
      () => chess960BackRank(id),
      RangeError,
      `id ${id} should not produce an arrangement`,
    );
  }
});

test('Black mirrors White file for file, and the pawns keep their ordinary ranks', () => {
  for (const id of ALL_IDS) {
    const [blackBack, blackPawns, ...rest] = chess960Fen(id).split(' ')[0].split('/');
    const whiteBack = rest[rest.length - 1];
    const whitePawns = rest[rest.length - 2];
    assert.equal(blackBack, whiteBack.toLowerCase(), `id ${id} does not mirror`);
    assert.equal(whiteBack, chess960BackRank(id));
    assert.equal(whitePawns, 'PPPPPPPP', `id ${id} moved White's pawns`);
    assert.equal(blackPawns, 'pppppppp', `id ${id} moved Black's pawns`);
    assert.deepEqual(rest.slice(0, 4), ['8', '8', '8', '8'], `id ${id} put something in midboard`);
  }
});

test('every starting position is legal and playable, with both sides holding both castling rights', () => {
  for (const id of ALL_IDS) {
    const pos = Position.chess960(id);
    assert.equal(pos.turn, 'w');
    assert.equal(pos.isCheck(), false, `id ${id} starts in check`);
    assert.ok(pos.legalMoves().length > 0, `id ${id} starts with no legal move`);
    assert.deepEqual(
      pos.status(),
      { over: false },
      `id ${id} starts in a terminal state`,
    );
    // Every starting position has one rook on each side of the king, so both are the outermost
    // rook on their side and X-FEN spells all four rights the ordinary way.
    assert.equal(pos.fen().split(' ')[2], 'KQkq', `id ${id} lost a castling right at birth`);
  }
});

test('the traditional array is reachable both as a Chess960 id and as the standard start', () => {
  // `Position.initial('chess960')` is deliberately position 518 rather than a random draw: a rules
  // engine that chose an arrangement for the caller would make every position it produced
  // unreproducible. Choosing among the 960 belongs to whoever starts a game.
  assert.equal(Position.initial('chess960').fen(), Position.chess960(CHESS960_STANDARD_ID).fen());
  assert.equal(
    Position.initial('chess960').fen(),
    Position.initial('standard').fen(),
    'position 518 is the traditional array, so the two must agree character for character',
  );
});
