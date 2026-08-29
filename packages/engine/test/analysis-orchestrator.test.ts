import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnalysisOrchestrator,
  type AnalysisOrchestrationEvent,
  type AnalysisOrchestrationObserver,
} from '../src/analysis-orchestrator.js';
import { InMemoryLruCache, type AnalysisCache, type AnalysisKey, type CacheMeta } from '../src/cache.js';
import { CancelledError, ProtocolError } from '../src/errors.js';
import type { AnalysisLimits, EngineResult } from '../src/types.js';
import { flush, ManualClock } from './helpers.js';

const KEY: AnalysisKey = {
  fingerprint: 'stockfish-16-default',
  fen: 'position-a',
  variant: 'chess',
  multiPv: 1,
};
const LIMITS: AnalysisLimits = { depth: 20 };
const ANALYSIS: readonly EngineResult[] = [
  {
    multipv: 1,
    evaluation: { type: 'cp', value: 20 },
    principalVariation: ['e2e4'],
    depth: 20,
    nodes: 1000,
    nps: 5000,
    timeMs: 100,
  },
];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class MissCache implements AnalysisCache {
  getCalls = 0;
  setCalls = 0;

  async get(): Promise<undefined> {
    this.getCalls += 1;
    return undefined;
  }

  async set(_key: AnalysisKey, _value: readonly EngineResult[], _meta: CacheMeta): Promise<void> {
    this.setCalls += 1;
  }
}

class RecordingObserver implements AnalysisOrchestrationObserver {
  readonly events: AnalysisOrchestrationEvent[] = [];

  record(event: AnalysisOrchestrationEvent): void {
    this.events.push(event);
  }

  count(type: AnalysisOrchestrationEvent['type']): number {
    return this.events.filter((event) => event.type === type).length;
  }
}

describe('AnalysisOrchestrator single-flight', () => {
  it('coalesces 100 equivalent misses into one engine computation', async () => {
    const cache = new MissCache();
    const observer = new RecordingObserver();
    const orchestrator = new AnalysisOrchestrator({ cache, observer });
    const engine = deferred<readonly EngineResult[]>();
    let engineCalls = 0;

    const requests = Array.from({ length: 100 }, () =>
      orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        execute: () => {
          engineCalls += 1;
          return engine.promise;
        },
      }),
    );
    await flush();

    assert.equal(engineCalls, 1);
    engine.resolve(ANALYSIS);
    const responses = await Promise.all(requests);
    for (const response of responses) assert.deepEqual(response, ANALYSIS);
    assert.equal(cache.setCalls, 1);
    assert.equal(observer.count('cache_miss'), 1);
    assert.equal(observer.count('engine_computation_started'), 1);
    assert.equal(observer.count('engine_computation_completed'), 1);
    assert.equal(observer.count('cache_write_completed'), 1);
    assert.equal(observer.count('request_coalesced'), 99);
  });

  it('shares a cache-read reservation until the corresponding flight retires', async () => {
    const delayedSnapshot = deferred<void>();
    let stored: readonly EngineResult[] | undefined;
    let getCalls = 0;
    const cache: AnalysisCache = {
      get: async () => {
        getCalls += 1;
        const snapshot = stored;
        if (getCalls > 1) await delayedSnapshot.promise;
        return snapshot;
      },
      set: async (_key, value) => {
        stored = value;
      },
    };
    const orchestrator = new AnalysisOrchestrator({ cache });
    const firstEngine = deferred<readonly EngineResult[]>();
    let engineCalls = 0;
    const execute = (): Promise<readonly EngineResult[]> => {
      engineCalls += 1;
      return engineCalls === 1 ? firstEngine.promise : Promise.resolve(ANALYSIS);
    };

    const first = orchestrator.analyze({ key: KEY, limits: LIMITS, execute });
    await flush();
    const second = orchestrator.analyze({ key: KEY, limits: LIMITS, execute });
    await flush();

    firstEngine.resolve(ANALYSIS);
    assert.deepEqual(await first, ANALYSIS);
    delayedSnapshot.resolve(undefined);
    assert.deepEqual(await second, ANALYSIS);
    assert.equal(getCalls, 1, 'the follower must join before starting a stale snapshot read');
    assert.equal(engineCalls, 1);
  });

  it('runs 50 requests for each of two positions independently', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const engines = new Map([
      ['position-a', deferred<readonly EngineResult[]>()],
      ['position-b', deferred<readonly EngineResult[]>()],
    ]);
    const engineCalls = new Map<string, number>();
    const requestFor = (fen: string): Promise<readonly EngineResult[]> =>
      orchestrator.analyze({
        key: { ...KEY, fen },
        limits: LIMITS,
        execute: () => {
          engineCalls.set(fen, (engineCalls.get(fen) ?? 0) + 1);
          return engines.get(fen)!.promise;
        },
      });

    const requestsA = Array.from({ length: 50 }, () => requestFor('position-a'));
    const requestsB = Array.from({ length: 50 }, () => requestFor('position-b'));
    await flush();

    assert.deepEqual(Object.fromEntries(engineCalls), { 'position-a': 1, 'position-b': 1 });
    engines.get('position-a')!.resolve(ANALYSIS);
    const analysisB = [{ ...ANALYSIS[0], evaluation: { type: 'cp' as const, value: -15 } }];
    engines.get('position-b')!.resolve(analysisB);
    for (const response of await Promise.all(requestsA)) assert.deepEqual(response, ANALYSIS);
    for (const response of await Promise.all(requestsB)) assert.deepEqual(response, analysisB);
  });

  const identityDifferences: readonly (readonly [string, AnalysisKey, AnalysisLimits])[] = [
    ['fingerprint', { ...KEY, fingerprint: 'stockfish-17-default' }, LIMITS],
    ['variant', { ...KEY, variant: 'chess960' }, LIMITS],
    ['multiPv', { ...KEY, multiPv: 2 }, LIMITS],
    ['depth', KEY, { depth: 21 }],
    ['nodes', KEY, { nodes: 1000 }],
    ['time', KEY, { timeMs: 1000 }],
  ];

  for (const [difference, otherKey, otherLimits] of identityDifferences) {
    it(`does not coalesce requests that differ by ${difference}`, async () => {
      const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
      const engine = deferred<readonly EngineResult[]>();
      let engineCalls = 0;
      const execute = (): Promise<readonly EngineResult[]> => {
        engineCalls += 1;
        return engine.promise;
      };

      const first = orchestrator.analyze({ key: KEY, limits: LIMITS, execute });
      const second = orchestrator.analyze({ key: otherKey, limits: otherLimits, execute });
      await flush();

      assert.equal(engineCalls, 2);
      engine.resolve(ANALYSIS);
      await Promise.all([first, second]);
    });
  }

  it('does not coalesce requests across scheduler priority classes', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const engine = deferred<readonly EngineResult[]>();
    let engineCalls = 0;
    const execute = (): Promise<readonly EngineResult[]> => {
      engineCalls += 1;
      return engine.promise;
    };

    const background = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      priorityClass: 3,
      execute,
    });
    const live = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      priorityClass: 1,
      execute,
    });
    await flush();

    assert.equal(engineCalls, 2);
    engine.resolve(ANALYSIS);
    await Promise.all([background, live]);
  });

  it('removes a failed flight so the next request retries', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const failedEngine = deferred<readonly EngineResult[]>();
    let engineCalls = 0;
    const execute = (): Promise<readonly EngineResult[]> => {
      engineCalls += 1;
      return failedEngine.promise;
    };
    const requests = Array.from({ length: 20 }, () =>
      orchestrator.analyze({ key: KEY, limits: LIMITS, execute }),
    );
    await flush();

    failedEngine.reject(new Error('engine unavailable'));
    const failures = await Promise.allSettled(requests);
    assert.ok(failures.every((failure) => failure.status === 'rejected'));

    const retried = await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => {
        engineCalls += 1;
        return ANALYSIS;
      },
    });
    assert.equal(engineCalls, 2);
    assert.deepEqual(retried, ANALYSIS);
  });

  it('removes a completed flight so a later miss starts fresh work', async () => {
    const cache = new MissCache();
    const orchestrator = new AnalysisOrchestrator({ cache });
    let engineCalls = 0;
    const execute = async (): Promise<readonly EngineResult[]> => {
      engineCalls += 1;
      return ANALYSIS;
    };

    await orchestrator.analyze({ key: KEY, limits: LIMITS, execute });
    await orchestrator.analyze({ key: KEY, limits: LIMITS, execute });

    assert.equal(engineCalls, 2);
    assert.equal(cache.setCalls, 2);
  });
});

describe('AnalysisOrchestrator cache failures', () => {
  it('returns a valid cache hit without starting engine work', async () => {
    const cache = new InMemoryLruCache(10);
    const observer = new RecordingObserver();
    await cache.set(KEY, ANALYSIS, { limits: LIMITS });
    const orchestrator = new AnalysisOrchestrator({ cache, observer });
    let engineCalls = 0;

    const response = await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => {
        engineCalls += 1;
        return ANALYSIS;
      },
    });

    assert.deepEqual(response, ANALYSIS);
    assert.equal(engineCalls, 0);
    assert.equal(observer.count('cache_hit'), 1);
  });

  it('fails open after cache read failures and still coalesces engine work', async () => {
    const cache: AnalysisCache = {
      get: async () => {
        throw new Error('cache offline');
      },
      set: async () => undefined,
    };
    const observer = new RecordingObserver();
    const orchestrator = new AnalysisOrchestrator({ cache, observer });
    const engine = deferred<readonly EngineResult[]>();
    let engineCalls = 0;
    const requests = Array.from({ length: 25 }, () =>
      orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        execute: () => {
          engineCalls += 1;
          return engine.promise;
        },
      }),
    );
    await flush();

    assert.equal(engineCalls, 1);
    engine.resolve(ANALYSIS);
    assert.equal((await Promise.all(requests)).length, 25);
    assert.equal(observer.count('cache_read_failure'), 1);
  });

  it('returns valid engine results when the cache write fails', async () => {
    const cache: AnalysisCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error('cache read-only');
      },
    };
    const observer = new RecordingObserver();
    const orchestrator = new AnalysisOrchestrator({ cache, observer });

    const response = await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => ANALYSIS,
    });

    assert.deepEqual(response, ANALYSIS);
    assert.equal(observer.count('cache_write_failure'), 1);
  });

  const malformedCacheValues: readonly (readonly [string, unknown])[] = [
    ['an empty analysis', []],
    ['a sparse analysis array', new Array<EngineResult>(1)],
    ['a non-array payload', { multipv: 1 }],
    ['a misordered MultiPV set', [{ ...ANALYSIS[0], multipv: 2 }]],
    ['a negative node count', [{ ...ANALYSIS[0], nodes: -1 }]],
    ['a sparse principal variation', [{ ...ANALYSIS[0], principalVariation: new Array<string>(1) }]],
  ];

  for (const [description, malformed] of malformedCacheValues) {
    it(`treats ${description} from cache as a rejected entry, not a hit`, async () => {
      const cache: AnalysisCache = {
        get: async () => malformed as readonly EngineResult[],
        set: async () => undefined,
      };
      const observer = new RecordingObserver();
      const orchestrator = new AnalysisOrchestrator({ cache, observer });
      let engineCalls = 0;

      const response = await orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        execute: async () => {
          engineCalls += 1;
          return ANALYSIS;
        },
      });

      assert.deepEqual(response, ANALYSIS);
      assert.equal(engineCalls, 1);
      assert.equal(observer.count('cache_result_rejected'), 1);
      assert.equal(observer.count('cache_hit'), 0);
    });
  }

  it('contains an observer failure so telemetry cannot fail analysis', async () => {
    const observer: AnalysisOrchestrationObserver = {
      record: () => {
        throw new Error('metrics backend unavailable');
      },
    };
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache(), observer });

    const response = await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => ANALYSIS,
    });

    assert.deepEqual(response, ANALYSIS);
  });

  it('reports lookup, engine, and write latency without key or request labels', async () => {
    const clock = new ManualClock();
    const observer = new RecordingObserver();
    const cache: AnalysisCache = {
      get: async () => {
        clock.advance(2);
        return undefined;
      },
      set: async () => {
        clock.advance(3);
      },
    };
    const orchestrator = new AnalysisOrchestrator({ cache, clock, observer });

    await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => {
        clock.advance(5);
        return ANALYSIS;
      },
    });

    assert.deepEqual(observer.events, [
      { type: 'cache_miss', durationMs: 2 },
      { type: 'engine_computation_started' },
      { type: 'engine_computation_completed', durationMs: 5 },
      { type: 'cache_write_completed', durationMs: 3 },
    ]);
  });

  it('rejects malformed engine output without caching it and permits a clean retry', async () => {
    const cache = new MissCache();
    const observer = new RecordingObserver();
    const orchestrator = new AnalysisOrchestrator({ cache, observer });

    await assert.rejects(
      orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        execute: async () => [] as readonly EngineResult[],
      }),
      ProtocolError,
    );
    const retried = await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => ANALYSIS,
    });

    assert.deepEqual(retried, ANALYSIS);
    assert.equal(cache.setCalls, 1);
    assert.equal(observer.count('inflight_computation_failure'), 1);
  });

  for (const [description, malformed] of [
    ['a sparse analysis array', new Array<EngineResult>(1)],
    ['a sparse principal variation', [{ ...ANALYSIS[0], principalVariation: new Array<string>(1) }]],
  ] as const) {
    it(`rejects ${description} from the engine without caching it`, async () => {
      const cache = new MissCache();
      const orchestrator = new AnalysisOrchestrator({ cache });

      await assert.rejects(
        orchestrator.analyze({
          key: KEY,
          limits: LIMITS,
          execute: async () => malformed,
        }),
        ProtocolError,
      );
      assert.equal(cache.setCalls, 0);
    });
  }
});

describe('AnalysisOrchestrator cancellation', () => {
  it('lets a follower cancel without aborting work needed by the first caller', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const engine = deferred<readonly EngineResult[]>();
    const followerController = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const execute = (signal: AbortSignal): Promise<readonly EngineResult[]> => {
      sharedSignal = signal;
      return engine.promise;
    };

    const first = orchestrator.analyze({ key: KEY, limits: LIMITS, execute });
    const follower = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      signal: followerController.signal,
      execute,
    });
    await flush();
    followerController.abort();
    engine.resolve(ANALYSIS);

    await assert.rejects(follower, CancelledError);
    assert.deepEqual(await first, ANALYSIS);
    assert.equal(sharedSignal?.aborted, false);
  });

  it('does not give the first caller ownership of a shared computation', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const engine = deferred<readonly EngineResult[]>();
    const firstController = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const execute = (signal: AbortSignal): Promise<readonly EngineResult[]> => {
      sharedSignal = signal;
      return engine.promise;
    };

    const first = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      signal: firstController.signal,
      execute,
    });
    const follower = orchestrator.analyze({ key: KEY, limits: LIMITS, execute });
    await flush();
    firstController.abort();
    engine.resolve(ANALYSIS);

    await assert.rejects(first, CancelledError);
    assert.deepEqual(await follower, ANALYSIS);
    assert.equal(sharedSignal?.aborted, false);
  });

  it('aborts the shared engine signal when every consumer cancels', async () => {
    const observer = new RecordingObserver();
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache(), observer });
    const engine = deferred<readonly EngineResult[]>();
    const controllers = [new AbortController(), new AbortController()];
    let sharedSignal: AbortSignal | undefined;
    const execute = (signal: AbortSignal): Promise<readonly EngineResult[]> => {
      sharedSignal = signal;
      signal.addEventListener('abort', () => engine.reject(new CancelledError()), { once: true });
      return engine.promise;
    };
    const requests = controllers.map((controller) =>
      orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        signal: controller.signal,
        execute,
      }),
    );
    await flush();

    controllers.forEach((controller) => controller.abort());
    const sharedWasAborted = sharedSignal?.aborted ?? false;
    if (!sharedWasAborted) engine.reject(new CancelledError());
    const outcomes = await Promise.allSettled(requests);

    assert.equal(sharedWasAborted, true);
    assert.ok(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason instanceof CancelledError));
    assert.equal(observer.count('cancellation'), 3, 'two consumers and the abandoned shared flight');
  });

  it('caches a valid result if an engine ignores the all-consumer abort and still completes', async () => {
    const cache = new MissCache();
    const orchestrator = new AnalysisOrchestrator({ cache });
    const engine = deferred<readonly EngineResult[]>();
    const controllers = [new AbortController(), new AbortController()];
    let sharedSignal: AbortSignal | undefined;
    const requests = controllers.map((controller) =>
      orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        signal: controller.signal,
        execute: (signal) => {
          sharedSignal = signal;
          return engine.promise;
        },
      }),
    );
    await flush();

    controllers.forEach((controller) => controller.abort());
    engine.resolve(ANALYSIS);
    const outcomes = await Promise.allSettled(requests);
    await flush();

    assert.equal(sharedSignal?.aborted, true);
    assert.ok(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason instanceof CancelledError));
    assert.equal(cache.setCalls, 1);
  });

  it('returns a completed result when completion wins the cancellation race', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const engine = deferred<readonly EngineResult[]>();
    const controller = new AbortController();
    const request = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      signal: controller.signal,
      execute: () => engine.promise,
    });
    await flush();

    engine.resolve(ANALYSIS);
    await flush();
    controller.abort();

    assert.deepEqual(await request, ANALYSIS);
  });

  it('rejects a pre-cancelled request before cache or engine work', async () => {
    const cache = new MissCache();
    const orchestrator = new AnalysisOrchestrator({ cache });
    const controller = new AbortController();
    controller.abort();
    let engineCalls = 0;

    await assert.rejects(
      orchestrator.analyze({
        key: KEY,
        limits: LIMITS,
        signal: controller.signal,
        execute: async () => {
          engineCalls += 1;
          return ANALYSIS;
        },
      }),
      CancelledError,
    );

    assert.equal(cache.getCalls, 0);
    assert.equal(engineCalls, 0);
  });

  it('rejects cancellation observed during cache lookup before starting engine work', async () => {
    const lookup = deferred<readonly EngineResult[] | undefined>();
    const cache: AnalysisCache = {
      get: () => lookup.promise,
      set: async () => undefined,
    };
    const observer = new RecordingObserver();
    const orchestrator = new AnalysisOrchestrator({ cache, observer });
    const controller = new AbortController();
    let engineCalls = 0;
    const request = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      signal: controller.signal,
      execute: async () => {
        engineCalls += 1;
        return ANALYSIS;
      },
    });

    controller.abort();
    lookup.resolve(undefined);

    await assert.rejects(request, CancelledError);
    assert.equal(engineCalls, 0);
    assert.deepEqual(
      observer.events.filter((event) => event.type === 'cancellation'),
      [
        { type: 'cancellation', scope: 'consumer' },
        { type: 'cancellation', scope: 'shared' },
      ],
      'the ownerless shared promise must not report a second consumer cancellation',
    );
  });

  it('removes an abandoned flight before an engine that ignores abort settles', async () => {
    const orchestrator = new AnalysisOrchestrator({ cache: new MissCache() });
    const ignoredEngine = deferred<readonly EngineResult[]>();
    const controller = new AbortController();
    let engineCalls = 0;
    const abandoned = orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      signal: controller.signal,
      execute: async () => {
        engineCalls += 1;
        return ignoredEngine.promise;
      },
    });
    await flush();
    controller.abort();

    const replacement = await orchestrator.analyze({
      key: KEY,
      limits: LIMITS,
      execute: async () => {
        engineCalls += 1;
        return ANALYSIS;
      },
    });
    ignoredEngine.resolve(ANALYSIS);
    await assert.rejects(abandoned, CancelledError);

    assert.deepEqual(replacement, ANALYSIS);
    assert.equal(engineCalls, 2);
  });
});
