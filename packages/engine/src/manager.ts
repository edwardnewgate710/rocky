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
import type { AnalysisLimits, EngineCapabilities, EngineConfig, EngineResult, ManagerHealth, Health } from './types.js';
import { JobPriority } from './types.js';
import type { AnalysisCache } from './cache.js';
import { NullCache } from './cache.js';
import type { FenValidator } from './fen.js';
import { structuralFenValidator } from './fen.js';
import { NoEngineForVariantError } from './errors.js';

/**
 * What a finished search actually reached, which is not what it was asked for.
 *
 * `CacheMeta.limits` is documented as "the limits the cached search actually achieved", and
 * `limitsSatisfy` relies on that to decide whether an entry can serve a later request. Storing the
 * *requested* limits instead made every entry claim whatever was asked for: a `depth: 20` request
 * that a `movetime` ceiling cut short at depth 8 was filed as depth 20, and the next `depth: 20`
 * request was served the depth-8 lines.
 *
 * The harm is not that the first caller got depth 8 — a search under that time budget was always
 * going to. It is that quality then becomes a function of when the first identical request happened
 * to run: one issued while the box was loaded poisons the entry for everyone after it, including
 * callers whose own search would have gone deeper. Raised in the Qodo review of PR #132, against
 * the first consumer to enable a real cache.
 *
 * `depth` and `nodes` are taken from the results, at the *minimum* across lines, because a multi-PV
 * entry is only as good as its shallowest line. `timeMs` keeps the requested value: time is the
 * budget spent, not a measure of what was reached, and storing the elapsed figure would make an
 * entry miss a later request for the same budget it already served.
 */
function achievedLimits(results: readonly EngineResult[], requested: AnalysisLimits): AnalysisLimits {
  if (results.length === 0) return requested;

  let depth = Number.POSITIVE_INFINITY;
  let nodes = Number.POSITIVE_INFINITY;
  for (const result of results) {
    depth = Math.min(depth, result.depth);
    nodes = Math.min(nodes, result.nodes);
  }

  return {
    depth,
    nodes,
    ...(requested.timeMs !== undefined ? { timeMs: requested.timeMs } : {}),
  };
}

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
    await this.cache.set(key, results, { limits: achievedLimits(results, request.limits) });
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
