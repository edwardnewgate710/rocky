import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  analysisCacheFingerprint,
  InMemoryLruCache,
  NullCache,
  limitsSatisfy,
  type AnalysisKey,
} from '../src/cache.js';
import type { EngineResult } from '../src/types.js';

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

test('configured option fingerprint uses locale-independent code-point ordering', () => {
  const expected = createHash('sha256')
    .update(`build\u0000${JSON.stringify([['Z', 2], ['a', 1]])}`)
    .digest('hex')
    .slice(0, 32);

  assert.equal(analysisCacheFingerprint('build', { options: { a: 1, Z: 2 } }), expected);
});

// The identity contract ADR-0138 discharged. ADR-0135 §7 blocked durable-cache wiring on a
// fingerprint that hashed option names but not their values, so two workers differing only in
// EvalFile or SyzygyPath shared one entry. The process-local LRU hid that by accident; a shared
// table does not.
test('configured option values namespace the build fingerprint', () => {
  assert.notEqual(
    analysisCacheFingerprint('build', { options: { EvalFile: 'nn-a.nnue' } }),
    analysisCacheFingerprint('build', { options: { EvalFile: 'nn-b.nnue' } }),
    'a different evaluation network is a different engine',
  );
  assert.notEqual(
    analysisCacheFingerprint('build', { options: { SyzygyPath: '/tb/a' } }),
    analysisCacheFingerprint('build', { options: { SyzygyPath: '/tb/b' } }),
    'different tablebases answer different positions outright',
  );
  assert.notEqual(
    analysisCacheFingerprint('build', { threads: 1 }),
    analysisCacheFingerprint('build', { threads: 2 }),
  );
  assert.notEqual(
    analysisCacheFingerprint('build', { hashMb: 16 }),
    analysisCacheFingerprint('build', { hashMb: 64 }),
  );
});

test('configured option fingerprint does not depend on object key order', () => {
  assert.equal(
    analysisCacheFingerprint('build', { threads: 2, hashMb: 64, options: { EvalFile: 'nn.nnue', SyzygyPath: '/tb' } }),
    analysisCacheFingerprint('build', { hashMb: 64, threads: 2, options: { SyzygyPath: '/tb', EvalFile: 'nn.nnue' } }),
  );
});

test('adding a configured option changes the fingerprint, and dropping it restores the original', () => {
  // Mutated in place rather than rebuilt, so identity is proven to follow the map's contents and
  // not the order keys were added to it.
  const options: Record<string, string> = { EvalFile: 'nn.nnue' };
  const one = analysisCacheFingerprint('build', { options });

  options['SyzygyPath'] = '/tb';
  const two = analysisCacheFingerprint('build', { options });
  assert.notEqual(one, two, 'an added option is a different configuration');

  delete options['SyzygyPath'];
  assert.equal(analysisCacheFingerprint('build', { options }), one, 'dropping it returns the earlier identity');
});

test('an engine configured with nothing keeps the bare build fingerprint', () => {
  // Absent and empty must collapse together: neither sends a single `setoption`.
  assert.equal(analysisCacheFingerprint('build', undefined), 'build');
  assert.equal(analysisCacheFingerprint('build', {}), 'build');
  assert.equal(analysisCacheFingerprint('build', { options: {} }), 'build');
  assert.notEqual(
    analysisCacheFingerprint('build', { threads: 2 }),
    'build',
    'one configured value is enough to namespace',
  );
});

test('configured option names and values cannot collide across the serialization boundary', () => {
  // A naive `name + value` concatenation gives both of these the preimage "EvalFileA".
  assert.notEqual(
    analysisCacheFingerprint('build', { options: { Eval: 'FileA' } }),
    analysisCacheFingerprint('build', { options: { EvalFile: 'A' } }),
  );
  // A naive comma-joined encoding gives both of these "Alpha,Beta,1".
  assert.notEqual(
    analysisCacheFingerprint('build', { options: { 'Alpha,Beta': 1 } }),
    analysisCacheFingerprint('build', { options: { Alpha: 1, Beta: 1 } }),
  );
  // JSON metacharacters in a name are the escape hatch a caller would reach for to forge a
  // second entry's boundary; `JSON.stringify` escapes them rather than letting them nest.
  assert.notEqual(
    analysisCacheFingerprint('build', { options: { 'A",1],["B': 1 } }),
    analysisCacheFingerprint('build', { options: { A: 1, B: 1 } }),
  );
});

test('a dedicated config field and its named option are one identity', () => {
  // Both routes send `setoption name Threads value n`, so sharing entries is correct — but only
  // per field, and only in bounds: `UciEngineInstance.applyConfig` clamps `threads`/`hashMb` to
  // the advertised spec and does not clamp the same option supplied through `options`.
  assert.equal(
    analysisCacheFingerprint('build', { threads: 4 }),
    analysisCacheFingerprint('build', { options: { Threads: 4 } }),
  );
  assert.equal(
    analysisCacheFingerprint('build', { hashMb: 64 }),
    analysisCacheFingerprint('build', { options: { Hash: 64 } }),
  );
  assert.notEqual(
    analysisCacheFingerprint('build', { threads: 2, hashMb: 64 }),
    analysisCacheFingerprint('build', { options: { Threads: 2, Hash: 64 } }),
    'the dedicated fields serialize ahead of options, so mixing routes fragments rather than collides',
  );
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
