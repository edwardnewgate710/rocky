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
  /** A sweep in flight, so a slow sweep cannot have a second one started on top of it. */
  private sweeping = false;
  private consecutiveFailures = 0;

  constructor(options: AnalysisCacheRetentionOptions) {
    if (options.ttlMs < 1) throw new RangeError('ttlMs must be positive');
    if (options.intervalMs < 1) throw new RangeError('intervalMs must be positive');
    if (options.batchSize < 1) throw new RangeError('batchSize must be positive');
    if (options.maxBatchesPerSweep < 1) throw new RangeError('maxBatchesPerSweep must be positive');
    this.options = options;
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
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop sweeping. Idempotent, and safe to call while a sweep is in flight — the in-flight batch
   * finishes against a pool the owner has not closed yet, and no further tick is scheduled.
   */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Run one sweep: delete batches until a short batch says the expired rows are gone, or the
   * per-sweep ceiling is reached. Resolves with the number deleted; never rejects, because its only
   * production caller is a timer with nowhere to report a rejection.
   */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    const before = new Date(this.now() - this.options.ttlMs);
    let deleted = 0;
    try {
      for (let batch = 0; batch < this.options.maxBatchesPerSweep; batch++) {
        const removed = await this.options.cache.deleteExpired(before, this.options.batchSize);
        deleted += removed;
        // A short batch means the sweep ran out of expired rows, not out of budget.
        if (removed < this.options.batchSize) break;
      }
      this.consecutiveFailures = 0;
      this.options.observability.recordRetentionSweep(deleted);
      return deleted;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.options.observability.reportRetentionFailure(error, this.consecutiveFailures);
      // Whatever earlier batches deleted is already committed; the next tick continues from there.
      return deleted;
    } finally {
      this.sweeping = false;
    }
  }
}
