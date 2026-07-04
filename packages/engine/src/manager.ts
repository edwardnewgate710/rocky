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
import { NullCache } from './cache.js';
import type { FenValidator } from './fen.js';
import { structuralFenValidator } from './fen.js';
import { NoEngineForVariantError } from './errors.js';

export interface EngineManagerOptions {
  /** Creates a transport for a worker of `plugin`. The isolation seam for I/O. */
  readonly transportFactory: (plugin: EnginePlugin) => EngineTransport;
  readonly clock?: Clock;
  readonly cache?: AnalysisCache;
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

export class EngineManager implements AnalysisProvider {
  private readonly options: EngineManagerOptions;
  private readonly clock: Clock;
  private readonly cache: AnalysisCache;
  private readonly fenValidator: FenValidator;
  private readonly pools: EnginePool[] = [];

  constructor(options: EngineManagerOptions) {
    this.options = options;
    this.clock = options.clock ?? new SystemClock();
    this.cache = options.cache ?? new NullCache();
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
    const pool = this.route(request.variant);
    const multiPv = request.multiPv ?? 1;
    const priority = request.priority ?? JobPriority.LiveAnalysis;

    const caps = await pool.ensureCapabilities();
    const key = { fingerprint: caps.fingerprint, fen: request.fen, variant: request.variant, multiPv };

    const cached = await this.cache.get(key, request.limits);
    if (cached) return cached;

    const results = await pool.submitAnalyze({
      fen: request.fen,
      variant: request.variant,
      limits: request.limits,
      multiPv,
      priority,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    await this.cache.set(key, results, { limits: request.limits });
    return results;
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
