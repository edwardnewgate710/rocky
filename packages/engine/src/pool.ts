/**
 * A pool of warm workers for ONE engine plugin. Responsibilities: warm-up to a minimum,
 * check jobs out to idle workers, autoscale up to a maximum by queue depth, scale idle
 * workers back down, detect crashes and hot-replace workers without draining the pool,
 * trip a circuit breaker on crash storms, and drain gracefully on shutdown. Failure
 * isolation is structural: every worker is its own OS process behind the transport seam.
 */
import type { Clock, TimerHandle } from './clock.js';
import { SystemClock } from './clock.js';
import type { EngineTransport } from './transport.js';
import type { EnginePlugin } from './plugin.js';
import type { DeadInfo, EngineInstance } from './instance.js';
import type { AnalysisLimits, BreakerState, EngineCapabilities, EngineConfig, EngineResult, PoolHealth, WorkerHealth } from './types.js';
import { JobPriority } from './types.js';
import type { PlayResult, StrengthSpec } from './provider.js';
import { PriorityScheduler } from './queue.js';
import { CancelledError, CircuitOpenError, EngineError, ShuttingDownError } from './errors.js';

export type TransportFactory = () => EngineTransport;

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
}

export interface EnginePoolOptions {
  readonly plugin: EnginePlugin;
  readonly transportFactory: TransportFactory;
  readonly clock?: Clock;
  readonly minWorkers?: number;
  readonly maxWorkers?: number;
  readonly config?: EngineConfig;
  readonly watchdogMs?: number;
  readonly initTimeoutMs?: number;
  readonly quitGraceMs?: number;
  readonly capacityPerClass?: number;
  readonly agingMs?: number;
  readonly breaker?: CircuitBreakerOptions;
  /** Idle-worker time-to-live before scale-down (below-min workers are never reaped). */
  readonly idleTtlMs?: number;
  /** Max dispatch attempts per job (initial + retries after retryable failures). */
  readonly maxAttempts?: number;
}

interface PoolJob {
  readonly kind: 'analyze' | 'play';
  readonly fen: string;
  readonly variant: string;
  readonly limits: AnalysisLimits;
  readonly multiPv: number;
  readonly strength: StrengthSpec | undefined;
  readonly priority: JobPriority;
  readonly signal: AbortSignal | undefined;
  attempts: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface BreakerStateInternal {
  state: BreakerState;
  failures: number[];
  openUntil: number;
}

export class EnginePool {
  readonly plugin: EnginePlugin;
  private readonly transportFactory: TransportFactory;
  private readonly clock: Clock;
  private readonly minWorkers: number;
  private readonly maxWorkers: number;
  private readonly config: EngineConfig | undefined;
  private readonly watchdogMs: number | undefined;
  private readonly initTimeoutMs: number | undefined;
  private readonly quitGraceMs: number | undefined;
  private readonly idleTtlMs: number;
  private readonly maxAttempts: number;
  private readonly breakerOptions: Required<CircuitBreakerOptions>;

  private readonly scheduler: PriorityScheduler<PoolJob>;
  private readonly instances: EngineInstance[] = [];
  private readonly reapTimers = new Map<EngineInstance, TimerHandle>();
  private readonly breaker: BreakerStateInternal = { state: 'closed', failures: [], openUntil: 0 };
  private capabilitiesValue: EngineCapabilities | undefined;
  private spawning = 0;
  private inflight = 0;
  private draining = false;
  private counter = 0;
  private warmupPromise: Promise<EngineCapabilities> | null = null;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: EnginePoolOptions) {
    this.plugin = options.plugin;
    this.transportFactory = options.transportFactory;
    this.clock = options.clock ?? new SystemClock();
    this.minWorkers = Math.max(0, options.minWorkers ?? 1);
    this.maxWorkers = Math.max(this.minWorkers, options.maxWorkers ?? 4);
    this.config = options.config;
    this.watchdogMs = options.watchdogMs;
    this.initTimeoutMs = options.initTimeoutMs;
    this.quitGraceMs = options.quitGraceMs;
    this.idleTtlMs = options.idleTtlMs ?? 30_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.breakerOptions = {
      failureThreshold: options.breaker?.failureThreshold ?? 5,
      windowMs: options.breaker?.windowMs ?? 60_000,
      cooldownMs: options.breaker?.cooldownMs ?? 30_000,
    };
    this.scheduler = new PriorityScheduler<PoolJob>({
      clock: this.clock,
      ...(options.capacityPerClass !== undefined ? { capacityPerClass: options.capacityPerClass } : {}),
      ...(options.agingMs !== undefined ? { agingMs: options.agingMs } : {}),
    });
  }

  get capabilities(): EngineCapabilities | undefined {
    return this.capabilitiesValue;
  }

  /**
   * Whether this pool can serve `variant`, asked under both the platform's name and the engine's.
   *
   * The two vocabularies differ: `@chess-platform/core` says `standard` and `threecheck` where
   * engines answer `chess` and `3check`. Discovered capabilities are the engine describing itself,
   * so they arrive in the engine's language — checking the platform's name against them refused
   * games the engine could play, which is how a real bot game died on
   * `NoEngineForVariantError: ... "standard"`.
   *
   * Capabilities stay authoritative once discovered. Translating the name is not the same as
   * widening the check: an engine build that genuinely lacks `chess960` must still not be routed it,
   * or the manager will pick this pool over one that can actually play the game and fail later.
   * Only before warmup, with nothing discovered, does the plugin's declared list stand in.
   */
  supportsVariant(variant: string): boolean {
    const engineName = this.plugin.engineVariantName?.(variant) ?? variant;
    if (this.capabilitiesValue) {
      return this.capabilitiesValue.variants.has(variant) || this.capabilitiesValue.variants.has(engineName);
    }
    return this.plugin.expectedVariants.includes(variant) || this.plugin.expectedVariants.includes(engineName);
  }

  /** Warm to the minimum worker count and return the discovered capabilities. */
  async warmup(): Promise<EngineCapabilities> {
    if (this.capabilitiesValue) return this.capabilitiesValue;
    if (!this.warmupPromise) {
      const target = Math.max(1, this.minWorkers);
      this.warmupPromise = (async () => {
        const spawns = Array.from({ length: target }, () => this.spawnWorker());
        const results = await Promise.allSettled(spawns);
        if (!this.capabilitiesValue) {
          const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
          throw firstError ? firstError.reason : new EngineError('not_initialized', 'Pool warm-up produced no workers.');
        }
        return this.capabilitiesValue;
      })();
    }
    return this.warmupPromise;
  }

  /** Ensure capabilities are known (warms one worker if necessary). */
  async ensureCapabilities(): Promise<EngineCapabilities> {
    return this.capabilitiesValue ?? this.warmup();
  }

  submitAnalyze(request: {
    fen: string;
    variant: string;
    limits: AnalysisLimits;
    multiPv: number;
    priority: JobPriority;
    signal?: AbortSignal;
  }): Promise<readonly EngineResult[]> {
    return this.enqueue('analyze', request, undefined) as Promise<readonly EngineResult[]>;
  }

  submitPlay(request: {
    fen: string;
    variant: string;
    limits: AnalysisLimits;
    multiPv: number;
    priority: JobPriority;
    strength?: StrengthSpec;
    signal?: AbortSignal;
  }): Promise<PlayResult> {
    return this.enqueue('play', request, request.strength) as Promise<PlayResult>;
  }

  health(): PoolHealth {
    return {
      plugin: this.plugin.id,
      ready: this.instances.filter((w) => w.alive).length,
      target: this.minWorkers,
      breaker: this.breaker.state,
      queueDepth: this.scheduler.size,
      workers: this.instances.map((w) => this.toWorkerHealth(w)),
    };
  }

  async drain(deadlineMs = 10_000): Promise<void> {
    this.draining = true;
    let job = this.scheduler.dequeue();
    while (job !== undefined) {
      job.reject(new ShuttingDownError());
      job = this.scheduler.dequeue();
    }
    await this.waitIdle(deadlineMs);
    const survivors = [...this.instances];
    this.instances.length = 0;
    await Promise.all(survivors.map((w) => w.dispose().catch(() => undefined)));
  }

  // --- internals ---

  private enqueue(
    kind: 'analyze' | 'play',
    request: { fen: string; variant: string; limits: AnalysisLimits; multiPv: number; priority: JobPriority; signal?: AbortSignal },
    strength: StrengthSpec | undefined,
  ): Promise<unknown> {
    if (this.draining) return Promise.reject(new ShuttingDownError());
    if (this.updateBreaker()) return Promise.reject(new CircuitOpenError(`Engine "${this.plugin.id}" circuit is open.`));
    if (request.signal?.aborted) return Promise.reject(new CancelledError());

    return new Promise<unknown>((resolve, reject) => {
      const job: PoolJob = {
        kind,
        fen: request.fen,
        variant: request.variant,
        limits: request.limits,
        multiPv: request.multiPv,
        strength,
        priority: request.priority,
        signal: request.signal,
        attempts: 0,
        resolve,
        reject,
      };
      this.enqueueJob(job);
    });
  }

  private enqueueJob(job: PoolJob): void {
    this.scheduler.enqueue({
      value: job,
      priority: job.priority,
      ...(job.signal !== undefined ? { signal: job.signal } : {}),
      onCancel: () => job.reject(new CancelledError()),
    });
    this.dispatch();
  }

  private dispatch(): void {
    if (this.draining) return;

    let idle = this.findIdle();
    while (idle && this.scheduler.size > 0) {
      const job = this.scheduler.dequeue();
      if (!job) break;
      this.assign(idle, job);
      idle = this.findIdle();
    }

    if (this.scheduler.size > 0 && !this.updateBreaker()) {
      const headroom = this.maxWorkers - (this.instances.length + this.spawning);
      const toSpawn = Math.min(Math.max(0, headroom), this.scheduler.size);
      for (let i = 0; i < toSpawn; i++) this.spawnAndDispatch();
    }
  }

  private assign(worker: EngineInstance, job: PoolJob): void {
    this.cancelReap(worker);
    this.inflight += 1;
    job.attempts += 1;
    this.execute(worker, job).then(
      (value) => job.resolve(value),
      (error) => this.onJobError(job, error),
    ).finally(() => {
      this.inflight -= 1;
      this.onWorkerFree(worker);
      this.resolveIdleIfQuiet();
    });
  }

  private execute(worker: EngineInstance, job: PoolJob): Promise<unknown> {
    const setup = this.plugin.variantSetup(job.variant);
    if (job.kind === 'analyze') {
      return worker.analyze({ fen: job.fen, limits: job.limits, multiPv: job.multiPv, setup, signal: job.signal });
    }
    return worker.play({
      fen: job.fen,
      limits: job.limits,
      multiPv: job.multiPv,
      setup,
      ...(job.strength !== undefined ? { strength: job.strength } : {}),
      signal: job.signal,
    });
  }

  private onJobError(job: PoolJob, error: unknown): void {
    const retryable = error instanceof EngineError && error.retryable;
    if (retryable && job.attempts < this.maxAttempts && !job.signal?.aborted && !this.draining) {
      this.enqueueJob(job);
      return;
    }
    job.reject(error);
  }

  private onWorkerFree(worker: EngineInstance): void {
    if (this.draining || !worker.alive) return;
    this.scheduleReap(worker);
    this.dispatch();
  }

  private findIdle(): EngineInstance | undefined {
    return this.instances.find((w) => w.alive && !w.busy);
  }

  private spawnAndDispatch(): void {
    void this.spawnWorker().then(
      () => this.dispatch(),
      () => this.dispatch(),
    );
  }

  private async spawnWorker(): Promise<EngineInstance> {
    this.spawning += 1;
    try {
      const transport = this.transportFactory();
      const instance = this.plugin.createInstance(transport, {
        id: `${this.plugin.id}-${(this.counter += 1)}`,
        ...(this.config !== undefined ? { config: this.config } : {}),
        clock: this.clock,
        ...(this.watchdogMs !== undefined ? { watchdogMs: this.watchdogMs } : {}),
        ...(this.initTimeoutMs !== undefined ? { initTimeoutMs: this.initTimeoutMs } : {}),
        ...(this.quitGraceMs !== undefined ? { quitGraceMs: this.quitGraceMs } : {}),
      });
      instance.onDead((info) => this.handleDead(instance, info));
      const caps = await instance.init();
      this.instances.push(instance);
      this.capabilitiesValue ??= caps;
      this.onSpawnSuccess();
      return instance;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      this.spawning -= 1;
    }
  }

  private handleDead(instance: EngineInstance, info: DeadInfo): void {
    const index = this.instances.indexOf(instance);
    if (index >= 0) this.instances.splice(index, 1);
    this.cancelReap(instance);
    if (info.expected || this.draining) return;
    this.recordFailure();
    this.replenish();
  }

  private replenish(): void {
    if (this.draining) return;
    if (!this.updateBreaker() && this.instances.length + this.spawning < this.minWorkers) {
      this.spawnAndDispatch();
    } else {
      this.dispatch();
    }
  }

  private scheduleReap(worker: EngineInstance): void {
    if (this.instances.length <= this.minWorkers) return;
    if (this.reapTimers.has(worker)) return;
    const handle = this.clock.setTimeout(() => {
      this.reapTimers.delete(worker);
      if (!this.draining && worker.alive && !worker.busy && this.scheduler.size === 0 && this.instances.length > this.minWorkers) {
        const index = this.instances.indexOf(worker);
        if (index >= 0) this.instances.splice(index, 1);
        void worker.dispose().catch(() => undefined);
      }
    }, this.idleTtlMs);
    this.reapTimers.set(worker, handle);
  }

  private cancelReap(worker: EngineInstance): void {
    const handle = this.reapTimers.get(worker);
    if (handle) {
      this.clock.clearTimeout(handle);
      this.reapTimers.delete(worker);
    }
  }

  private recordFailure(): void {
    const now = this.clock.now();
    this.breaker.failures.push(now);
    this.breaker.failures = this.breaker.failures.filter((t) => now - t <= this.breakerOptions.windowMs);
    if (this.breaker.failures.length >= this.breakerOptions.failureThreshold) {
      this.breaker.state = 'open';
      this.breaker.openUntil = now + this.breakerOptions.cooldownMs;
    }
  }

  private onSpawnSuccess(): void {
    if (this.breaker.state !== 'closed') {
      this.breaker.state = 'closed';
      this.breaker.failures = [];
      this.breaker.openUntil = 0;
    }
  }

  /** Transition open->half-open when the cooldown elapses; returns true if calls are blocked. */
  private updateBreaker(): boolean {
    if (this.breaker.state === 'open' && this.clock.now() >= this.breaker.openUntil) {
      this.breaker.state = 'half-open';
    }
    return this.breaker.state === 'open';
  }

  private waitIdle(deadlineMs: number): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.clock.clearTimeout(timer);
        resolve();
      };
      this.idleWaiters.push(finish);
      const timer = this.clock.setTimeout(finish, deadlineMs);
    });
  }

  private resolveIdleIfQuiet(): void {
    if (this.inflight === 0 && this.idleWaiters.length > 0) {
      const waiters = [...this.idleWaiters];
      this.idleWaiters.length = 0;
      for (const waiter of waiters) waiter();
    }
  }

  private toWorkerHealth(worker: EngineInstance): WorkerHealth {
    return {
      id: worker.id,
      state: worker.alive ? 'healthy' : 'unhealthy',
      busy: worker.busy,
      jobsCompleted: worker.jobsCompleted,
      lastReadyOkMs: worker.lastReadyOkMs,
    };
  }
}
