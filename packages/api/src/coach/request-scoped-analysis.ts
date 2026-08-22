/**
 * A per-request view of the analysis service, for the Coach orchestrator (ADR-0129).
 *
 * The Coach composes five feature services that were each written to stand alone, and standing
 * alone is exactly what makes them expensive together: mistake prediction and move explanation both
 * begin by searching the position the caller sent, with byte-identical arguments, because neither
 * knows the other ran. Nothing about that is a defect in either service — it is the cost of
 * composing them.
 *
 * This closes it without editing either one. It implements {@link AnalysisPort}, so it can be handed
 * to a service where the concrete `AnalysisService` was named, and it does three things the shared
 * singleton must not do:
 *
 * 1. **De-duplicates identical searches.** Keyed on the complete argument set, so a hit is a request
 *    that could not have produced a different answer. The stored value is the *promise*, not the
 *    resolved outcome, so two searches issued concurrently — which is what `Promise.all` inside each
 *    service does — collapse into one engine acquisition rather than racing. The engine's own LRU
 *    (`InMemoryLruCache`, keyed `fingerprint|variant|multiPv|fen`) would collapse the sequential
 *    case, but it has no single-flight and it is a configurable cache: relying on it would make the
 *    cost bound depend on `cacheEntries` being non-zero. This does not.
 * 2. **Threads the request's cancellation signal into every search.** The five services take no
 *    signal parameter, and adding one to each would be five edits to hardened code for a value none
 *    of them uses. Injecting it here reaches all of them at once.
 * 3. **Counts acquisitions**, so the worst-case cost claimed in the ADR is a number a test asserts
 *    rather than a number a comment asserts.
 *
 * Scope is one request. It is constructed in the route handler and dropped with the response, so
 * there is no staleness question to answer and no cross-request or cross-user leakage: a cache that
 * outlived the request would be one user's evaluation answering another user's question.
 */
import type { AnalysisOutcome, AnalysisPort, AnalyzeInput } from '../analysis/service.js';
import type { RequestedAnalysisLimits } from '../analysis/limits.js';

/**
 * The complete argument set of a search, as a string.
 *
 * Every field `analyze` reads is in the key. That is the property that makes a hit safe: two
 * requests with the same key are the same question, so one answer serves both. `signal` is
 * deliberately excluded — it is not part of the question, and the orchestrator gives every search
 * in a request the same one.
 *
 * @param input - the search about to be issued.
 * @returns a key that changes whenever any limit or position does.
 */
function keyOf(input: AnalyzeInput): string {
  return [
    input.variant,
    input.multiPv ?? '',
    input.depth ?? '',
    input.nodes ?? '',
    input.movetimeMs ?? '',
    input.fen,
  ].join('|');
}

/** Wraps the shared analysis service for the lifetime of one Coach request. */
export class RequestScopedAnalysis implements AnalysisPort {
  private readonly inner: AnalysisPort;
  private readonly signal: AbortSignal | undefined;
  private readonly inFlight = new Map<string, Promise<AnalysisOutcome>>();
  private acquisitions = 0;

  /**
   * @param inner - the shared, long-lived analysis service.
   * @param signal - the request's cancellation signal, or `undefined` where none is available.
   */
  constructor(inner: AnalysisPort, signal?: AbortSignal | undefined) {
    this.inner = inner;
    this.signal = signal;
  }

  /** @returns how many searches actually reached the engine, ignoring de-duplicated repeats. */
  searchCount(): number {
    return this.acquisitions;
  }

  /**
   * @param variant - the variant to ask about.
   * @returns the shared service's answer. Capability is a property of the deployment, not of one
   * request, so these three are pass-throughs and deliberately hold no state of their own.
   */
  supportsVariant(variant: string): boolean {
    return this.inner.supportsVariant(variant);
  }

  /**
   * @param variant - the variant to ask about.
   * @param count - the number of lines wanted.
   * @returns the shared service's answer.
   */
  supportsMultiPv(variant: string, count: number): boolean {
    return this.inner.supportsMultiPv(variant, count);
  }

  /**
   * @param requested - the limits a feature's fixed policy needs.
   * @returns the shared service's answer.
   */
  canSatisfyLimits(requested: RequestedAnalysisLimits): boolean {
    return this.inner.canSatisfyLimits(requested);
  }

  /**
   * Issue a search, or hand back the one already answering this exact question.
   *
   * @param input - the search. Any `signal` on it is replaced by the request's, so a composed
   * service cannot opt out of the cancellation the request is subject to.
   * @returns the analysis outcome.
   */
  async analyze(input: AnalyzeInput): Promise<AnalysisOutcome> {
    const key = keyOf(input);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    this.acquisitions += 1;
    const pending = this.inner.analyze({
      ...input,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    this.inFlight.set(key, pending);

    // A rejected search is forgotten rather than cached. Caching the rejection would turn one
    // transient engine failure into a failure of every remaining section of the same request, which
    // is precisely the all-or-nothing behaviour the section-by-section contract exists to avoid.
    // The counter is not rewound: an acquisition that failed still cost the pool a slot, and a cost
    // bound that only counts successes is not a bound.
    pending.catch(() => {
      this.inFlight.delete(key);
    });

    return pending;
  }
}
