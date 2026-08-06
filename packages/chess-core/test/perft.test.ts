/**
 * Perft verification: the definitive correctness test for a move generator.
 * Node counts below are the published reference values used across the chess
 * programming community (e.g. the Chess Programming Wiki).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';
import type { Variant } from '../src/types';

interface PerftCase {
  name: string;
  fen: string;
  expected: number[]; // index = depth-1
}

// Reference: https://www.chessprogramming.org/Perft_Results
const CASES: PerftCase[] = [
  {
    name: 'startpos',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expected: [20, 400, 8902, 197281],
  },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expected: [48, 2039, 97862],
  },
  {
    name: 'position-3 (en passant / promotions)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expected: [14, 191, 2812, 43238],
  },
  {
    name: 'position-4 (promotions & pins)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expected: [6, 264, 9467],
  },
  {
    name: 'position-5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expected: [44, 1486, 62379],
  },
];

for (const c of CASES) {
  test(`perft: ${c.name}`, () => {
    const pos = Position.fromFen(c.fen);
    c.expected.forEach((exp, i) => {
      const depth = i + 1;
      const got = pos.perft(depth);
      assert.equal(got, exp, `${c.name} depth ${depth}: expected ${exp}, got ${got}`);
    });
  });
}

/**
 * Variant coverage.
 *
 * Every case above runs `standard`. `types.ts` declares eight variants and `movegen.ts` branches on
 * the variant in six places, so seven rule sets had no perft verification at all.
 *
 * None of the numbers below were produced by running this move generator. Recording what the
 * implementation currently prints and calling it `expected` is a golden master: it locks in today's
 * bugs and passes forever regardless of correctness. Every value here is either a published
 * reference already used above, or a relationship that no fixed output could satisfy.
 */

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

/**
 * `kingofthehill` and `threecheck` change only the terminal condition (`position.ts`), not move
 * generation; `chess960` differs only in castling, and the standard array is Chess960 start position
 * 518, where castling is the standard arrangement. So at depths where the variant's own terminal
 * condition cannot fire, their perft must equal the published standard counts exactly.
 *
 * That bound is why the depths stop where they do: a king cannot reach a central square, and three
 * checks cannot be delivered, within five plies of the opening position.
 */
const IDENTICAL_TO_STANDARD: Variant[] = ['chess960', 'kingofthehill', 'threecheck'];

for (const variant of IDENTICAL_TO_STANDARD) {
  test(`perft: ${variant} matches standard on startpos (movegen is unchanged)`, () => {
    [20, 400, 8902, 197281].forEach((exp, i) => {
      const got = Position.fromFen(STARTPOS, variant).perft(i + 1);
      assert.equal(got, exp, `${variant} startpos depth ${i + 1}: expected ${exp}, got ${got}`);
    });
  });

  test(`perft: ${variant} matches standard on kiwipete`, () => {
    [48, 2039, 97862].forEach((exp, i) => {
      const got = Position.fromFen(KIWIPETE, variant).perft(i + 1);
      assert.equal(got, exp, `${variant} kiwipete depth ${i + 1}: expected ${exp}, got ${got}`);
    });
  });
}

/**
 * Equality alone would be satisfied by an implementation that had quietly forgotten a variant
 * entirely, so the variants that must diverge are pinned too — as relationships rather than counts,
 * because a relationship cannot be met by a generator returning a fixed number.
 */
test('perft: crazyhouse matches standard until a drop is legal, then exceeds it', () => {
  // Ply 1 white, 2 black, 3 white, 4 black. White's earliest capture is ply 3, so black — to move on
  // ply 4 — still holds an empty pocket and has no drop to make. Through depth 4 the two are equal.
  [20, 400, 8902, 197281].forEach((exp, i) => {
    const got = Position.fromFen(STARTPOS, 'crazyhouse').perft(i + 1);
    assert.equal(got, exp, `crazyhouse depth ${i + 1}: expected ${exp}, got ${got}`);
  });

  // Give white a pawn in hand rather than searching five plies to earn one. The count that follows
  // is arithmetic, not a reading taken off this engine: the opening array leaves ranks 3-6 empty,
  // that is 4 x 8 = 32 squares, and a pawn may be dropped on any of them — rank 1 and rank 8 are the
  // forbidden ranks and neither is in range. So 20 ordinary moves + 32 drops = 52.
  //
  // Reaching the same fact by comparing perft(5) totals also works and is what this test did first,
  // but it cost 12 seconds of the package's 15 and proved something weaker: that one number exceeded
  // another, without saying by how much or why.
  const withPawnInHand = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[P] w KQkq - 0 1';
  assert.equal(
    Position.fromFen(withPawnInHand, 'crazyhouse').perft(1),
    20 + 32,
    'a pawn in hand must add exactly one drop per empty square on ranks 3-6',
  );

  // And the same position with an empty pocket must lose precisely those 32 nodes, so the delta is
  // attributable to the drops rather than to anything else the variant does.
  assert.equal(Position.fromFen(STARTPOS, 'crazyhouse').perft(1), 20);
});

test('perft: atomic matches standard until the first capture, then diverges', () => {
  // No capture is available inside three plies of the opening position, so nothing has exploded yet.
  [20, 400, 8902].forEach((exp, i) => {
    const got = Position.fromFen(STARTPOS, 'atomic').perft(i + 1);
    assert.equal(got, exp, `atomic depth ${i + 1}: expected ${exp}, got ${got}`);
  });

  // Depth 4 reaches white's first captures, which remove both pieces and change what follows.
  const atomicDepth4 = Position.fromFen(STARTPOS, 'atomic').perft(4);
  assert.notEqual(
    atomicDepth4,
    197281,
    'atomic depth 4 must differ from standard: captures explode and change the resulting positions',
  );
});

/**
 * `horde` and `racingkings` are deliberately absent.
 *
 * Both have their own start positions and genuinely different rules, so neither the standard
 * reference counts nor an equality invariant applies, and no published perft values for them were
 * available to verify against. Writing plausible-looking numbers would be fabrication, and a
 * fabricated reference is worse than no test: it reports verification that never happened. Tracked
 * in `docs/ROADMAP.md` as the remaining part of this follow-up.
 */
