import test from 'node:test';
import * as assert from 'node:assert/strict';
import { HashingEmbeddingProvider, fnv1a32 } from '../src/embedding';
import { magnitude } from '../src/vector';

// Golden values, not self-consistency: two calls in one process agree even if someone changes the
// FNV constants, but persisted embeddings (pgvector, Increment 10) would silently stop matching
// freshly computed ones. The empty-string and 'a' values are the published FNV-1a 32-bit reference
// vectors (offset basis 0x811c9dc5 and 0xe40c292c), so this also pins the algorithm itself.
test('embedding: hashing is byte-for-byte stable across processes and versions', () => {
  assert.equal(fnv1a32(''), 2166136261);
  assert.equal(fnv1a32('a'), 3826002220);
  assert.equal(fnv1a32('sicilian'), 3085007593);
  assert.equal(fnv1a32('defense'), 1981451347);
  assert.equal(fnv1a32('e4'), 2266682300);
});

test('embedding: determinism across two provider instances', async () => {
  const provider1 = new HashingEmbeddingProvider(128);
  const provider2 = new HashingEmbeddingProvider(128);

  const text = 'Ruy Lopez opening with e4 e5';
  const vec1 = await provider1.embed(text);
  const vec2 = await provider2.embed(text);

  assert.deepEqual(vec1, vec2);
});

test('embedding: correct dimensions and unit magnitude for non-empty text', async () => {
  const provider = new HashingEmbeddingProvider(256);
  assert.equal(provider.dimensions, 256);

  const vec = await provider.embed('Sicilian defense e4 c5');
  assert.equal(vec.length, 256);

  const mag = magnitude(vec);
  assert.equal(Math.abs(mag - 1) < 1e-12, true);
});

test('embedding: zero vector for empty or punctuation-only text', async () => {
  const provider = new HashingEmbeddingProvider(64);

  const emptyVec = await provider.embed('');
  assert.equal(emptyVec.length, 64);
  assert.deepEqual(emptyVec, new Array(64).fill(0));

  const punctVec = await provider.embed('!!! ??? ---');
  assert.equal(punctVec.length, 64);
  assert.deepEqual(punctVec, new Array(64).fill(0));
});

test('embedding: embedAll preserves order and handles empty array', async () => {
  const provider = new HashingEmbeddingProvider(32);

  const emptyRes = await provider.embedAll([]);
  assert.deepEqual(emptyRes, []);

  const texts = ['blitz game', 'bullet game', 'rapid game'];
  const vectors = await provider.embedAll(texts);

  assert.equal(vectors.length, 3);
  const single0 = await provider.embed('blitz game');
  const single1 = await provider.embed('bullet game');
  const single2 = await provider.embed('rapid game');

  assert.deepEqual(vectors[0], single0);
  assert.deepEqual(vectors[1], single1);
  assert.deepEqual(vectors[2], single2);
});

test('embedding: constructor throws RangeError for invalid dimensions', () => {
  // The ceiling is pgvector's 16000-dimension storage limit, so anything this package accepts can
  // always be persisted by the Increment 10 adapter. 2**32 is the original regression (CodeRabbit,
  // PR #51): it is a safe integer, so it used to construct fine and only blow up with "Invalid
  // array length" on the first embed(), far from the actual mistake.
  const invalidDimensions = [0, -1, -256, 3.14, NaN, Infinity, 16001, 2 ** 32];

  for (const d of invalidDimensions) {
    assert.throws(
      () => new HashingEmbeddingProvider(d),
      (err: unknown) => err instanceof RangeError,
      `expected ${d} to be rejected`
    );
  }

  // The cap itself is usable, and so is every realistic model dimension.
  for (const d of [1, 384, 768, 1536, 3072, 16000]) {
    assert.equal(new HashingEmbeddingProvider(d).dimensions, d);
  }
});
