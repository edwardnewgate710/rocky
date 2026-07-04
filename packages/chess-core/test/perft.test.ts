/**
 * Perft verification: the definitive correctness test for a move generator.
 * Node counts below are the published reference values used across the chess
 * programming community (e.g. the Chess Programming Wiki).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/position';

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
