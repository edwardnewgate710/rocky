/**
 * @packageDocumentation
 * Production observability for the analysis cache (ADR-0138).
 *
 * Two sources report here and they are deliberately kept apart, because with a durable adapter they
 * describe different things and neither can be derived from the other:
 *
 * - The **engine observer** says what the *request* did — hit, miss, coalesced, computed, cancelled.
 * - The **adapter fault hook** says whether the *database* misbehaved — read, write, payload, and
 *   the retention sweep.
 *
 * They cannot double-count, and the reason is worth stating because it is not obvious.
 * `PgAnalysisCache` absorbs every fault and returns normally, so a failed read reaches
 * `AnalysisOrchestrator.readCache` as `undefined` and is recorded as `cache_miss` — never as
 * `cache_read_failure`, which fires only for a cache that *throws*. A failed write is stranger
 * still: `set` resolves, so the orchestrator records `cache_write_completed` for a write that never
 * landed. An operator watching engine events alone would therefore see a healthy cache with a poor
 * hit rate throughout a total database outage. The fault counter is the only thing that tells those
 * apart, which is exactly why ADR-0135 §6 made the hook the composition root's job to supply.
 *
 * **Cardinality and privacy.** Every label is a closed enum from a union type in the engine or the
 * persistence adapter, so the series count is fixed at build time. Nothing identifying can leak even
 * by mistake: neither `AnalysisOrchestrationEvent` nor the fault hook carries a FEN, a cache key, a
 * game, a user or a request id — those fields do not exist on the signals, so there is nothing to
 * spill.
 */

import type {
  AnalysisOrchestrationEvent,
  AnalysisOrchestrationObserver,
} from '@chess-platform/engine';
import type { AnalysisCacheFault } from '@chess-platform/persistence/pg';
import type { Logger } from '../ports/logger';
import type { Counter, Histogram, Metrics } from '../ports/metrics';

/** Consecutive failed sweeps before the retention log level rises from warn to error. */
export const RETENTION_FAILURE_ESCALATION = 3;

/** Sub-second at the fast end, because a cache lookup that is slow has already lost its purpose. */
const LOOKUP_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

/** The lookup outcomes worth a latency series. Bounded by construction; see the module note. */
type LookupOutcome = 'hit' | 'miss' | 'read_failure';

const LOOKUP_OUTCOME: Partial<Record<AnalysisOrchestrationEvent['type'], LookupOutcome>> = {
  cache_hit: 'hit',
  cache_miss: 'miss',
  cache_read_failure: 'read_failure',
};

/** What the fault counter is labelled with. `retention` is this layer's own, not the adapter's. */
type FaultLabel = AnalysisCacheFault | 'retention';

/**
 * Reduce an arbitrary thrown value to bounded, loggable primitives.
 *
 * A `pg` error carries its SQLSTATE on `code`, and that is the field worth alerting on: `57014` is a
 * statement timeout and `42P01` a missing table, and those call for different responses. The message
 * is kept for diagnosis but truncated and stripped of control characters — the logger JSON-encodes,
 * so this is not about injection, it is about stopping one malformed error from writing a megabyte
 * of log line.
 */
function describe(error: unknown): { readonly code: string; readonly detail: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === 'string' && code.length > 0 && code.length <= 16 ? code : 'none',
    // eslint-disable-next-line no-control-regex
    detail: raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
  };
}

export interface AnalysisCacheObservabilityOptions {
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/**
 * The single sink both halves of the cache report to.
 *
 * Series handles are resolved once and memoized rather than looked up per event. `Metrics.counter`
 * resolves a series by name and labels on every call, and `record` is the hottest telemetry call in
 * the analysis path — one or more per request.
 */
export class AnalysisCacheObservability implements AnalysisOrchestrationObserver {
  private readonly events = new Map<string, Counter>();
  private readonly faults = new Map<string, Counter>();
  private readonly lookups = new Map<LookupOutcome, Histogram>();
  private readonly retentionDeleted: Counter;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(options: AnalysisCacheObservabilityOptions) {
    this.metrics = options.metrics;
    this.logger = options.logger.child({ component: 'analysis-cache' });
    this.retentionDeleted = this.metrics.counter('analysis_cache_retention_deleted_total');
  }

  /** Record one engine-side event. Cache misses and cancellations are not logged: neither is news. */
  record(event: AnalysisOrchestrationEvent): void {
    this.counterFor(this.events, event.type, 'analysis_cache_events_total', 'event').inc();
    const outcome = LOOKUP_OUTCOME[event.type];
    if (outcome !== undefined && 'durationMs' in event) {
      this.histogramFor(outcome).observe(event.durationMs / 1000);
    }
  }

  /**
   * Record one absorbed adapter fault.
   *
   * A `payload` fault is an `error`: a row was found and could not be believed, which means either
   * corruption or a build reading a payload version it does not speak, and neither resolves on its
   * own. `read` and `write` are `warn`, because the platform is still answering every request
   * correctly — they report a degraded cache, not a broken product.
   */
  reportFault(fault: AnalysisCacheFault, error: unknown): void {
    this.counterFor(this.faults, fault, 'analysis_cache_faults_total', 'fault').inc();
    const { code, detail } = describe(error);
    const fields = { fault, code, detail };
    if (fault === 'payload') {
      this.logger.error('analysis cache returned an unusable payload', fields);
    } else {
      this.logger.warn('analysis cache operation failed; serving without it', fields);
    }
  }

  /** Record a completed sweep. Debug, because a routine sweep is not news either. */
  recordRetentionSweep(deleted: number): void {
    if (deleted > 0) this.retentionDeleted.inc(deleted);
    this.logger.debug('analysis cache retention sweep completed', { deleted });
  }

  /**
   * Record a failed sweep.
   *
   * `consecutiveFailures` is what separates a blip from a stuck sweeper. One failure is a warn and
   * the next tick retries; a sweeper failing every tick means the table is growing without bound,
   * and nothing else in the system would ever say so.
   */
  reportRetentionFailure(error: unknown, consecutiveFailures: number): void {
    this.counterFor(this.faults, 'retention', 'analysis_cache_faults_total', 'fault').inc();
    const { code, detail } = describe(error);
    const fields = { fault: 'retention', code, detail, consecutiveFailures };
    if (consecutiveFailures >= RETENTION_FAILURE_ESCALATION) {
      this.logger.error(
        'analysis cache retention has failed repeatedly; the table is not being trimmed',
        fields,
      );
    } else {
      this.logger.warn('analysis cache retention sweep failed; retrying next interval', fields);
    }
  }

  private counterFor(
    cache: Map<string, Counter>,
    key: AnalysisOrchestrationEvent['type'] | FaultLabel,
    name: string,
    label: string,
  ): Counter {
    const existing = cache.get(key);
    if (existing) return existing;
    const counter = this.metrics.counter(name, { [label]: key });
    cache.set(key, counter);
    return counter;
  }

  private histogramFor(outcome: LookupOutcome): Histogram {
    const existing = this.lookups.get(outcome);
    if (existing) return existing;
    const histogram = this.metrics.histogram('analysis_cache_lookup_seconds', LOOKUP_BUCKETS, {
      outcome,
    });
    this.lookups.set(outcome, histogram);
    return histogram;
  }
}
