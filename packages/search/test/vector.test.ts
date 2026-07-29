import test from 'node:test';
import * as assert from 'node:assert/strict';
import { dot, magnitude, cosineSimilarity, normalize } from '../src/vector';

test('vector: known-value cosine similarity (identical, orthogonal, opposite)', () => {
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const vOrthogonal = [0, 1, 0];
  const vOpposite = [-1, 0, 0];

  assert.equal(cosineSimilarity(v1, v2), 1);
  assert.equal(cosineSimilarity(v1, vOrthogonal), 0);
  assert.equal(cosineSimilarity(v1, vOpposite), -1);

  // Non-unit identical vector
  assert.equal(cosineSimilarity([3, 4], [6, 8]), 1);
});

test('vector: dot product known values', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 1 * 4 + 2 * 5 + 3 * 6);
  assert.equal(dot([1, 0], [0, 1]), 0);
});

test('vector: magnitude Euclidean L2 norm', () => {
  assert.equal(magnitude([3, 4]), 5);
  assert.equal(magnitude([0, 0, 0]), 0);
  assert.equal(magnitude([1]), 1);
});

test('vector: normalize unit vector', () => {
  const norm = normalize([3, 4]);
  assert.equal(norm.length, 2);
  assert.equal(Math.abs(norm[0] - 0.6) < 1e-12, true);
  assert.equal(Math.abs(norm[1] - 0.8) < 1e-12, true);
  assert.equal(magnitude(norm), 1);
});

test('vector: dimension mismatch throws RangeError with both lengths in message', () => {
  const a = [1, 2, 3];
  const b = [1, 2];

  assert.throws(
    () => dot(a, b),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.ok(err.message.includes('3'));
      assert.ok(err.message.includes('2'));
      return true;
    }
  );

  assert.throws(
    () => cosineSimilarity(a, b),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.ok(err.message.includes('3'));
      assert.ok(err.message.includes('2'));
      return true;
    }
  );
});

test('vector: zero vector handling (never NaN)', () => {
  const zero3 = [0, 0, 0];
  const unit3 = [1, 0, 0];

  assert.equal(cosineSimilarity(zero3, unit3), 0);
  assert.equal(cosineSimilarity(unit3, zero3), 0);
  assert.equal(cosineSimilarity(zero3, zero3), 0);

  const normZero = normalize(zero3);
  assert.deepEqual(normZero, [0, 0, 0]);
  assert.equal(Number.isNaN(normZero[0]), false);
});

test('vector: empty vector (length 0) handling', () => {
  assert.equal(dot([], []), 0);
  assert.equal(magnitude([]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.deepEqual(normalize([]), []);
});

test('vector: non-finite component rejection (NaN, Infinity, -Infinity)', () => {
  const nanVec = [1, NaN, 3];
  const infVec = [1, Infinity, 3];
  const negInfVec = [-Infinity, 2, 3];
  const validVec = [1, 2, 3];

  for (const invalid of [nanVec, infVec, negInfVec]) {
    assert.throws(
      () => dot(invalid, validVec),
      (err: unknown) => err instanceof RangeError
    );
    assert.throws(
      () => magnitude(invalid),
      (err: unknown) => err instanceof RangeError
    );
    assert.throws(
      () => cosineSimilarity(invalid, validVec),
      (err: unknown) => err instanceof RangeError
    );
    assert.throws(
      () => normalize(invalid),
      (err: unknown) => err instanceof RangeError
    );
  }
});

// Regression (CodeRabbit, PR #51): squaring before scaling overflowed to an infinite norm, so a
// vector of perfectly finite components produced a NaN score and a silently zeroed unit vector —
// the exact corruption assertFinite exists to prevent.
test('vector: components near MAX_VALUE still score in range instead of overflowing to NaN', () => {
  const huge = [Number.MAX_VALUE, Number.MAX_VALUE];
  const halfHuge = [Number.MAX_VALUE / 2, Number.MAX_VALUE / 2];

  assert.equal(cosineSimilarity(huge, huge), 1);
  assert.equal(cosineSimilarity(huge, halfHuge), 1);
  assert.equal(cosineSimilarity(huge, [Number.MAX_VALUE, -Number.MAX_VALUE]), 0);
  assert.equal(cosineSimilarity(huge, [-Number.MAX_VALUE, -Number.MAX_VALUE]), -1);

  const unit = normalize(huge);
  assert.equal(unit.every(Number.isFinite), true);
  assert.equal(Math.abs(magnitude(unit) - 1) < 1e-12, true);
  assert.equal(Math.abs(unit[0] - Math.SQRT1_2) < 1e-12, true);
});

test('vector: scaling does not perturb ordinary small-magnitude results', () => {
  // Scaling cancels out of the ratio, so everyday vectors must be unaffected by the overflow fix.
  assert.equal(cosineSimilarity([3, 4], [3, 4]), 1);
  assert.equal(cosineSimilarity([1e-300, 1e-300], [1e-300, 1e-300]), 1);
  assert.equal(Math.abs(cosineSimilarity([1, 2, 3], [4, 5, 6]) - 0.9746318461970762) < 1e-12, true);
});

test('vector: inputs are not mutated', () => {
  const a = [3, 4];
  const b = [1, 2];
  const aCopy = [...a];
  const bCopy = [...b];

  dot(a, b);
  magnitude(a);
  cosineSimilarity(a, b);
  normalize(a);

  assert.deepEqual(a, aCopy);
  assert.deepEqual(b, bCopy);
});
