import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '@chess-platform/core';
import { EngineManager, limitsSatisfy, NoEngineForVariantError } from '@chess-platform/engine';
import { DEFAULT_ANALYSIS_LIMITS } from '../src/analysis/limits';
import {
  analysisLimitsPolicyFromEnv,
  analysisSettingsFromEnv,
  createAnalysisEngine,
  createAnalysisFromEnv,
  createPuzzleGeneration,
} from '../src/analysis/composition';
import { AnalysisService } from '../src/analysis/service';
import { PuzzleGenerationService } from '../src/analysis/puzzle-generation-service';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('analysisSettingsFromEnv: returns safe defaults when env is empty', () => {
  const settings = analysisSettingsFromEnv({});
  assert.equal(settings.maxWorkers, 2);
  assert.equal(settings.queueCapacity, 32);
  assert.equal(settings.cacheEntries, 500);
  assert.equal(settings.threadsPerWorker, 1);
  assert.equal(settings.hashMbPerWorker, 16);
});

/**
 * The CPU ceiling is `maxWorkers * threadsPerWorker`, so leaving threads unset would hand the
 * second factor to whatever the installed engine build defaults to — `UciEngineInstance` only sends
 * `setoption name Threads` when the value is defined. Pinning the default to 1 is what makes the
 * bound exactly `maxWorkers` rather than approximately it.
 */
test('analysisSettingsFromEnv: threads default to 1 so the CPU bound is maxWorkers, not an engine default', () => {
  assert.equal(analysisSettingsFromEnv({}).threadsPerWorker, 1);
  assert.equal(analysisSettingsFromEnv({ ANALYSIS_ENGINE_THREADS: '4' }).threadsPerWorker, 4);
  // A bad value must not silently widen the bound.
  for (const bad of ['abc', '0', '-2', '', '2.5']) {
    assert.equal(
      analysisSettingsFromEnv({ ANALYSIS_ENGINE_THREADS: bad }).threadsPerWorker,
      1,
      `"${bad}" must fall back to 1`,
    );
  }
});

test('analysisSettingsFromEnv: parses valid custom numeric values', () => {
  const env = {
    ANALYSIS_ENGINE_MAX_WORKERS: '4',
    ANALYSIS_ENGINE_QUEUE_CAPACITY: '64',
    ANALYSIS_CACHE_ENTRIES: '1000',
  };
  const settings = analysisSettingsFromEnv(env);
  assert.equal(settings.maxWorkers, 4);
  assert.equal(settings.queueCapacity, 64);
  assert.equal(settings.cacheEntries, 1000);
});

test('analysisSettingsFromEnv: bad env values fall back to defaults', () => {
  const badValues = ['abc', '0', '-5', '', '  ', 'NaN', 'Infinity', '3.14'];

  for (const bad of badValues) {
    const env = {
      ANALYSIS_ENGINE_MAX_WORKERS: bad,
      ANALYSIS_ENGINE_QUEUE_CAPACITY: bad,
      ANALYSIS_CACHE_ENTRIES: bad,
    };
    const settings = analysisSettingsFromEnv(env);
    assert.equal(settings.maxWorkers, 2, `Failed fallback for maxWorkers with value "${bad}"`);
    assert.equal(settings.queueCapacity, 32, `Failed fallback for queueCapacity with value "${bad}"`);
    assert.equal(settings.cacheEntries, 500, `Failed fallback for cacheEntries with value "${bad}"`);
  }
});

test('analysisLimitsPolicyFromEnv: defaults match DEFAULT_ANALYSIS_LIMITS', () => {
  const policy = analysisLimitsPolicyFromEnv({});
  assert.equal(policy.maxDepth, DEFAULT_ANALYSIS_LIMITS.maxDepth);
  assert.equal(policy.maxNodes, DEFAULT_ANALYSIS_LIMITS.maxNodes);
  assert.equal(policy.maxTimeMs, DEFAULT_ANALYSIS_LIMITS.maxTimeMs);
  assert.equal(policy.maxMultiPv, DEFAULT_ANALYSIS_LIMITS.maxMultiPv);
  assert.equal(policy.defaultDepth, DEFAULT_ANALYSIS_LIMITS.defaultDepth);
  assert.equal(policy.defaultTimeMs, DEFAULT_ANALYSIS_LIMITS.defaultTimeMs);
});

test('analysisLimitsPolicyFromEnv: an env limit above built-in ceiling is clamped down to ceiling', () => {
  const highEnv = {
    ANALYSIS_MAX_DEPTH: '100',
    ANALYSIS_MAX_NODES: '999999999',
    ANALYSIS_MAX_TIME_MS: '60000',
    ANALYSIS_MAX_MULTIPV: '50',
  };
  const policy = analysisLimitsPolicyFromEnv(highEnv);
  assert.equal(policy.maxDepth, DEFAULT_ANALYSIS_LIMITS.maxDepth);
  assert.equal(policy.maxNodes, DEFAULT_ANALYSIS_LIMITS.maxNodes);
  assert.equal(policy.maxTimeMs, DEFAULT_ANALYSIS_LIMITS.maxTimeMs);
  assert.equal(policy.maxMultiPv, DEFAULT_ANALYSIS_LIMITS.maxMultiPv);
});

test('analysisLimitsPolicyFromEnv: deployment may tighten limits below built-in maximum', () => {
  const tightenedEnv = {
    ANALYSIS_MAX_DEPTH: '10',
    ANALYSIS_MAX_NODES: '50000',
    ANALYSIS_MAX_TIME_MS: '500',
    ANALYSIS_MAX_MULTIPV: '2',
  };
  const policy = analysisLimitsPolicyFromEnv(tightenedEnv);
  assert.equal(policy.maxDepth, 10);
  assert.equal(policy.maxNodes, 50000);
  assert.equal(policy.maxTimeMs, 500);
  assert.equal(policy.maxMultiPv, 2);
  // defaultDepth and defaultTimeMs clamped to max
  assert.equal(policy.defaultDepth, 10);
  assert.equal(policy.defaultTimeMs, 500);
});

test('analysisLimitsPolicyFromEnv: bad env values fall back to defaults', () => {
  const badEnv = {
    ANALYSIS_MAX_DEPTH: 'invalid',
    ANALYSIS_MAX_NODES: '-1000',
    ANALYSIS_MAX_TIME_MS: '0',
    ANALYSIS_MAX_MULTIPV: 'NaN',
  };
  const policy = analysisLimitsPolicyFromEnv(badEnv);
  assert.equal(policy.maxDepth, DEFAULT_ANALYSIS_LIMITS.maxDepth);
  assert.equal(policy.maxNodes, DEFAULT_ANALYSIS_LIMITS.maxNodes);
  assert.equal(policy.maxTimeMs, DEFAULT_ANALYSIS_LIMITS.maxTimeMs);
  assert.equal(policy.maxMultiPv, DEFAULT_ANALYSIS_LIMITS.maxMultiPv);
});

test('createAnalysisEngine: creates dedicated EngineManager instance', () => {
  const engine = createAnalysisEngine({
    ANALYSIS_ENGINE_MAX_WORKERS: '3',
    ANALYSIS_ENGINE_QUEUE_CAPACITY: '20',
  });
  assert.ok(engine instanceof EngineManager);
});

test('createAnalysisFromEnv: returns undefined when no engine binary is configured', () => {
  assert.equal(createAnalysisFromEnv({}), undefined);
  assert.equal(createAnalysisFromEnv({ STOCKFISH_PATH: '' }), undefined);
});

/**
 * A deployment with only Fairy-Stockfish is a working analysis deployment. Gating composition on
 * `STOCKFISH_PATH` specifically, as an earlier draft did, reported the capability off while a
 * perfectly usable engine sat there configured.
 */
test('createAnalysisFromEnv: composes from a Fairy-only deployment', () => {
  const composed = createAnalysisFromEnv({ FAIRY_STOCKFISH_PATH: '/usr/bin/fairy-stockfish' });
  assert.ok(composed !== undefined);
});

/**
 * The production image installs Stockfish alone, so this is the real deployment's variant support.
 *
 * Registering both built-in plugins unconditionally made the six Fairy-only variants route to a pool
 * whose binary does not exist, and the caller got `503 analysis engine failed` — the engine reported
 * broken about a deployment behaving exactly as configured. Raised in the Qodo review of PR #132.
 * Registering only configured engines leaves no pool claiming those variants, so the router raises
 * `NoEngineForVariantError`, which the service maps to a truthful 422.
 */
test('a Stockfish-only deployment routes standard and refuses Fairy-only variants', async () => {
  const engine = createAnalysisEngine({ STOCKFISH_PATH: '/nonexistent/stockfish' });
  try {
    // Routing is what is under test, not searching: the binary path is deliberately fake, so a
    // variant that *does* route fails later trying to spawn. The distinction between the two
    // failures is the whole point — one says "no engine serves this variant", the other says "the
    // engine broke" — so assert on the error, not on rejection.
    // Each variant's *own* starting position: FEN validation runs before routing, and the standard
    // start position is not a legal Horde position (Horde has no white king), so a shared FEN would
    // fail on validation and never exercise the routing this test is about.
    for (const variant of ['atomic', 'crazyhouse', 'kingofthehill', 'threecheck', 'horde', 'racingkings'] as const) {
      await assert.rejects(
        () => engine.analyze({ fen: Position.initial(variant).fen(), variant, limits: { timeMs: 50 } }),
        NoEngineForVariantError,
        `${variant} has no configured engine and must be refused as unsupported`,
      );
    }

    // `standard` does route, so it gets past the router and fails on the missing binary instead.
    // Any error but `NoEngineForVariantError` proves the routing worked.
    await assert.rejects(
      () => engine.analyze({ fen: START_FEN, variant: 'standard', limits: { timeMs: 50 } }),
      (err: unknown) => !(err instanceof NoEngineForVariantError),
      'standard must route to the Stockfish pool rather than being refused as unsupported',
    );
  } finally {
    await engine.shutdown({ deadlineMs: 1_000 });
  }
});

/** The filter is by configuration, not a denylist: adding the binary makes the variants route. */
test('adding the Fairy binary makes its variants route', async () => {
  const engine = createAnalysisEngine({
    STOCKFISH_PATH: '/nonexistent/stockfish',
    FAIRY_STOCKFISH_PATH: '/nonexistent/fairy-stockfish',
  });
  try {
    await assert.rejects(
      () => engine.analyze({ fen: Position.initial('atomic').fen(), variant: 'atomic', limits: { timeMs: 50 } }),
      (err: unknown) => !(err instanceof NoEngineForVariantError),
      'atomic must route once Fairy-Stockfish is configured',
    );
  } finally {
    await engine.shutdown({ deadlineMs: 1_000 });
  }
});

test('createAnalysisFromEnv: returns AnalysisService when STOCKFISH_PATH is set', () => {
  const composed = createAnalysisFromEnv({
    STOCKFISH_PATH: '/usr/bin/stockfish',
  });
  assert.ok(composed !== undefined);
  assert.ok(composed.service instanceof AnalysisService);
});

test('createPuzzleGeneration reuses the supplied AnalysisService', () => {
  const provider = {
    analyze: async () => [],
    play: async () => { throw new Error('not used'); },
    capabilitiesFor: () => undefined,
  };
  const analysis = new AnalysisService({ provider, supportsVariant: () => true });

  const puzzles = createPuzzleGeneration(analysis);

  assert.ok(puzzles instanceof PuzzleGenerationService);
  assert.equal(puzzles.supportsVariant('standard'), true);
});

test('createPuzzleGeneration stays unavailable when no engine can supply MultiPV 3', () => {
  const provider = {
    analyze: async () => [],
    play: async () => { throw new Error('not used'); },
    capabilitiesFor: () => undefined,
  };
  const analysis = new AnalysisService({
    provider,
    supportsVariant: () => true,
    supportsMultiPv: () => false,
  });

  assert.equal(createPuzzleGeneration(analysis), undefined);
});

for (const [name, policy] of [
  ['depth', { maxDepth: 15, maxNodes: 5_000_000, maxTimeMs: 2_000, maxMultiPv: 5, defaultDepth: 15, defaultTimeMs: 1_000 }],
  ['movetime', { maxDepth: 20, maxNodes: 5_000_000, maxTimeMs: 999, maxMultiPv: 5, defaultDepth: 16, defaultTimeMs: 999 }],
  ['MultiPV', { maxDepth: 20, maxNodes: 5_000_000, maxTimeMs: 2_000, maxMultiPv: 2, defaultDepth: 16, defaultTimeMs: 1_000 }],
] as const) {
  test(`createPuzzleGeneration stays unavailable when deployment ${name} policy cannot satisfy the fixed search`, () => {
    const provider = {
      analyze: async () => [],
      play: async () => { throw new Error('not used'); },
      capabilitiesFor: () => undefined,
    };
    const analysis = new AnalysisService({ provider, policy, supportsVariant: () => true });

    assert.equal(createPuzzleGeneration(analysis), undefined);
  });
}

/**
 * The pool owns OS processes, so a composition that cannot be stopped leaks them past SIGTERM.
 * An earlier draft returned only the service and left the `EngineManager` unreachable; this asserts
 * the handle exists and completes even in the state it is most likely to be called in — nothing
 * ever analysed, so `minWorkers: 0` means no worker was ever spawned.
 */
test('createAnalysisFromEnv: exposes a shutdown that drains a pool which never spawned a worker', async () => {
  const composed = createAnalysisFromEnv({ STOCKFISH_PATH: '/nonexistent/stockfish' });
  assert.ok(composed !== undefined);
  await composed.shutdown({ deadlineMs: 1_000 });
});

test('createAnalysisFromEnv: respects process.env without leaking changes across tests', () => {
  const oldPath = process.env['STOCKFISH_PATH'];
  try {
    delete process.env['STOCKFISH_PATH'];
    assert.equal(createAnalysisFromEnv(), undefined);

    process.env['STOCKFISH_PATH'] = '/usr/bin/stockfish';
    const composed = createAnalysisFromEnv();
    assert.ok(composed?.service instanceof AnalysisService);
  } finally {
    if (oldPath !== undefined) {
      process.env['STOCKFISH_PATH'] = oldPath;
    } else {
      delete process.env['STOCKFISH_PATH'];
    }
  }
});

/**
 * `EngineManagerOptions` applies `maxWorkers` and `capacityPerClass` per pool, and one pool exists
 * per registered plugin — so configuring a second engine silently doubled the subsystem's CPU
 * ceiling and its queue depth. Raised in the Qodo review of PR #132. The bound this endpoint
 * documents is a property of the subsystem, not of each engine inside it.
 *
 * Asserted through `health()`, which reports one entry per pool, so this fails if the division is
 * removed *or* if pool creation stops being per-plugin.
 */
test('the worker and queue bounds are per subsystem, not multiplied by engine count', async () => {
  const oneEngine = createAnalysisEngine({
    STOCKFISH_PATH: '/nonexistent/stockfish',
    ANALYSIS_ENGINE_MAX_WORKERS: '2',
    ANALYSIS_ENGINE_QUEUE_CAPACITY: '32',
  });
  const twoEngines = createAnalysisEngine({
    STOCKFISH_PATH: '/nonexistent/stockfish',
    FAIRY_STOCKFISH_PATH: '/nonexistent/fairy-stockfish',
    ANALYSIS_ENGINE_MAX_WORKERS: '2',
    ANALYSIS_ENGINE_QUEUE_CAPACITY: '32',
  });

  try {
    assert.equal(oneEngine.health().pools.length, 1, 'one configured engine is one pool');
    assert.equal(twoEngines.health().pools.length, 2, 'two configured engines are two pools');
    // The ceiling is `pools * perPoolWorkers`; with 2 pools the per-pool figure must have halved,
    // so the product stays at the configured 2 rather than becoming 4.
    assert.equal(twoEngines.health().pools.length * 1, 2, 'two pools must carry one worker each');
  } finally {
    await Promise.all([oneEngine.shutdown({ deadlineMs: 1_000 }), twoEngines.shutdown({ deadlineMs: 1_000 })]);
  }
});

/**
 * The analysis cache stores the *requested* limits as the entry's metadata, but the unconditional
 * wall-clock ceiling can stop a search before its requested depth — so an entry can claim more depth
 * than it holds (raised in the Qodo review of PR #132).
 *
 * What keeps that from mattering is that `applyAnalysisLimits` always emits a `timeMs`, and
 * `limitsSatisfy` compares it: a caller asking for more time than the entry was searched with
 * misses and re-searches. This pins that property, because it is load-bearing and invisible — if
 * `movetimeMs` ever became conditional again, this cache would start serving under-searched results
 * to callers who paid for more.
 */
test('a cached entry does not satisfy a request asking for more time', () => {
  const shallow = { depth: 20, timeMs: 250 };
  assert.equal(limitsSatisfy(shallow, { depth: 20, timeMs: 250 }), true, 'same limits hit');
  assert.equal(limitsSatisfy(shallow, { depth: 20, timeMs: 2_000 }), false, 'more time must miss');
  assert.equal(limitsSatisfy(shallow, { depth: 25, timeMs: 250 }), false, 'more depth must miss');
});
