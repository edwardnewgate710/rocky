/**
 * @packageDocumentation
 * Composition helpers for the chess analysis engine and service.
 *
 * Configures a dedicated, lazily-warmed {@link EngineManager} and {@link AnalysisService}
 * from environment variables with safe defaults and bounded ceilings.
 */

import type {
  CreateEngineManagerOptions,
  EngineManager,
  EnginePlugin,
} from '@chess-platform/engine';
import {
  builtinPlugins,
  createEngineManager,
  InMemoryLruCache,
} from '@chess-platform/engine';
import { DEFAULT_MISTAKE_THRESHOLDS, MistakePredictor } from '@chess-platform/ai-features';
import { coreFenValidator } from './fen-validator.js';
import type { AnalysisLimitsPolicy } from './limits.js';
import { DEFAULT_ANALYSIS_LIMITS } from './limits.js';
import { AnalysisService } from './service.js';
import type { AnalysisPort } from './service.js';
import { MistakePredictionService } from './mistake-prediction-service.js';
import {
  PUZZLE_ANALYSIS_LIMITS,
  PuzzleGenerationService,
} from './puzzle-generation-service.js';
import { VARIANTS } from '../domain.js';

export interface AnalysisEngineSettings {
  readonly maxWorkers: number;
  readonly queueCapacity: number;
  readonly cacheEntries: number;
  /**
   * UCI `Threads` per worker. Stated rather than inherited, because it is the second factor in the
   * CPU bound and the only one an engine default gets a vote on: `maxWorkers` caps concurrent
   * *processes*, and the worst case is `maxWorkers * threadsPerWorker` cores. Leaving it unset means
   * `UciEngineInstance` never sends `setoption name Threads`, so the ceiling silently becomes
   * whatever the installed build happens to default to. One thread per worker makes the bound
   * exactly `maxWorkers`.
   */
  readonly threadsPerWorker: number;
  /** UCI `Hash` (MB) per worker — the memory bound, explicit for the same reason. */
  readonly hashMbPerWorker: number;
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return defaultValue;
  }
  return num;
}

export function analysisSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnalysisEngineSettings {
  return {
    maxWorkers: parsePositiveInt(env['ANALYSIS_ENGINE_MAX_WORKERS'], 2),
    queueCapacity: parsePositiveInt(env['ANALYSIS_ENGINE_QUEUE_CAPACITY'], 32),
    cacheEntries: parsePositiveInt(env['ANALYSIS_CACHE_ENTRIES'], 500),
    threadsPerWorker: parsePositiveInt(env['ANALYSIS_ENGINE_THREADS'], 1),
    hashMbPerWorker: parsePositiveInt(env['ANALYSIS_ENGINE_HASH_MB'], 16),
  };
}

export function analysisLimitsPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnalysisLimitsPolicy {
  const maxDepth = Math.min(
    parsePositiveInt(env['ANALYSIS_MAX_DEPTH'], DEFAULT_ANALYSIS_LIMITS.maxDepth),
    DEFAULT_ANALYSIS_LIMITS.maxDepth,
  );
  const maxNodes = Math.min(
    parsePositiveInt(env['ANALYSIS_MAX_NODES'], DEFAULT_ANALYSIS_LIMITS.maxNodes),
    DEFAULT_ANALYSIS_LIMITS.maxNodes,
  );
  const maxTimeMs = Math.min(
    parsePositiveInt(env['ANALYSIS_MAX_TIME_MS'], DEFAULT_ANALYSIS_LIMITS.maxTimeMs),
    DEFAULT_ANALYSIS_LIMITS.maxTimeMs,
  );
  const maxMultiPv = Math.min(
    parsePositiveInt(env['ANALYSIS_MAX_MULTIPV'], DEFAULT_ANALYSIS_LIMITS.maxMultiPv),
    DEFAULT_ANALYSIS_LIMITS.maxMultiPv,
  );

  return {
    maxDepth,
    maxNodes,
    maxTimeMs,
    maxMultiPv,
    defaultDepth: Math.min(DEFAULT_ANALYSIS_LIMITS.defaultDepth, maxDepth),
    defaultTimeMs: Math.min(DEFAULT_ANALYSIS_LIMITS.defaultTimeMs, maxTimeMs),
  };
}

/**
 * The env var `EnvBinaryResolver` will look for when it resolves this plugin's binary.
 * Mirrors the derivation in `packages/engine/src/bootstrap.ts`.
 */
function binaryEnvKey(pluginId: string): string {
  return `${pluginId.replace(/-/g, '_').toUpperCase()}_PATH`;
}

/**
 * Only the engines this deployment actually has a binary for.
 *
 * `createEngineManager` registers both built-in plugins by default, and a pool claims the variants
 * its plugin *expects* before it has ever run — so with only `STOCKFISH_PATH` set, `atomic`,
 * `crazyhouse`, `kingofthehill`, `threecheck`, `horde` and `racingkings` all routed to the
 * Fairy-Stockfish pool, which then failed to spawn. The caller got `503 analysis engine failed`:
 * a message that says the engine is broken about a deployment that is working exactly as
 * configured and simply does not offer that variant.
 *
 * Registering only configured engines makes the routing tell the truth. An unsupported variant
 * finds no pool, raises `NoEngineForVariantError`, and reaches the caller as `422 unsupported
 * variant` — the right status, the right message, and no subprocess spawn attempted. Found in the
 * Qodo review of PR #132.
 */
function configuredPlugins(env: NodeJS.ProcessEnv): readonly EnginePlugin[] {
  return builtinPlugins.filter((plugin) => {
    const configured = env[binaryEnvKey(plugin.id)];
    return typeof configured === 'string' && configured !== '';
  });
}

export function createAnalysisEngine(
  env: NodeJS.ProcessEnv = process.env,
  options: Partial<CreateEngineManagerOptions> = {},
): EngineManager {
  const settings = analysisSettingsFromEnv(env);
  const plugins = configuredPlugins(env);

  // `EngineManagerOptions` applies `maxWorkers` and `capacityPerClass` to *each* pool it creates,
  // and one pool is created per registered plugin. `maxWorkers: 2` with both engines configured is
  // therefore four concurrent searches and two queues of 32, not the two workers and one short
  // queue this subsystem documents — and the CPU bound is exactly the thing that must not quietly
  // double when someone adds variant support. Dividing keeps the *subsystem* ceiling the number
  // stated: one engine gets 2, two engines get 1 each. Raised in the Qodo review of PR #132.
  // Floor of 1, because a pool that cannot run a single search is not a smaller bound, it is an
  // outage.
  const poolCount = Math.max(1, plugins.length);
  const perPoolWorkers = Math.max(1, Math.floor(settings.maxWorkers / poolCount));
  const perPoolQueue = Math.max(1, Math.floor(settings.queueCapacity / poolCount));

  return createEngineManager({
    plugins,
    minWorkers: 0,
    maxWorkers: perPoolWorkers,
    capacityPerClass: perPoolQueue,
    config: { threads: settings.threadsPerWorker, hashMb: settings.hashMbPerWorker },
    fenValidator: coreFenValidator,
    cache: new InMemoryLruCache(settings.cacheEntries),
    ...options,
  });
}

/**
 * The analysis subsystem as the composition root has to hold it: the service to serve requests
 * with, and the handle that stops the subprocesses behind it.
 *
 * These travel together because the pool owns OS processes. `AnalysisService` deliberately depends
 * on the `AnalysisProvider` *interface* — that is what lets it be tested against doubles with no
 * binary — so it cannot own shutdown itself without dragging process lifecycle into a class whose
 * whole value is not having any. Returning only the service, as an earlier draft did, left the
 * `EngineManager` unreachable: nothing could drain it, and the engine subprocesses would outlive a
 * SIGTERM until the container was killed. The gateway learned this already and keeps the same kind
 * of handle for its own pool.
 */
export interface AnalysisComposition {
  readonly service: AnalysisService;
  /** Drain in-flight work, reject what is queued, and stop every worker process. */
  shutdown(options?: { deadlineMs?: number }): Promise<void>;
}

/**
 * Build the dedicated analysis subsystem, or `undefined` when no engine binary is configured, so a
 * deployment without one stays entirely engine-free and the capability simply reports off.
 */
export function createAnalysisFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnalysisComposition | undefined {
  // Any configured engine will do, not `STOCKFISH_PATH` specifically: a deployment that installs
  // only Fairy-Stockfish is a working analysis deployment, and gating on the wrong variable would
  // report the capability off while a usable engine sat there.
  if (configuredPlugins(env).length === 0) return undefined;
  const engine = createAnalysisEngine(env);
  const policy = analysisLimitsPolicyFromEnv(env);
  const service = new AnalysisService({
    provider: engine,
    policy,
    // The manager answers this from its registered plugins without warming a pool, so advertising
    // the variant list costs no engine process (ADR-0114 Decision 7).
    supportsVariant: (variant) => engine.supportsVariant(variant),
    supportsMultiPv: (variant, count) => engine.supportsMultiPv(variant, count),
  });
  return {
    service,
    shutdown: (options = {}) => engine.shutdown(options),
  };
}

/**
 * Assemble Mistake Prediction over the analysis subsystem it borrows (ADR-0118).
 *
 * Note what is *not* passed to `MistakePredictor`: an engine. It is composed against nothing at all
 * for analysis, so the only path to a chess engine in this process remains the one `AnalysisService`
 * owns. A second pool is not prevented here by convention or by review — there is no parameter
 * through which one could arrive. The same technique ADR-0115 used for `MoveExplainer`.
 *
 * Note also what is not passed: an AI provider. The verdict is a rules-and-engine fact and is
 * complete without prose, so this feature makes no provider call, costs no provider money, and is
 * available on any deployment with an engine. `thresholds` is fixed here because it is server-owned
 * policy, and the request body has no field that reaches it.
 */
export function createMistakePrediction(analysis: AnalysisPort): MistakePredictionService {
  const predictor = new MistakePredictor({
    defaultVariant: 'standard',
    thresholds: DEFAULT_MISTAKE_THRESHOLDS,
  });
  return new MistakePredictionService({ analysis, predictor });
}

/**
 * Assemble puzzle generation over the same bounded analysis subsystem (ADR-0125).
 *
 * The generator receives no engine provider of its own. Its only search is the fixed-policy
 * MultiPV request made through the supplied production {@link AnalysisService}.
 */
export function createPuzzleGeneration(
  analysis: AnalysisPort,
): PuzzleGenerationService | undefined {
  if (!analysis.canSatisfyLimits(PUZZLE_ANALYSIS_LIMITS)) return undefined;
  if (!VARIANTS.some((variant) =>
    analysis.supportsMultiPv(variant, PUZZLE_ANALYSIS_LIMITS.multiPv))) return undefined;
  return new PuzzleGenerationService({ analysis });
}
