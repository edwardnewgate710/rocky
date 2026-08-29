import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLruCache, NullCache, limitsSatisfy, type AnalysisKey, type EngineResult } from '../src/index.js';

const result: EngineResult[] = [
  { multipv: 1, evaluation: { type: 'cp', value: 20 }, principalVariation: ['e2e4'], depth: 20, nodes: 1000, nps: 5000, timeMs: 100 },
];
const key: AnalysisKey = { fingerprint: 'fp1', fen: 'FEN', variant: 'chess', multiPv: 1 };

test('limitsSatisfy honours the >= rule per dimension', () => {
  assert.equal(limitsSatisfy({ depth: 20 }, { depth: 18 }), true);
  assert.equal(limitsSatisfy({ depth: 18 }, { depth: 20 }), false);
  assert.equal(limitsSatisfy({ nodes: 5000 }, { nodes: 5000 }), true);
  assert.equal(limitsSatisfy({ depth: 20 }, { nodes: 100 }), false, 'a different dimension is not satisfied');
});

test('NullCache never returns anything', async () => {
  const cache = new NullCache();
  await cache.set(key, result, { limits: { depth: 20 } });
  assert.equal(await cache.get(key, { depth: 1 }), undefined);
});

test('LRU returns a hit only when the cached search is deep enough', async () => {
  const cache = new InMemoryLruCache(10);
  await cache.set(key, result, { limits: { depth: 20 } });
  assert.deepEqual(await cache.get(key, { depth: 18 }), result);
  assert.equal(await cache.get(key, { depth: 25 }), undefined, 'a deeper request must recompute');
});

test('cache is namespaced by fingerprint', async () => {
  const cache = new InMemoryLruCache(10);
  await cache.set(key, result, { limits: { depth: 20 } });
  const otherBuild: AnalysisKey = { ...key, fingerprint: 'fp2' };
  assert.equal(await cache.get(otherBuild, { depth: 10 }), undefined);
});

test('cache key components cannot collide through delimiter placement', async () => {
  const cache = new InMemoryLruCache(10);
  const first: AnalysisKey = { fingerprint: 'build|one', fen: 'position', variant: 'chess', multiPv: 1 };
  const second: AnalysisKey = { fingerprint: 'build', fen: 'position', variant: 'one|chess', multiPv: 1 };

  await cache.set(first, result, { limits: { depth: 20 } });

  assert.equal(await cache.get(second, { depth: 20 }), undefined);
});

test('a weaker late write cannot replace a stronger cached analysis', async () => {
  const cache = new InMemoryLruCache(10);
  const shallow = result.map((line) => ({ ...line, depth: 10 }));

  await cache.set(key, result, { limits: { depth: 20 } });
  await cache.set(key, shallow, { limits: { depth: 10 } });

  assert.deepEqual(await cache.get(key, { depth: 20 }), result);
});

test('LRU evicts the least-recently-used entry', async () => {
  const cache = new InMemoryLruCache(2);
  const k = (fen: string): AnalysisKey => ({ fingerprint: 'fp', fen, variant: 'chess', multiPv: 1 });
  await cache.set(k('a'), result, { limits: { depth: 10 } });
  await cache.set(k('b'), result, { limits: { depth: 10 } });
  await cache.get(k('a'), { depth: 10 }); // touch 'a' so 'b' is now LRU
  await cache.set(k('c'), result, { limits: { depth: 10 } });
  assert.equal(cache.size, 2);
  assert.ok(await cache.get(k('a'), { depth: 10 }));
  assert.equal(await cache.get(k('b'), { depth: 10 }), undefined);
  assert.ok(await cache.get(k('c'), { depth: 10 }));
});
