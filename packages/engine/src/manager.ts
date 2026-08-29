/**
 * Top-level orchestrator and the {@link AnalysisProvider} callers hold. Owns the plugin
 * registry (one {@link EnginePool} per plugin), routes requests to a pool by discovered
 * capability, applies the FEN validation boundary and the analysis cache, aggregates
 * health, and performs process-wide graceful shutdown. Callers never see pools, engines,
 * or transports.
 */
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import type { EngineTransport } from './transport.js';
import type { EnginePlugin } from './plugin.js';
import { EnginePool, type CircuitBreakerOptions } from './pool.js';
import type { AnalysisProvider, AnalysisRequest, PlayRequest, PlayResult } from './provider.js';
import type { EngineCapabilities, EngineConfig, EngineResult, ManagerHealth, Health } from './types.js';
import { JobPriority } from './types.js';
import type { AnalysisCache } from './cache.js';
import { analysisCacheFingerprint, NullCache } from './cache.js';
import {
  AnalysisOrchestrator,
  type AnalysisOrchestrationObserver,
} from './analysis-orchestrator.js';
import type { FenValidator } from './fen.js';
import { structuralFenValidator } from './fen.js';
import { CancelledError, NoEngineForVariantError } from './errors.js';

export interface EngineManagerOptions {
  /** Creates a transport for a worker of `plugin`. The isolation seam for I/O. */
  readonly transportFactory: (plugin: EnginePlugin) => EngineTransport;
  readonly clock?: Clock;
  readonly cache?: AnalysisCache;
  /** Low-cardinality engine events; adapter-internal absorbed faults use that adapter's hook. */
  readonly observer?: AnalysisOrchestrationObserver;
  readonly fenValidator?: FenValidator;
  readonly config?: EngineConfig;
  readonly minWorkers?: number;
  readonly maxWorkers?: number;
  readonly watchdogMs?: number;
  readonly initTimeoutMs?: number;
  readonly quitGraceMs?: number;
  readonly capacityPerClass?: number;
  readonly agingMs?: number;
  readonly idleTtlMs?: number;
  readonly breaker?: CircuitBreakerOptions;
}

function recordConsumerCancellation(observer: AnalysisOrchestrationObserver | undefined): void {
  try {
    observer?.record({ type: 'cancellation', scope: 'consumer' });
  } catch {
    // Telemetry cannot become an analysis availability dependency.
  }
}

function waitForCaller<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
  observer: AnalysisOrchestrationObserver | undefined,
): Promise<T> {
  if (signal === undefined) return shared;
  if (signal.aborted) {
    recordConsumerCancellation(observer);
    return Promise.reject(new CancelledError());
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      recordConsumerCancellation(observer);
      reject(new CancelledError());
    };
    shared.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export class EngineManager implements AnalysisProvider {
  private readonly options: EngineManagerOptions;
  private readonly clock: Clock;
  private readonly analysis: AnalysisOrchestrator;
  private readonly fenValidator: FenValidator;
  private readonly pools: EnginePool[] = [];

  constructor(options: EngineManagerOptions) {
    this.options = options;
    this.clock = options.clock ?? new SystemClock();
    this.analysis = new AnalysisOrchestrator({
      cache: options.cache ?? new NullCache(),
      clock: this.clock,
      ...(options.observer !== undefined ? { observer: options.observer } : {}),
    });
    this.fenValidator = options.fenValidator ?? structuralFenValidator;
  }

  /** Register an engine plugin, creating its pool (workers warm lazily on first use). */
  register(plugin: EnginePlugin): void {
    if (this.pools.some((p) => p.plugin.id === plugin.id)) {
      throw new Error(`Engine plugin "${plugin.id}" is already registered.`);
    }
    this.pools.push(
      new EnginePool({
        plugin,
        transportFactory: () => this.options.transportFactory(plugin),
        clock: this.clock,
        ...(this.options.config !== undefined ? { config: this.options.config } : {}),
        ...(this.options.minWorkers !== undefined ? { minWorkers: this.options.minWorkers } : {}),
        ...(this.options.maxWorkers !== undefined ? { maxWorkers: this.options.maxWorkers } : {}),
        ...(this.options.watchdogMs !== undefined ? { watchdogMs: this.options.watchdogMs } : {}),
        ...(this.options.initTimeoutMs !== undefined ? { initTimeoutMs: this.options.initTimeoutMs } : {}),
        ...(this.options.quitGraceMs !== undefined ? { quitGraceMs: this.options.quitGraceMs } : {}),
        ...(this.options.capacityPerClass !== undefined ? { capacityPerClass: this.options.capacityPerClass } : {}),
        ...(this.options.agingMs !== undefined ? { agingMs: this.options.agingMs } : {}),
        ...(this.options.idleTtlMs !== undefined ? { idleTtlMs: this.options.idleTtlMs } : {}),
        ...(this.options.breaker !== undefined ? { breaker: this.options.breaker } : {}),
      }),
    );
  }

  /** Warm every pool to its minimum, so capabilities and workers are ready ahead of load. */
  async warmup(): Promise<void> {
    await Promise.all(this.pools.map((pool) => pool.warmup()));
  }

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.fenValidator.validate(request.fen, request.variant);
    if (request.signal?.aborted) {
      recordConsumerCancellation(this.options.observer);
      throw new CancelledError();
    }
    const pool = this.route(request.variant);
    const multiPv = request.multiPv ?? 1;
    const priority = request.priority ?? JobPriority.LiveAnalysis;

    const caps = await waitForCaller(pool.ensureCapabilities(), request.signal, this.options.observer);
    const key = {
      fingerprint: analysisCacheFingerprint(caps.fingerprint, this.options.config),
      fen: request.fen,
      variant: request.variant,
      multiPv,
    };

    return this.analysis.analyze({
      key,
      limits: request.limits,
      priorityClass: priority,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      execute: (signal) =>
        pool.submitAnalyze({
          fen: request.fen,
          variant: request.variant,
          limits: request.limits,
          multiPv,
          priority,
          signal,
        }),
    });
  }

  async play(request: PlayRequest): Promise<PlayResult> {
    this.fenValidator.validate(request.fen, request.variant);
    const pool = this.route(request.variant);
    const priority = request.priority ?? JobPriority.BotMove;
    return pool.submitPlay({
      fen: request.fen,
      variant: request.variant,
      limits: request.limits,
      multiPv: 1,
      priority,
      ...(request.strength !== undefined ? { strength: request.strength } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  }

  capabilitiesFor(variant: string): EngineCapabilities | undefined {
    const pool = this.pools.find((p) => p.supportsVariant(variant));
    return pool?.capabilities;
  }

  /**
   * Whether any registered engine would serve `variant`, without spawning anything to find out.
   *
   * This is deliberately not `capabilitiesFor(variant) !== undefined`: that reads *discovered*
   * capabilities, which only exist once a pool has warmed, so with `minWorkers: 0` it answers
   * `undefined` for every variant until the first search. `EnginePool.supportsVariant` falls back to
   * the plugin's declared variants when cold (ADR-0102), so this is answerable at rest — which is
   * what lets a caller advertise the variant list without paying for an engine process.
   *
   * Takes the platform's variant vocabulary (`standard`), not the engine's (`chess`); the pool maps
   * between them.
   */
  supportsVariant(variant: string): boolean {
    return this.pools.some((pool) => pool.supportsVariant(variant));
  }

  /**
   * Whether the routed engine can honor an exact MultiPV count without warming a cold pool.
   * Discovered UCI bounds replace the plugin's cold-start guarantee once available.
   */
  supportsMultiPv(variant: string, count: number): boolean {
    const pool = this.pools.find((candidate) => candidate.supportsVariant(variant));
    return pool?.supportsMultiPv(count) ?? false;
  }

  health(): ManagerHealth {
    const pools = this.pools.map((pool) => pool.health());
    const totalQueueDepth = pools.reduce((sum, pool) => sum + pool.queueDepth, 0);
    const anyReady = pools.some((pool) => pool.ready > 0);
    const anyUnhealthy = pools.some((pool) => pool.ready === 0 || pool.breaker === 'open');
    let status: Health = 'healthy';
    if (pools.length === 0 || !anyReady) status = 'unhealthy';
    else if (anyUnhealthy) status = 'degraded';
    return { status, pools, totalQueueDepth };
  }

  async shutdown(options: { deadlineMs?: number } = {}): Promise<void> {
    await Promise.all(this.pools.map((pool) => pool.drain(options.deadlineMs ?? 10_000)));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private route(variant: string): EnginePool {
    const pool = this.pools.find((p) => p.supportsVariant(variant));
    if (!pool) throw new NoEngineForVariantError(variant);
    return pool;
  }
}
