/**
 * Comprehensive test suite for the AI orchestrator.
 * Covers: unit tests, routing, failover, retry, timeout, caching,
 * rate limiting, health/circuit breaker, benchmark, grounding,
 * and edge cases for all components.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiOrchestrator,
  FakeProvider,
  AiError,
  NoProviderError,
  CancelledError,
  ProviderRegistry,
  PriorityStrategy,
  WeightedStrategy,
  RoundRobinStrategy,
  InMemoryLruCache,
  NullCache,
  RateLimiter,
  HealthTracker,
  BenchmarkRunner,
  CHESS_BENCHMARK_TASKS,
  buildGroundedMessages,
  formatGrounding,
  positionHash,
  buildCacheKey,
  hashString,
  isExpired,
  type CompletionRequest,
  type EngineGrounding,
  type CacheEntry,
  type CompletionResponse,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides?: Partial<CompletionRequest>): CompletionRequest {
  return {
    task: 'explanation',
    messages: [{ role: 'user', content: 'Why is e4 a good move?' }],
    ...overrides,
  };
}

function makeGrounding(): EngineGrounding {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    moveUci: 'e2e4',
    evalCp: 20,
    depth: 15,
    bestLine: ['e7e5', 'g1f3', 'b8c6', 'b1c3'],
  };
}

function makeResponse(content: string, providerId = 'test'): CompletionResponse {
  return {
    content,
    model: 'fake-model',
    providerId,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: 'stop',
    latencyMs: 10,
    costMicroUsd: 100,
    cached: false,
  };
}

// ---------------------------------------------------------------------------
// Cache tests
// ---------------------------------------------------------------------------

describe('Cache', () => {
  test('InMemoryLruCache stores and retrieves responses', async () => {
    const cache = new InMemoryLruCache(100, 60_000);
    const key = buildCacheKey(makeRequest());
    await cache.set(key, makeResponse('test'));
    const entry = await cache.get(key);
    assert.ok(entry);
    assert.equal(entry!.response.content, 'test');
  });

  test('InMemoryLruCache evicts LRU entries', async () => {
    const cache = new InMemoryLruCache(2, 60_000);
    const key1 = buildCacheKey(makeRequest({ messages: [{ role: 'user', content: 'a' }] }));
    const key2 = buildCacheKey(makeRequest({ messages: [{ role: 'user', content: 'b' }] }));
    const key3 = buildCacheKey(makeRequest({ messages: [{ role: 'user', content: 'c' }] }));
    await cache.set(key1, makeResponse('x'));
    await cache.set(key2, makeResponse('x'));
    await cache.set(key3, makeResponse('x'));
    assert.equal(cache.size, 2);
    const evicted = await cache.get(key1);
    assert.equal(evicted, undefined);
  });

  test('InMemoryLruCache returns undefined for missing keys', async () => {
    const cache = new InMemoryLruCache(100, 60_000);
    const key = buildCacheKey(makeRequest());
    const result = await cache.get(key);
    assert.equal(result, undefined);
  });

  test('InMemoryLruCache clear removes all entries', async () => {
    const cache = new InMemoryLruCache(100, 60_000);
    const key = buildCacheKey(makeRequest());
    await cache.set(key, makeResponse('test'));
    assert.equal(cache.size, 1);
    cache.clear();
    assert.equal(cache.size, 0);
  });

  test('InMemoryLruCache rejects maxEntries < 1', () => {
    assert.throws(() => new InMemoryLruCache(0, 60_000), RangeError);
  });

  test('InMemoryLruCache expires entries after TTL', async () => {
    const cache = new InMemoryLruCache(100, 1); // 1ms TTL
    const key = buildCacheKey(makeRequest());
    await cache.set(key, makeResponse('test'));
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));
    const entry = await cache.get(key);
    assert.equal(entry, undefined);
  });

  test('InMemoryLruCache TTL=0 means no expiry', async () => {
    const cache = new InMemoryLruCache(100, 0);
    const key = buildCacheKey(makeRequest());
    await cache.set(key, makeResponse('test'));
    await new Promise((r) => setTimeout(r, 10));
    const entry = await cache.get(key);
    assert.ok(entry);
  });

  test('InMemoryLruCache LRU access promotes entry', async () => {
    const cache = new InMemoryLruCache(2, 60_000);
    const key1 = buildCacheKey(makeRequest({ messages: [{ role: 'user', content: 'a' }] }));
    const key2 = buildCacheKey(makeRequest({ messages: [{ role: 'user', content: 'b' }] }));
    const key3 = buildCacheKey(makeRequest({ messages: [{ role: 'user', content: 'c' }] }));
    await cache.set(key1, makeResponse('x'));
    await cache.set(key2, makeResponse('x'));
    // Access key1 to promote it
    await cache.get(key1);
    // Insert key3 — key2 should be evicted (not key1)
    await cache.set(key3, makeResponse('x'));
    const key1Entry = await cache.get(key1);
    const key2Entry = await cache.get(key2);
    assert.ok(key1Entry, 'key1 should still be cached (was accessed)');
    assert.equal(key2Entry, undefined, 'key2 should be evicted');
  });

  test('NullCache always returns undefined', async () => {
    const cache = new NullCache();
    const key = buildCacheKey(makeRequest());
    assert.equal(await cache.get(key), undefined);
    assert.equal(cache.size, 0);
  });

  test('hashString is deterministic and collision-resistant', () => {
    assert.equal(hashString('hello'), hashString('hello'));
    assert.notEqual(hashString('hello'), hashString('world'));
    assert.equal(hashString('').length, 64);
  });

  test('isExpired returns false for TTL=0', () => {
    const entry: CacheEntry = { response: makeResponse('x'), storedAt: 0, ttlMs: 0 };
    assert.equal(isExpired(entry, 999_999), false);
  });

  test('isExpired returns true after TTL', () => {
    const entry: CacheEntry = { response: makeResponse('x'), storedAt: 100, ttlMs: 50 };
    assert.equal(isExpired(entry, 200), true);
  });

  test('buildCacheKey is deterministic for same request', () => {
    const r1 = makeRequest();
    const r2 = makeRequest();
    const k1 = buildCacheKey(r1);
    const k2 = buildCacheKey(r2);
    assert.equal(k1.messageHash, k2.messageHash);
    assert.equal(k1.task, k2.task);
  });

  test('buildCacheKey differs for different temperature', () => {
    const k1 = buildCacheKey(makeRequest({ temperature: 0.5 }));
    const k2 = buildCacheKey(makeRequest({ temperature: 1.0 }));
    assert.notEqual(k1.temperature, k2.temperature);
  });

  test('buildCacheKey includes structured schema, provider, modality, and user scope', () => {
    const base = makeRequest();
    const variants = [
      makeRequest({ structured: true, schema: { type: 'object' } }),
      makeRequest({ providerPreference: 'provider-b' }),
      makeRequest({ modality: 'vision' }),
      makeRequest({ userId: 'another-user' }),
    ];
    for (const variant of variants) {
      assert.notEqual(buildCacheKey(base).optionsHash, buildCacheKey(variant).optionsHash);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('ProviderRegistry', () => {
  test('register and lookup by id', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider({ id: 'test' });
    const caps = await provider.discoverCapabilities();
    registry.register(provider, caps);
    assert.equal(registry.size, 1);
    assert.ok(registry.get('test'));
  });

  test('duplicate registration throws', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider({ id: 'dup' });
    const caps = await provider.discoverCapabilities();
    registry.register(provider, caps);
    assert.throws(() => registry.register(provider, caps));
  });

  test('unregister removes a provider', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider({ id: 'removable' });
    const caps = await provider.discoverCapabilities();
    registry.register(provider, caps);
    assert.equal(registry.size, 1);
    assert.equal(registry.unregister('removable'), true);
    assert.equal(registry.size, 0);
    assert.equal(registry.get('removable'), undefined);
  });

  test('unregister returns false for unknown provider', () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.unregister('nonexistent'), false);
  });

  test('get returns undefined for unknown provider', () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.get('nonexistent'), undefined);
  });

  test('byTaskClass filters correctly', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { taskClasses: ['coach'] } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { taskClasses: [] } });
    registry.register(p1, await p1.discoverCapabilities());
    registry.register(p2, await p2.discoverCapabilities());
    const coachProviders = registry.byTaskClass('coach');
    assert.equal(coachProviders.length, 2);
    const explanationProviders = registry.byTaskClass('explanation');
    assert.equal(explanationProviders.length, 1);
    assert.equal(explanationProviders[0].provider.id, 'p2');
  });

  test('all() returns enabled providers sorted by priority', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 10 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    const all = registry.all();
    assert.equal(all[0].provider.id, 'p2');
    assert.equal(all[1].provider.id, 'p1');
  });

  test('disabled providers are excluded from all()', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities(), { enabled: true });
    registry.register(p2, await p2.discoverCapabilities(), { enabled: false });
    const all = registry.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].provider.id, 'p1');
  });

  test('streamingCapable filters correctly', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { supportsStreaming: true } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { supportsStreaming: false } });
    registry.register(p1, await p1.discoverCapabilities());
    registry.register(p2, await p2.discoverCapabilities());
    assert.equal(registry.streamingCapable().length, 1);
  });

  test('structuredCapable filters correctly', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { supportsStructured: true } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { supportsStructured: false } });
    registry.register(p1, await p1.discoverCapabilities());
    registry.register(p2, await p2.discoverCapabilities());
    assert.equal(registry.structuredCapable().length, 1);
  });

  test('embeddingCapable filters correctly', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { supportsEmbeddings: true } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { supportsEmbeddings: false } });
    registry.register(p1, await p1.discoverCapabilities());
    registry.register(p2, await p2.discoverCapabilities());
    assert.equal(registry.embeddingCapable().length, 1);
  });

  test('isCircuitOpen returns true for unknown provider', () => {
    const registry = new ProviderRegistry();
    assert.equal(registry.isCircuitOpen('nonexistent'), true);
  });

  test('recordSuccess and recordFailure update health', async () => {
    const registry = new ProviderRegistry();
    const p = new FakeProvider({ id: 'p' });
    registry.register(p, await p.discoverCapabilities());
    registry.recordSuccess('p', 100);
    registry.recordFailure('p', 'err');
    const snap = registry.healthSnapshots()[0];
    assert.equal(snap.requestCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe('Routing', () => {
  const routingConfig = {
    strategy: 'priority' as const,
    failoverEnabled: true,
    maxFailoverAttempts: 3,
    defaultLatencyBudgetMs: 30_000,
    defaultCostCeiling: 0,
  };

  test('PriorityStrategy selects highest-priority provider', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 10 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    const strategy = new PriorityStrategy();
    const decision = strategy.route({
      request: makeRequest(),
      registry,
      triedProviderIds: [],
      config: routingConfig,
    });
    assert.equal(decision.provider.provider.id, 'p2');
  });

  test('PriorityStrategy skips tried providers', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 1 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 2 });
    const strategy = new PriorityStrategy();
    const decision = strategy.route({
      request: makeRequest(),
      registry,
      triedProviderIds: ['p1'],
      config: routingConfig,
    });
    assert.equal(decision.provider.provider.id, 'p2');
  });

  test('PriorityStrategy throws when no providers available', async () => {
    const registry = new ProviderRegistry();
    const strategy = new PriorityStrategy();
    assert.throws(() =>
      strategy.route({
        request: makeRequest(),
        registry,
        triedProviderIds: [],
        config: routingConfig,
      }),
    );
  });

  test('PriorityStrategy filters by modality', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { modalities: ['text'] } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { modalities: ['vision'] } });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 2 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    const strategy = new PriorityStrategy();
    const decision = strategy.route({
      request: makeRequest({ modality: 'text' }),
      registry,
      triedProviderIds: [],
      config: routingConfig,
    });
    assert.equal(decision.provider.provider.id, 'p1');
  });

  test('PriorityStrategy filters by streaming capability', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { supportsStreaming: true } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { supportsStreaming: false } });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 2 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    const strategy = new PriorityStrategy();
    const decision = strategy.route({
      request: makeRequest({ stream: true }),
      registry,
      triedProviderIds: [],
      config: routingConfig,
    });
    assert.equal(decision.provider.provider.id, 'p1');
  });

  test('PriorityStrategy filters by structured capability', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1', capabilities: { supportsStructured: true } });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { supportsStructured: false } });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 2 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    const strategy = new PriorityStrategy();
    const decision = strategy.route({
      request: makeRequest({ structured: true }),
      registry,
      triedProviderIds: [],
      config: routingConfig,
    });
    assert.equal(decision.provider.provider.id, 'p1');
  });

  test('WeightedStrategy scores and selects best provider', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 10 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    // Give p2 some failures to lower its score
    registry.recordFailure('p2', 'err');
    registry.recordFailure('p2', 'err');
    const strategy = new WeightedStrategy();
    const decision = strategy.route({
      request: makeRequest(),
      registry,
      triedProviderIds: [],
      config: { ...routingConfig, strategy: 'weighted' as const },
    });
    // p1 has higher success rate (no failures) so should win despite lower priority
    assert.equal(decision.provider.provider.id, 'p1');
  });

  test('WeightedStrategy boosts provider preference', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities(), { priority: 1 });
    registry.register(p2, await p2.discoverCapabilities(), { priority: 1 });
    const strategy = new WeightedStrategy();
    const decision = strategy.route({
      request: makeRequest({ providerPreference: 'p2' }),
      registry,
      triedProviderIds: [],
      config: { ...routingConfig, strategy: 'weighted' as const },
    });
    assert.equal(decision.provider.provider.id, 'p2');
  });

  test('WeightedStrategy throws when no providers available', async () => {
    const registry = new ProviderRegistry();
    const strategy = new WeightedStrategy();
    assert.throws(() =>
      strategy.route({
        request: makeRequest(),
        registry,
        triedProviderIds: [],
        config: { ...routingConfig, strategy: 'weighted' as const },
      }),
    );
  });

  test('RoundRobinStrategy cycles through providers', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    const p2 = new FakeProvider({ id: 'p2' });
    registry.register(p1, await p1.discoverCapabilities());
    registry.register(p2, await p2.discoverCapabilities());
    const strategy = new RoundRobinStrategy();
    const ctx = {
      request: makeRequest(),
      registry,
      triedProviderIds: [],
      config: { ...routingConfig, strategy: 'round_robin' as const },
    };
    const d1 = strategy.route(ctx);
    const d2 = strategy.route(ctx);
    assert.notEqual(d1.provider.provider.id, d2.provider.provider.id);
  });

  test('RoundRobinStrategy throws when no providers available', async () => {
    const registry = new ProviderRegistry();
    const strategy = new RoundRobinStrategy();
    assert.throws(() =>
      strategy.route({
        request: makeRequest(),
        registry,
        triedProviderIds: [],
        config: { ...routingConfig, strategy: 'round_robin' as const },
      }),
    );
  });

  test('attempt counter increments correctly', async () => {
    const registry = new ProviderRegistry();
    const p1 = new FakeProvider({ id: 'p1' });
    registry.register(p1, await p1.discoverCapabilities());
    const strategy = new PriorityStrategy();
    const decision = strategy.route({
      request: makeRequest(),
      registry,
      triedProviderIds: ['failed1', 'failed2'],
      config: routingConfig,
    });
    assert.equal(decision.attempt, 3);
  });
});

// ---------------------------------------------------------------------------
// Failover tests (acceptance criterion: kill a provider mid-request)
// ---------------------------------------------------------------------------

describe('Failover', () => {
  test('orchestrator fails over when primary provider fails', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 3 },
      },
    });
    const failing = new FakeProvider({
      id: 'failing',
      failOnAttempt: 0,
      failWithError: new AiError('provider_error', 'injected failure', { retryable: true, providerId: 'failing' }),
    });
    const healthy = new FakeProvider({ id: 'healthy', content: 'failover success' });
    await orch.registerProvider(failing, { priority: 1 });
    await orch.registerProvider(healthy, { priority: 2 });

    const response = await orch.complete(makeRequest());
    assert.equal(response.content, 'failover success');
    assert.equal(response.providerId, 'healthy');
    assert.equal(orch.health().totalFailovers, 1);
  });

  test('orchestrator throws when all providers fail', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 2 },
      },
    });
    const p1 = new FakeProvider({ id: 'p1', failOnAttempt: 0 });
    const p2 = new FakeProvider({ id: 'p2', failOnAttempt: 0 });
    await orch.registerProvider(p1, { priority: 1 });
    await orch.registerProvider(p2, { priority: 2 });

    await assert.rejects(orch.complete(makeRequest()), AiError);
  });

  test('non-retryable errors abort immediately', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 3 },
      },
    });
    const p1 = new FakeProvider({
      id: 'p1',
      failOnAttempt: 0,
      failWithError: new AiError('auth_failed', 'bad key', { providerId: 'p1' }),
    });
    const p2 = new FakeProvider({ id: 'p2' });
    await orch.registerProvider(p1, { priority: 1 });
    await orch.registerProvider(p2, { priority: 2 });

    await assert.rejects(orch.complete(makeRequest()), (err: Error) => {
      assert.equal((err as AiError).code, 'auth_failed');
      return true;
    });
    assert.equal(p2.calls.length, 0);
  });

  test('failover disabled: single attempt only', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: false, maxFailoverAttempts: 3 },
      },
    });
    const p1 = new FakeProvider({ id: 'p1', failOnAttempt: 0 });
    const p2 = new FakeProvider({ id: 'p2' });
    await orch.registerProvider(p1, { priority: 1 });
    await orch.registerProvider(p2, { priority: 2 });

    await assert.rejects(orch.complete(makeRequest()));
    assert.equal(p2.calls.length, 0, 'p2 should not be called when failover is disabled');
  });

  test('retry exhaustion throws last error', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 2 },
      },
    });
    const p1 = new FakeProvider({
      id: 'p1',
      failOnAttempt: 0,
      failWithError: new AiError('provider_error', 'first error', { retryable: true, providerId: 'p1' }),
    });
    const p2 = new FakeProvider({
      id: 'p2',
      failOnAttempt: 0,
      failWithError: new AiError('provider_error', 'second error', { retryable: true, providerId: 'p2' }),
    });
    await orch.registerProvider(p1, { priority: 1 });
    await orch.registerProvider(p2, { priority: 2 });

    await assert.rejects(orch.complete(makeRequest()), (err: Error) => {
      assert.ok(err.message.includes('second error'));
      return true;
    });
  });

  test('failover chain: 3 providers, first two fail, third succeeds', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 3 },
      },
    });
    const p1 = new FakeProvider({ id: 'p1', failOnAttempt: 0 });
    const p2 = new FakeProvider({ id: 'p2', failOnAttempt: 0 });
    const p3 = new FakeProvider({ id: 'p3', content: 'third time lucky' });
    await orch.registerProvider(p1, { priority: 1 });
    await orch.registerProvider(p2, { priority: 2 });
    await orch.registerProvider(p3, { priority: 3 });

    const response = await orch.complete(makeRequest());
    assert.equal(response.content, 'third time lucky');
    assert.equal(response.providerId, 'p3');
    assert.equal(orch.health().totalFailovers, 2);
  });
});

// ---------------------------------------------------------------------------
// Timeout tests
// ---------------------------------------------------------------------------

describe('Timeout', () => {
  test('orchestrator times out and fails over', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 2, defaultLatencyBudgetMs: 50 },
      },
    });
    const slow = new FakeProvider({ id: 'slow', latencyMs: 500 });
    const fast = new FakeProvider({ id: 'fast', content: 'fast response' });
    await orch.registerProvider(slow, { priority: 1 });
    await orch.registerProvider(fast, { priority: 2 });

    const response = await orch.complete(makeRequest());
    assert.equal(response.content, 'fast response');
  });

  test('per-request latency budget overrides default', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { failoverEnabled: true, maxFailoverAttempts: 2, defaultLatencyBudgetMs: 10_000 },
      },
    });
    const slow = new FakeProvider({ id: 'slow', latencyMs: 200 });
    const fast = new FakeProvider({ id: 'fast', content: 'fast' });
    await orch.registerProvider(slow, { priority: 1 });
    await orch.registerProvider(fast, { priority: 2 });

    const response = await orch.complete(makeRequest({ latencyBudgetMs: 50 }));
    assert.equal(response.content, 'fast');
  });
});

// ---------------------------------------------------------------------------
// Rate limiter tests
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  test('allows requests under the limit', () => {
    const limiter = new RateLimiter({ enabled: true, perUserPerMinute: 10, globalPerMinute: 100 });
    for (let i = 0; i < 5; i++) {
      limiter.check('user1');
    }
    assert.ok(true);
  });

  test('throws when per-user limit exceeded', () => {
    const limiter = new RateLimiter({ enabled: true, perUserPerMinute: 3, globalPerMinute: 100 });
    limiter.check('user1');
    limiter.check('user1');
    limiter.check('user1');
    assert.throws(() => limiter.check('user1'), AiError);
  });

  test('different users have independent limits', () => {
    const limiter = new RateLimiter({ enabled: true, perUserPerMinute: 2, globalPerMinute: 100 });
    limiter.check('user1');
    limiter.check('user1');
    limiter.check('user2');
    limiter.check('user2');
    assert.throws(() => limiter.check('user1'));
    assert.throws(() => limiter.check('user2'));
  });

  test('global limit applies across all users', () => {
    const limiter = new RateLimiter({ enabled: true, perUserPerMinute: 100, globalPerMinute: 2 });
    limiter.check('user1');
    limiter.check('user2');
    assert.throws(() => limiter.check('user3'));
  });

  test('disabled limiter never throws', () => {
    const limiter = new RateLimiter({ enabled: false });
    for (let i = 0; i < 1000; i++) {
      limiter.check('user1');
    }
    assert.ok(true);
  });

  test('no userId skips per-user check but still checks global', () => {
    const limiter = new RateLimiter({ enabled: true, perUserPerMinute: 1, globalPerMinute: 100 });
    limiter.check(); // no userId — should not throw
    limiter.check();
    assert.ok(true);
  });

  test('reset clears all buckets', () => {
    const limiter = new RateLimiter({ enabled: true, perUserPerMinute: 2, globalPerMinute: 2 });
    limiter.check('user1');
    limiter.check('user1');
    assert.throws(() => limiter.check('user1'));
    limiter.reset();
    limiter.check('user1'); // should not throw after reset
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// Health / circuit breaker tests
// ---------------------------------------------------------------------------

describe('Health & Circuit Breaker', () => {
  test('circuit opens after threshold failures', () => {
    const tracker = new HealthTracker(50, { failureThreshold: 3, resetTimeoutMs: 60_000, successThreshold: 2 });
    tracker.recordFailure('err1');
    tracker.recordFailure('err2');
    assert.equal(tracker.isCircuitOpen(), false);
    tracker.recordFailure('err3');
    assert.equal(tracker.isCircuitOpen(), true);
  });

  test('circuit does not open below threshold', () => {
    const tracker = new HealthTracker(50, { failureThreshold: 5, resetTimeoutMs: 60_000, successThreshold: 2 });
    tracker.recordFailure('err1');
    tracker.recordFailure('err2');
    assert.equal(tracker.isCircuitOpen(), false);
  });

  test('isCircuitOpen is a pure query (no side effects)', () => {
    const tracker = new HealthTracker(50, { failureThreshold: 1, resetTimeoutMs: 10, successThreshold: 1 });
    tracker.recordFailure('err');
    assert.equal(tracker.isCircuitOpen(), true);
    // Call again — should still be open (no implicit transition)
    assert.equal(tracker.isCircuitOpen(), true);
  });

  test('tryEnterHalfOpen returns false when reset timeout not elapsed', () => {
    const tracker = new HealthTracker(50, { failureThreshold: 1, resetTimeoutMs: 60_000, successThreshold: 1 });
    tracker.recordFailure('err');
    assert.equal(tracker.tryEnterHalfOpen(), false);
  });

  test('tryEnterHalfOpen returns true after reset timeout', async () => {
    const tracker = new HealthTracker(50, { failureThreshold: 1, resetTimeoutMs: 10, successThreshold: 1 });
    tracker.recordFailure('err');
    assert.equal(tracker.isCircuitOpen(), true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tracker.tryEnterHalfOpen(), true);
  });

  test('half-open: success closes circuit', async () => {
    const tracker = new HealthTracker(50, { failureThreshold: 1, resetTimeoutMs: 10, successThreshold: 1 });
    tracker.recordFailure('err');
    await new Promise((r) => setTimeout(r, 20));
    tracker.tryEnterHalfOpen();
    tracker.recordSuccess(10);
    assert.equal(tracker.isCircuitOpen(), false);
  });

  test('half-open: failure re-opens circuit', async () => {
    const tracker = new HealthTracker(50, { failureThreshold: 1, resetTimeoutMs: 10, successThreshold: 2 });
    tracker.recordFailure('err');
    await new Promise((r) => setTimeout(r, 20));
    tracker.tryEnterHalfOpen();
    tracker.recordFailure('probe failed');
    assert.equal(tracker.isCircuitOpen(), true);
  });

  test('half-open: requires successThreshold successes to close', async () => {
    const tracker = new HealthTracker(50, { failureThreshold: 2, resetTimeoutMs: 10, successThreshold: 3 });
    tracker.recordFailure('err');
    await new Promise((r) => setTimeout(r, 20));
    tracker.tryEnterHalfOpen();
    tracker.recordSuccess(10);
    assert.equal(tracker.isCircuitOpen(), false); // half-open allows probes
    tracker.recordSuccess(10);
    tracker.recordSuccess(10);
    // After 3 successes, circuit should be fully closed
    // Verify by failing again — should not immediately re-open with 1 failure
    tracker.recordFailure('err');
    assert.equal(tracker.isCircuitOpen(), false); // only 1 consecutive failure
  });

  test('health snapshot reflects state', () => {
    const tracker = new HealthTracker(50);
    tracker.recordSuccess(100);
    tracker.recordSuccess(200);
    const snap = tracker.snapshot('test');
    assert.equal(snap.state, 'healthy');
    assert.equal(snap.avgLatencyMs, 150);
    assert.equal(snap.successRate, 1);
  });

  test('health snapshot shows degraded after failure', () => {
    const tracker = new HealthTracker(50);
    tracker.recordSuccess(100);
    tracker.recordFailure('err');
    const snap = tracker.snapshot('test');
    assert.equal(snap.state, 'degraded');
  });

  test('reset clears all data', () => {
    const tracker = new HealthTracker(50);
    tracker.recordSuccess(100);
    tracker.recordFailure('err');
    tracker.reset();
    const snap = tracker.snapshot('test');
    assert.equal(snap.requestCount, 0);
    assert.equal(snap.consecutiveFailures, 0);
  });
});

// ---------------------------------------------------------------------------
// Grounding tests
// ---------------------------------------------------------------------------

describe('Grounding', () => {
  test('buildGroundedMessages inserts grounding after first system message', () => {
    const messages = [
      { role: 'system' as const, content: 'You are a chess coach.' },
      { role: 'user' as const, content: 'Explain this move.' },
    ];
    const grounded = buildGroundedMessages(messages, makeGrounding());
    assert.equal(grounded.length, 3);
    assert.equal(grounded[0].role, 'system');
    assert.equal(grounded[1].role, 'system');
    assert.equal(grounded[2].role, 'user');
    assert.ok(grounded[1].content.includes('FEN'));
  });

  test('buildGroundedMessages prepends grounding when no system message', () => {
    const messages = [
      { role: 'user' as const, content: 'Explain this move.' },
    ];
    const grounded = buildGroundedMessages(messages, makeGrounding());
    assert.equal(grounded.length, 2);
    assert.equal(grounded[0].role, 'system');
    assert.equal(grounded[1].role, 'user');
  });

  test('formatGrounding includes eval and best line', () => {
    const text = formatGrounding(makeGrounding());
    assert.ok(text.includes('Position FEN'));
    assert.ok(text.includes('Engine evaluation'));
    assert.ok(text.includes('Best line'));
    assert.ok(text.includes('e7e5'));
  });

  test('formatGrounding handles mate evaluation', () => {
    const text = formatGrounding({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      evalMate: 3,
    });
    assert.ok(text.includes('mate in 3'));
    assert.ok(text.includes('side to move wins'));
  });

  test('formatGrounding handles negative mate', () => {
    const text = formatGrounding({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      evalMate: -2,
    });
    assert.ok(text.includes('mate in 2'));
    assert.ok(text.includes('side to move loses'));
  });

  test('formatGrounding includes multiPv lines', () => {
    const text = formatGrounding({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      multiPv: [
        { pv: ['e2e4', 'e7e5'], evalCp: 20 },
        { pv: ['d2d4', 'd7d5'], evalCp: 10 },
      ],
    });
    assert.ok(text.includes('Alternative lines'));
    assert.ok(text.includes('e2e4 e7e5'));
    assert.ok(text.includes('d2d4 d7d5'));
  });

  test('formatGrounding includes legal moves', () => {
    const legalMoves = new Map<string, readonly string[]>([
      ['e2', ['e3', 'e4']],
      ['g1', ['f3', 'h3']],
    ]);
    const text = formatGrounding({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      legalMoves,
    });
    assert.ok(text.includes('Legal moves'));
    assert.ok(text.includes('e2'));
    assert.ok(text.includes('e3, e4'));
  });

  test('formatGrounding with minimal grounding (only FEN)', () => {
    const text = formatGrounding({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    });
    assert.ok(text.includes('Position FEN'));
    assert.ok(text.includes('Cite these facts'));
  });

  test('positionHash is deterministic', () => {
    const g = makeGrounding();
    assert.equal(positionHash(g), positionHash(g));
  });

  test('positionHash differs for different FEN', () => {
    const g1: EngineGrounding = { fen: 'aaa' };
    const g2: EngineGrounding = { fen: 'bbb' };
    assert.notEqual(positionHash(g1), positionHash(g2));
  });

  test('positionHash differs for different move', () => {
    const g1: EngineGrounding = { fen: 'aaa', moveUci: 'e2e4' };
    const g2: EngineGrounding = { fen: 'aaa', moveUci: 'd2d4' };
    assert.notEqual(positionHash(g1), positionHash(g2));
  });
});

// ---------------------------------------------------------------------------
// Orchestrator integration tests
// ---------------------------------------------------------------------------

describe('AiOrchestrator', () => {
  test('complete returns a response', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test', content: 'hello world' });
    await orch.registerProvider(provider);
    const response = await orch.complete(makeRequest());
    assert.equal(response.content, 'hello world');
    assert.equal(response.cached, false);
  });

  test('complete serves from cache on second call', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test', content: 'cached response' });
    await orch.registerProvider(provider);
    const r1 = await orch.complete(makeRequest());
    assert.equal(r1.cached, false);
    const r2 = await orch.complete(makeRequest());
    assert.equal(r2.cached, true);
    assert.equal(r2.content, 'cached response');
    assert.equal(orch.health().totalCacheHits, 1);
  });

  test('different requests are not cached together', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test', content: 'response' });
    await orch.registerProvider(provider);
    await orch.complete(makeRequest({ messages: [{ role: 'user', content: 'a' }] }));
    const r2 = await orch.complete(makeRequest({ messages: [{ role: 'user', content: 'b' }] }));
    assert.equal(r2.cached, false);
  });

  test('stream yields chunks', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test', content: 'streamed response' });
    await orch.registerProvider(provider);
    const chunks = [];
    for await (const chunk of orch.stream(makeRequest({ stream: true }))) {
      chunks.push(chunk);
    }
    assert.ok(chunks.length > 0);
    const doneChunk = chunks.find((c) => c.type === 'done');
    assert.ok(doneChunk);
  });

  test('stream error chunk on cancelled request', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test' });
    await orch.registerProvider(provider);
    const controller = new AbortController();
    controller.abort();
    const chunks = [];
    for await (const chunk of orch.stream(makeRequest({ stream: true, signal: controller.signal }))) {
      chunks.push(chunk);
    }
    const errorChunk = chunks.find((c) => c.type === 'error');
    assert.ok(errorChunk);
  });

  test('embed returns an embedding', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test' });
    await orch.registerProvider(provider);
    const response = await orch.embed({ input: 'test text' });
    assert.ok(response.embedding.length > 0);
    assert.equal(response.providerId, 'test');
  });

  test('embed fails over to next provider', async () => {
    const orch = new AiOrchestrator();
    const p1 = new FakeProvider({
      id: 'p1',
      capabilities: { supportsEmbeddings: true },
      failOnAttempt: 0,
      failWithError: new AiError('provider_error', 'injected failure', { retryable: true, providerId: 'p1' }),
    });
    const p2 = new FakeProvider({ id: 'p2', capabilities: { supportsEmbeddings: true } });
    await orch.registerProvider(p1, { priority: 1 });
    await orch.registerProvider(p2, { priority: 2 });
    const response = await orch.embed({ input: 'test' });
    assert.equal(response.providerId, 'p2');
  });

  test('embed throws when no embedding-capable provider', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test', capabilities: { supportsEmbeddings: false } });
    await orch.registerProvider(provider);
    await assert.rejects(orch.embed({ input: 'test' }), NoProviderError);
  });

  test('no providers throws NoProviderError', async () => {
    const orch = new AiOrchestrator();
    await assert.rejects(orch.complete(makeRequest()), NoProviderError);
  });

  test('cancelled request throws CancelledError', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test' });
    await orch.registerProvider(provider);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      orch.complete(makeRequest({ signal: controller.signal })),
      CancelledError,
    );
  });

  test('provider timeout aborts the in-flight provider request before failover', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        routing: { defaultLatencyBudgetMs: 5, maxFailoverAttempts: 1 },
      },
    });
    const provider = new FakeProvider({ id: 'slow', latencyMs: 100 });
    await orch.registerProvider(provider);
    await assert.rejects(orch.complete(makeRequest()), /timed out/i);
    assert.equal(provider.calls[0]!.signal?.aborted, true);
  });

  test('AI rate limiter evicts inactive user buckets', () => {
    let now = 0;
    const limiter = new RateLimiter(
      { enabled: true, perUserPerMinute: 1000, globalPerMinute: 1_000_000 },
      () => now,
    );
    for (let i = 0; i < 500; i++) limiter.check(`old-${i}`);
    assert.equal(limiter.size, 500);
    now = 61_000;
    for (let i = 0; i < 500; i++) limiter.check(`new-${i}`);
    assert.equal(limiter.size, 500);
  });

  test('health returns orchestrator stats', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test' });
    await orch.registerProvider(provider);
    await orch.complete(makeRequest());
    const health = orch.health();
    assert.equal(health.totalRequests, 1);
    assert.equal(health.providers.length, 1);
  });

  test('clearCache empties the cache', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'test', content: 'cached' });
    await orch.registerProvider(provider);
    await orch.complete(makeRequest());
    orch.clearCache();
    const r2 = await orch.complete(makeRequest());
    assert.equal(r2.cached, false);
  });

  test('disabled cache does not cache', async () => {
    const orch = new AiOrchestrator({
      config: { providers: [], cache: { enabled: false } },
    });
    const provider = new FakeProvider({ id: 'test', content: 'no cache' });
    await orch.registerProvider(provider);
    await orch.complete(makeRequest());
    const r2 = await orch.complete(makeRequest());
    assert.equal(r2.cached, false);
    assert.equal(orch.health().totalCacheHits, 0);
  });

  test('custom cache can be injected', async () => {
    const customCache = new InMemoryLruCache(10, 60_000);
    const orch = new AiOrchestrator({ cache: customCache });
    const provider = new FakeProvider({ id: 'test', content: 'custom' });
    await orch.registerProvider(provider);
    await orch.complete(makeRequest());
    assert.equal(customCache.size, 1);
  });

  test('circuit breaker config is passed to registry', async () => {
    const orch = new AiOrchestrator({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000, successThreshold: 1 },
      },
    });
    const provider = new FakeProvider({ id: 'test' });
    await orch.registerProvider(provider);
    // Record 2 failures to open the circuit
    orch.registry.recordFailure('test', 'err1');
    orch.registry.recordFailure('test', 'err2');
    assert.equal(orch.registry.isCircuitOpen('test'), true);
  });
});

// ---------------------------------------------------------------------------
// Benchmark tests (acceptance criterion: benchmark report)
// ---------------------------------------------------------------------------

describe('Benchmark', () => {
  test('BenchmarkRunner produces a report', async () => {
    const runner = new BenchmarkRunner({ warmupIterations: 0, measuredIterations: 1, timeoutMs: 5_000 });
    const provider = new FakeProvider({ id: 'bench', content: 'The Sicilian Defense starts with 1.e4 c5 and is popular because it creates asymmetry.' });
    const report = await runner.run(CHESS_BENCHMARK_TASKS, [provider]);
    assert.ok(report.results.length > 0);
    assert.ok(report.summary.length > 0);
    const summary = report.summary[0];
    assert.equal(summary.providerId, 'bench');
    assert.ok(summary.successRate > 0);
  });

  test('CHESS_BENCHMARK_TASKS has at least 3 tasks', () => {
    assert.ok(CHESS_BENCHMARK_TASKS.length >= 3);
  });

  test('benchmark handles provider failures gracefully', async () => {
    const runner = new BenchmarkRunner({ warmupIterations: 0, measuredIterations: 1, timeoutMs: 5_000 });
    const provider = new FakeProvider({ id: 'failing', failOnAttempt: 0 });
    const report = await runner.run(CHESS_BENCHMARK_TASKS.slice(0, 1), [provider]);
    assert.ok(report.results.length > 0);
    const failed = report.results.find((r) => !r.success);
    assert.ok(failed);
    assert.ok(failed!.errorMessage);
  });

  test('benchmark quality score matches expected fragments', async () => {
    const runner = new BenchmarkRunner({ warmupIterations: 0, measuredIterations: 1, timeoutMs: 5_000 });
    const provider = new FakeProvider({
      id: 'quality',
      content: 'The sicilian defense is played with c5 and is good for black.',
    });
    const report = await runner.run(
      [CHESS_BENCHMARK_TASKS[2]], // general-knowledge task
      [provider],
    );
    const result = report.results[0];
    assert.ok(result.qualityScore > 0);
  });

  test('benchmark summary aggregates correctly', async () => {
    const runner = new BenchmarkRunner({ warmupIterations: 0, measuredIterations: 2, timeoutMs: 5_000 });
    const provider = new FakeProvider({ id: 'agg' });
    const report = await runner.run(CHESS_BENCHMARK_TASKS.slice(0, 1), [provider]);
    const summary = report.summary[0];
    assert.equal(summary.taskCount, 2);
    assert.equal(summary.successRate, 1);
  });
});

// ---------------------------------------------------------------------------
// Engine-grounded move explanation (acceptance criterion)
// ---------------------------------------------------------------------------

describe('Engine-Grounded Move Explanation', () => {
  test('grounded request includes engine facts in the prompt', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'grounded', content: 'This move is weak because it exposes the king.' });
    await orch.registerProvider(provider);

    const request = makeRequest({
      task: 'explanation',
      messages: [{ role: 'user', content: 'Explain the move f3.' }],
      grounding: makeGrounding(),
    });

    const response = await orch.complete(request);
    assert.ok(response.content);

    // Verify the provider received grounded messages
    const call = provider.calls[0];
    assert.ok(call.messages.length > 1);
    const systemMsg = call.messages.find((m) => m.role === 'system' && m.content.includes('FEN'));
    assert.ok(systemMsg, 'Grounding system message should be present');
  });

  test('grounded request with system message inserts grounding after it', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'grounded-sys' });
    await orch.registerProvider(provider);

    const request = makeRequest({
      messages: [
        { role: 'system', content: 'You are a chess coach.' },
        { role: 'user', content: 'Explain.' },
      ],
      grounding: makeGrounding(),
    });

    await orch.complete(request);
    const call = provider.calls[0];
    assert.equal(call.messages[0].role, 'system');
    assert.equal(call.messages[0].content, 'You are a chess coach.');
    assert.equal(call.messages[1].role, 'system');
    assert.ok(call.messages[1].content.includes('FEN'));
  });

  test('non-grounded request does not add grounding messages', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'no-ground' });
    await orch.registerProvider(provider);

    await orch.complete(makeRequest());
    const call = provider.calls[0];
    const systemMsgs = call.messages.filter((m) => m.role === 'system');
    assert.equal(systemMsgs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent requests
// ---------------------------------------------------------------------------

describe('Concurrent Requests', () => {
  test('multiple concurrent complete() calls succeed', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'concurrent', content: 'concurrent ok' });
    await orch.registerProvider(provider);

    const requests = Array.from({ length: 5 }, () =>
      orch.complete(makeRequest({ messages: [{ role: 'user', content: `req-${Math.random()}` }] })),
    );
    const responses = await Promise.all(requests);
    assert.equal(responses.length, 5);
    for (const r of responses) {
      assert.equal(r.content, 'concurrent ok');
    }
  });

  test('concurrent requests with different content are not cross-cached', async () => {
    const orch = new AiOrchestrator();
    const provider = new FakeProvider({ id: 'concurrent-cache', content: 'same' });
    await orch.registerProvider(provider);

    const requests = Array.from({ length: 3 }, (_, i) =>
      orch.complete(makeRequest({ messages: [{ role: 'user', content: `unique-${i}` }] })),
    );
    await Promise.all(requests);
    // Second round with same content should be cached
    const r = await orch.complete(makeRequest({ messages: [{ role: 'user', content: 'unique-0' }] }));
    assert.equal(r.cached, true);
  });
});
