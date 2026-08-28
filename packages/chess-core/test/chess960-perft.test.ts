/**
 * Chess960 perft against independently published node counts.
 *
 * None of these numbers came from this engine. They are the lichess-org/scalachess Chess960 vectors,
 * which cite the Chess Programming Wiki's Chess960 perft results and Ethereal's `fischer.epd` — the
 * same provenance the horde and racingkings vectors in `perft.test.ts` already use. Recording what
 * this implementation happens to print and calling it `expected` would lock in today's bugs and pass
 * forever, which is the one thing a correctness test must not do.
 *
 * The corpus covers all 960 starting positions, each advanced to roughly move 9 so that back ranks
 * are partly cleared and castling is genuinely reachable. Its EPDs are written in Shredder-FEN,
 * which is why reading that spelling is a hard requirement rather than a nicety.
 *
 * **What this suite does not prove.** Every vector is read with `Position.fromFen`, so it exercises
 * FEN parsing, move generation and castling across 960 distinct arrangements — not the
 * starting-position generator. A defect in `chess960BackRank` for some id would leave every test
 * here green. That guarantee belongs to `chess960-positions.test.ts`, which enumerates all 960 ids
 * and checks the arrangements themselves. The two are complementary and neither substitutes for the
 * other. Raised in the CodeRabbit review of PR #10.
 *
 * Depth is split deliberately. Every position runs to depth 2, which is what catches an arrangement
 * whose moves are generated wrongly. A fixed, evenly-spaced sample runs to depth 4, which is where a
 * castling-rights or transit-safety error that survives two plies shows up. Running all 960 to
 * depth 4 costs several minutes of CI per Node version and finds nothing the sample does not.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Position } from '../src/position';

interface PerftVector {
  readonly id: number;
  readonly epd: string;
  /** Published node counts, index 0 = depth 1. */
  readonly expected: readonly number[];
}

/**
 * Compiled tests live in `dist-test/test`, two levels below the package root, while the fixture
 * stays in the source tree — `tsc` copies only TypeScript.
 */
const FIXTURE = join(__dirname, '..', '..', 'test', 'fixtures', 'chess960-perft.csv');

function loadVectors(): PerftVector[] {
  const text = readFileSync(FIXTURE, 'utf8');
  const vectors: PerftVector[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const [id, epd, counts] = line.split(';');
    vectors.push({
      id: Number(id),
      epd,
      expected: counts.split(',').map(Number),
    });
  }
  return vectors;
}

const VECTORS = loadVectors();

/** Every 30th position: 32 of the 960, spread evenly rather than chosen to suit the engine. */
const DEEP_SAMPLE_STRIDE = 30;
const SHALLOW_DEPTH = 2;
const DEEP_DEPTH = 4;

function assertPerft(vector: PerftVector, maxDepth: number): void {
  const pos = Position.fromFen(vector.epd, 'chess960');
  for (let depth = 1; depth <= maxDepth; depth++) {
    const expected = vector.expected[depth - 1];
    assert.equal(
      pos.perft(depth),
      expected,
      `id ${vector.id} depth ${depth} (${vector.epd}): expected ${expected}`,
    );
  }
}

test('the corpus is the whole domain, one vector per starting position', () => {
  // A truncated or mis-parsed fixture would quietly shrink every test below it into a no-op.
  assert.equal(VECTORS.length, 960);
  assert.deepEqual(
    VECTORS.map((v) => v.id),
    Array.from({ length: 960 }, (_, i) => i),
  );
  for (const v of VECTORS) {
    assert.equal(v.expected.length, 4, `id ${v.id} does not carry four depths`);
    assert.ok(v.expected.every(Number.isInteger), `id ${v.id} has a non-integer count`);
  }
});

test(`perft: all 960 published positions to depth ${SHALLOW_DEPTH}`, () => {
  for (const vector of VECTORS) assertPerft(vector, SHALLOW_DEPTH);
});

test(`perft: an evenly spaced sample to depth ${DEEP_DEPTH}`, () => {
  const sample = VECTORS.filter((v) => v.id % DEEP_SAMPLE_STRIDE === 0);
  assert.equal(sample.length, 32, 'the sample must not silently shrink');
  for (const vector of sample) assertPerft(vector, DEEP_DEPTH);
});

test('the reference EPDs really are Shredder-spelled, so this corpus exercises that reader', () => {
  // If the fixture were rewritten into KQkq the suite would still pass while no longer testing the
  // spelling that made file-letter parsing necessary in the first place.
  const shredder = VECTORS.filter((v) => /^[A-Ha-h]+$/.test(v.epd.split(/\s+/)[2]));
  assert.ok(
    shredder.length > 900,
    `expected nearly every vector to use file letters, got ${shredder.length}`,
  );
});

test('perft: the traditional array reached through the Chess960 numbering matches standard chess', () => {
  // Position 518 *is* ordinary chess, so the published standard start-position counts must hold
  // exactly. This ties the new numbering back to the values `perft.test.ts` already pins.
  const pos = Position.chess960(518);
  [20, 400, 8902, 197281].forEach((expected, i) => {
    assert.equal(pos.perft(i + 1), expected, `depth ${i + 1}`);
  });
});
