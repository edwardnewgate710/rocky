/**
 * @packageDocumentation
 * Retention for the durable analysis cache (ADR-0138).
 *
 * ADR-0135 §7 listed retention as a precondition of wiring this cache to production: the table has
 * no TTL and no eviction, which is fine for a table nothing writes to and not fine once every
 * analysis writes to it. This is the smallest mechanism that discharges that: a periodic sweep that
 * deletes bounded batches of the oldest rows, built on the same `setInterval` + `unref` + `stop()`
 * shape `TournamentResultReporter` already uses, rather than a scheduler framework.
 *
 * **Nothing here is on the request path.** The timer is the only caller, no request awaits it, and a
 * failed sweep is reported and retried on the next tick. That is what makes retention unable to
 * affect analysis availability — not care taken at each call site, but the absence of any call site.
 */

import type { AnalysisCacheObservability } from './cache-observability';

/**
 * The slice of the durable adapter retention needs.
 *
 * Declared here rather than importing `PgAnalysisCache` so the sweep logic — the loop bound, the
 * overlap guard, the failure escalation — is testable without a database, and so this module keeps
 * no dependency on `pg`.
 */
export interface ExpiringAnalysisCache {
  /** Delete up to `limit` rows last updated before `before`; resolve with how many went. */
  deleteExpired(before: Date, limit: number): Promise<number>;
}

/**
 * The floor the adaptive batch size backs off to. Small enough that a single delete of this many
 * keyed rows fits inside any plausible statement timeout, so backing off always converges on a size
 * that works rather than shrinking forever.
 */
const MINIMUM_BATCH_SIZE = 25;

export interface AnalysisCacheRetentionOptions {
  readonly cache: ExpiringAnalysisCache;
  readonly observability: AnalysisCacheObservability;
  /** A row is eligible once this long has passed since a stronger search last replaced it. */
  readonly ttlMs: number;
  readonly intervalMs: number;
  /** Rows per statement, so one delete cannot run long enough to matter. */
  readonly batchSize: number;
  /**
   * Batches per sweep. The ceiling on how much one tick may delete, so a table that has gone
   * unswept for a long time is drained over several ticks instead of in one burst of write load.
   */
  readonly maxBatchesPerSweep: number;
  /** Seam for tests; production uses the wall clock. */
  readonly now?: () => number;
}

/**
 * Periodic bounded sweep of expired cache rows.
 *
 * Multi-replica safe without any coordination between replicas: the delete takes `FOR UPDATE SKIP
 * LOCKED`, so two sweeps running at once claim disjoint batches rather than contending, and a row a
 * concurrent write has just made fresh is re-checked and left alone. An advisory lock to elect a
 * single sweeper was considered and rejected — it would add a lock to release correctly on every
 * failure path in exchange for avoiding work that is already correct when duplicated.
 */
export class AnalysisCacheRetention {
  private readonly options: AnalysisCacheRetentionOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The sweep in flight, so a slow sweep is neither restarted nor abandoned at shutdown. */
  private inFlight: Promise<number> | undefined;
  /** Set by {@link stop}; checked between batches so a shutdown does not wait out a whole sweep. */
  private stopping = false;
  private consecutiveFailures = 0;
  /**
   * The batch size actually in use, which halves after a failed batch and is restored by a clean
   * sweep. A fixed size is a trap: if 500 rows ever stop fitting inside the pool's statement
   * timeout, every subsequent tick retries the same 500 rows and the table never gets trimmed
   * again. Backing off turns a permanent stall into a slower sweep that still makes progress.
   */
  private batchSize: number;

  constructor(options: AnalysisCacheRetentionOptions) {
    if (options.ttlMs < 1) throw new RangeError('ttlMs must be positive');
    if (options.intervalMs < 1) throw new RangeError('intervalMs must be positive');
    if (options.batchSize < 1) throw new RangeError('batchSize must be positive');
    if (options.maxBatchesPerSweep < 1) throw new RangeError('maxBatchesPerSweep must be positive');
    this.options = options;
    this.batchSize = options.batchSize;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Begin sweeping on the interval.
   *
   * Deliberately does *not* sweep immediately. Every replica calls this during boot, so a boot-time
   * sweep would put the whole fleet's delete load at exactly the moment a rolling deploy is already
   * the least stable. Waiting one interval spreads it out and costs nothing: the rows have been
   * expired for `ttlMs` already.
   *
   * The timer is `unref`'d so it can never be the reason a process stays alive.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop sweeping, and wait for any sweep already running to finish.
   *
   * Awaiting matters because the caller's next act is to close the pool. A sweep left running would
   * have its next batch rejected by the draining pool and would report that as a retention failure —
   * turning an orderly shutdown into an error in the logs and a bump in the fault counter.
   *
   * The wait is bounded to the batch in flight, not the whole sweep: `stopping` is checked between
   * batches, so a sweep with nineteen batches left abandons them rather than holding shutdown open.
   * Idempotent.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight?.catch(() => {});
  }

  /**
   * Run one sweep: delete batches until a short batch says the expired rows are gone, or the
   * per-sweep ceiling is reached. Resolves with the number deleted; never rejects, because its only
   * production caller is a timer with nowhere to report a rejection.
   */
  async sweep(): Promise<number> {
    if (this.inFlight !== undefined) return 0;
    const run = this.runSweep();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runSweep(): Promise<number> {
    const before = new Date(this.now() - this.options.ttlMs);
    let deleted = 0;
    try {
      for (let batch = 0; batch < this.options.maxBatchesPerSweep; batch++) {
        if (this.stopping) break;
        const size = this.batchSize;
        const removed = await this.options.cache.deleteExpired(before, size);
        deleted += removed;
        // A short batch means the sweep ran out of expired rows, not out of budget.
        if (removed < size) break;
      }
      this.consecutiveFailures = 0;
      this.batchSize = this.options.batchSize;
      this.options.observability.recordRetentionSweep(deleted);
      return deleted;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.batchSize = Math.max(MINIMUM_BATCH_SIZE, Math.floor(this.batchSize / 2));
      this.options.observability.reportRetentionFailure(error, this.consecutiveFailures);
      // Whatever earlier batches deleted is already committed; the next tick continues from there.
      return deleted;
    }
  }
}
