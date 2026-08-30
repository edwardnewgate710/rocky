/**
 * @packageDocumentation
 * The process-local hot tier in front of the durable analysis cache (ADR-0139).
 *
 * ADR-0138 wired the Postgres cache to production by handing `tier.cache` to `createAnalysisEngine`,
 * where the trailing `...options` spread replaces the `InMemoryLruCache` that factory otherwise
 * builds. That was correct — a durable cache is the point — but it left production with *no*
 * in-process tier at all, so every analysis lookup, including the same position asked for twice in a
 * second, is a PostgreSQL round trip. This class puts a small bounded LRU back in front of it.
 *
 * **It is a composite behind the same port, not a change to the path.** `AnalysisCache` is the only
 * seam it implements, so the single-flight map, the cancellation ledger, and the result validation
 * all stay exactly where `AnalysisOrchestrator` already keeps them: this object is called from
 * inside a flight, by the same two calls the durable adapter used to receive, and everything it
 * returns is re-checked by `isAnalysisResultSet` before a caller sees it. Nothing above it can tell
 * which tier answered — which is the property that makes the tier safe to add.
 */

import { performance } from 'node:perf_hooks';
import type {
  AnalysisCache,
  AnalysisKey,
  AnalysisLimits,
  CacheMeta,
  EngineResult,
} from '@chess-platform/engine';
import { cacheKeyString, limitsSatisfy } from '@chess-platform/engine';

/**
 * What one hot-tier operation did. A closed union, and the only thing that ever becomes a metric
 * label — see {@link HotAnalysisCacheObserver}.
 */
export type HotCacheOutcome = 'hit' | 'miss' | 'durable_hit' | 'expired' | 'evicted';

export interface HotAnalysisCacheObserver {
  /** Outcomes are a bounded enum; no key, FEN, fingerprint, user or request id reaches here. */
  recordHotCache(outcome: HotCacheOutcome): void;
}

/**
 * How long a hot entry may answer, measured from the moment it entered this tier.
 *
 * The durable tier supplies no expiry metadata to inherit. Its `SELECT` carries no expiry predicate
 * at all, and rows die only when the retention sweeper deletes them by `updated_at`; `get` returns
 * `EngineResult[]` and nothing else, so a front tier cannot learn when the row it just read is due
 * to be swept. The smallest safe design is therefore a deadline this tier owns, chosen so small that
 * it cannot meaningfully disagree with the policy it sits under.
 *
 * A minute is that size. The retention window is 30 days by default and 365 at most, so the extra
 * staleness this tier can introduce is at worst `HOT_CACHE_TTL_MS / ttlMs` — under one part in forty
 * thousand of the window an operator configured. And because the deadline is **absolute**, fixed
 * when the entry is stored and never renewed by a read, a position asked for a thousand times a
 * second still leaves this tier after a minute. That is what makes it incapable of extending a
 * durable entry indefinitely; a sliding deadline would make a hot position immortal, which is the
 * one failure this constant exists to prevent.
 *
 * It is a constant rather than a setting for the reason `durable-cache.ts` gives about the statement
 * timeout: this is a safety bound, and its only interesting values are the derived one and a wrong
 * one. An operator raising it "to improve the hit rate" would be trading away the guarantee.
 */
export const HOT_CACHE_TTL_MS = 60_000;

/**
 * The ceiling on how many analyses one process may hold.
 *
 * An entry is a MultiPV set: at most `maxMultiPv` (5) lines, each with a principal variation the
 * engine bounds by its own search depth. A few kilobytes at the pessimistic end, so five thousand
 * entries is tens of megabytes — affordable beside the `hashMbPerWorker` the engine pool already
 * claims, and small enough that a mistyped environment variable cannot turn the cache into the
 * reason the container is killed. `analysisCacheSettingsFromEnv` clamps to this rather than
 * refusing to boot, exactly as it already does for the retention window.
 */
export const MAX_HOT_CACHE_ENTRIES = 5_000;

interface HotEntry {
  readonly value: readonly EngineResult[];
  /** What the stored search is *claimed* to have achieved. Never an over-claim; see `get`. */
  readonly limits: AnalysisLimits;
  /** Absolute deadline, fixed at insertion. Never moved by a read. */
  readonly expiresAt: number;
}

/**
 * Make a set of results unwritable before it becomes a shared entry.
 *
 * This tier changes who holds the array, which is what makes the freeze necessary rather than
 * merely tidy. `PgAnalysisCache` decodes a fresh object graph on every hit, so its safety comes from
 * *freshness*: each caller gets its own copy, and a mutation could corrupt at most that caller's
 * results. A hot entry has no freshness — the same object is handed to every subsequent hit — so one
 * mutation would corrupt the cache itself and every later reader with it.
 *
 * That is also why the surface here is deliberately *wider* than `decodeAnalysisPayload`'s, which
 * freezes only the outer array and each principal variation. Matching it exactly would have left
 * `evaluation` and the result objects writable, and `result.evaluation.value` is the single most
 * damaging field to corrupt: every caller downstream reads it as the position's score. Freezing the
 * whole graph costs one pass per insertion and closes the gap that sharing opened.
 */
function freezeResults(results: readonly EngineResult[]): readonly EngineResult[] {
  for (const result of results) {
    Object.freeze(result.evaluation);
    Object.freeze(result.principalVariation);
    Object.freeze(result);
  }
  return Object.freeze(results);
}

export interface HotAnalysisCacheOptions {
  /** The durable tier. Every miss goes here, and every write still reaches it. */
  readonly delegate: AnalysisCache;
  readonly maxEntries: number;
  /** Seam for tests; production uses {@link HOT_CACHE_TTL_MS}. */
  readonly ttlMs?: number;
  /**
   * Elapsed-time source. Seam for tests; production uses a monotonic clock — see the note on
   * {@link HotAnalysisCache} for why this one does not follow `SystemClock` in using the wall clock.
   */
  readonly now?: () => number;
  readonly observer?: HotAnalysisCacheObserver;
}

/**
 * A bounded, process-local LRU in front of a durable {@link AnalysisCache}.
 *
 * **Time is measured monotonically, which is the one place this class departs from `SystemClock`.**
 * The engine's `Clock` says "wall clock is fine", and for a watchdog it is: a backward step makes a
 * timeout fire late and the next tick corrects it. Here a backward step does something worse. This
 * tier's deadline is not a timeout, it is the bound that makes a short in-memory TTL coherent with a
 * thirty-day retention window — so a clock that jumps back an hour would hold entries an hour past
 * the deadline the ADR argues is absolute. `performance.now()` counts from process start and no
 * NTP correction can move it, which makes the bound true rather than merely intended. Nothing here
 * compares against a stored timestamp, so there is nothing a monotonic reading could disagree with.
 *
 * **Failure semantics: this tier adds no catch of its own, deliberately.** Everything it does is a
 * `Map` operation on plain data, so it has no failure mode a caller could recover from — and
 * `AnalysisOrchestrator` already absorbs a throwing `get` as a miss and a throwing `set` as a
 * reported write failure. A second blanket catch here would buy nothing and would swallow the one
 * class of error worth seeing, a defect in this file. The delegate's errors travel through
 * untouched for the same reason: the durable tier's fail-open story is `PgAnalysisCache`'s and the
 * orchestrator's, and wrapping it would change which counter a database outage increments.
 */
export class HotAnalysisCache implements AnalysisCache {
  private readonly entries = new Map<string, HotEntry>();
  private readonly delegate: AnalysisCache;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly observer: HotAnalysisCacheObserver | undefined;

  constructor(options: HotAnalysisCacheOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    const ttlMs = options.ttlMs ?? HOT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError('ttlMs must be a positive integer');
    }
    this.delegate = options.delegate;
    this.maxEntries = options.maxEntries;
    this.ttlMs = ttlMs;
    this.now = options.now ?? (() => performance.now());
    this.observer = options.observer;
  }

  /**
   * Answer from memory when a live entry is strong enough; otherwise ask the durable tier and keep
   * what it says.
   *
   * The populated entry records the caller's **requested** limits as what the value achieved, not
   * the row's real achievement — which the durable `get` does not report. That is deliberately an
   * under-claim, and under-claiming is the only safe direction: the durable tier returned this value
   * precisely because the stored search satisfied `requested`, so anything `requested` can satisfy
   * the real row can satisfy too. A later, stronger request therefore misses here and reaches the
   * durable row that may well answer it, costing one lookup. Recording anything larger would let
   * this tier promise a depth no search behind it ever reached.
   */
  async get(
    key: AnalysisKey,
    requested: AnalysisLimits,
  ): Promise<readonly EngineResult[] | undefined> {
    const keyString = cacheKeyString(key);
    const live = this.takeLive(keyString, requested);
    if (live !== undefined) {
      this.observe('hit');
      return live;
    }
    this.observe('miss');
    const durable = await this.delegate.get(key, requested);
    if (durable !== undefined) {
      this.observe('durable_hit');
      this.store(keyString, durable, requested);
    }
    return durable;
  }

  /**
   * The entry for this key if one is live and strong enough to answer, promoted to most-recently-used.
   *
   * Named `take` rather than `find` because it is not a pure read: a hit moves the entry to the tail
   * of the LRU order, and an expired entry is dropped on the way past. That drop is the whole of
   * expiry in this tier — no timer, no sweep, nothing that could keep the process alive.
   *
   * A live entry too weak for this request is left exactly where it is. Deleting it would let one
   * deep request throw away an entry that is still answering every shallow one.
   */
  private takeLive(keyString: string, requested: AnalysisLimits): readonly EngineResult[] | undefined {
    const entry = this.entries.get(keyString);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(keyString);
      this.observe('expired');
      return undefined;
    }
    if (!limitsSatisfy(entry.limits, requested)) return undefined;
    this.promote(keyString, entry);
    return entry.value;
  }

  /**
   * Keep the result here, then persist it exactly as before.
   *
   * **Hot population happens first, and independently of what the durable write does.** The value is
   * already trustworthy by this point — `AnalysisOrchestrator.compute` runs `isAnalysisResultSet`
   * over the engine's output and throws `ProtocolError` before it ever calls `set`, so a failed,
   * cancelled, or malformed computation never reaches this line. Making the hot entry wait on the
   * durable write instead would tie the optimization to the thing it is meant to survive: a database
   * outage would cost the recomputation *and* the in-process hit, which is the opposite of failing
   * open. The durable call below is unchanged — same arguments, same order relative to the caller —
   * so its errors still reach the orchestrator's `cache_write_failure` and its faults still reach the
   * fault counter.
   */
  async set(key: AnalysisKey, value: readonly EngineResult[], meta: CacheMeta): Promise<void> {
    this.store(cacheKeyString(key), value, meta.limits);
    await this.delegate.set(key, value, meta);
  }

  /** Live entries currently held. Diagnostics and tests; production reads nothing from here. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop everything held.
   *
   * Called when the tier shuts down, so "the cache is released" means the same thing for both
   * halves. Without it a hot entry would go on answering out of a tier whose pool has been closed —
   * which is not a wrong answer, but it is a cache still serving after its owner said it had stopped,
   * and that is the kind of difference between the two tiers that makes an outage hard to read.
   */
  clear(): void {
    this.entries.clear();
  }

  /** Re-insert at the tail, so `Map` iteration order stays least-recently-used first. */
  private promote(keyString: string, entry: HotEntry): void {
    this.entries.delete(keyString);
    this.entries.set(keyString, entry);
  }

  /**
   * Insert, honouring the same dominance rule the durable `ON CONFLICT DO UPDATE` applies: an entry
   * may only be replaced by one that could serve every request it could serve. That is what stops a
   * depth-10 search finishing second from displacing a depth-20 result.
   *
   * Expiry is checked *before* dominance, and the order matters. An expired incumbent is not an
   * incumbent — reading dominance against it would let a stale deep entry block a fresh shallow one
   * for as long as new writes kept arriving, so the key would hold a value past its deadline that
   * nothing could replace and `get` would then have to discard anyway. Checking liveness first makes
   * the deadline mean the same thing on both paths.
   */
  private store(keyString: string, value: readonly EngineResult[], limits: AnalysisLimits): void {
    // An analysis with no lines is the one shape that is structurally fine to a `Map` and unusable
    // to every caller: `AnalysisOrchestrator.readCache` rejects it, and `assertLineOrder` refuses it
    // in both directions at the durable boundary, so nothing upstream can act on it. Storing it
    // would hold a slot that answers nothing until its deadline. Neither production path can produce
    // one — this is the guard that keeps that a property of the tier rather than of its callers.
    if (value.length === 0) return;
    // Snapshot rather than alias. `get` is handed the caller's own `AnalysisLimits` — the
    // orchestrator passes `execution.limits` straight through — and a hot entry outlives the call
    // that made it. Keeping the reference would let a caller mutate `{ depth: 10 }` into
    // `{ depth: 20 }` afterwards and have this depth-10 analysis answer a depth-20 lookup, which is
    // the one direction this tier must never claim. Same reasoning as `freezeResults`: what is
    // shared cannot be borrowed. Raised in the CodeRabbit review of PR #19.
    const stored: AnalysisLimits = { ...limits };
    const now = this.now();
    const current = this.entries.get(keyString);
    if (current !== undefined && now < current.expiresAt && !limitsSatisfy(stored, current.limits)) {
      return;
    }
    // Delete before set so a replacement lands at the tail rather than keeping the old entry's
    // position — an update must not leave a logically-replaced entry looking least recently used,
    // and `Map.set` on an existing key would do exactly that.
    this.entries.delete(keyString);
    this.entries.set(keyString, {
      value: freezeResults(value),
      limits: stored,
      expiresAt: now + this.ttlMs,
    });
    this.evict();
  }

  /**
   * Trim to capacity. Runs after every insertion — both the one in `set` and the durable-hit
   * population in `get` — because a bound only one write path enforces is not a bound.
   *
   * **An entry past its deadline is given up before a live one.** Deadlines are absolute and
   * promotion is not, so the two orders diverge: a hit moves an entry to the tail without renewing
   * it, and that entry can expire there while a newer, still-useful entry sits at the head. Evicting
   * the head blindly would then discard the one that could still answer and leave dead weight
   * resident — and would report the whole thing as `evicted`, overstating capacity pressure in
   * exactly the counter `docs/OBSERVABILITY.md` offers for telling it apart from entries ageing out.
   *
   * The scan is O(n) and runs only while the tier is actually over its bound. At the 5,000-entry
   * ceiling that is tens of microseconds, against a lookup whose alternative is a round trip bounded
   * at 250ms — not worth a second index to avoid. Raised in the Qodo review of PR #19.
   */
  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const now = this.now();
      let victim: string | undefined;
      for (const [candidate, entry] of this.entries) {
        if (now >= entry.expiresAt) {
          victim = candidate;
          break;
        }
      }
      const expired = victim !== undefined;
      victim ??= this.entries.keys().next().value;
      if (victim === undefined) break;
      this.entries.delete(victim);
      this.observe(expired ? 'expired' : 'evicted');
    }
  }

  /** Telemetry cannot become an availability dependency, the same rule the orchestrator applies. */
  private observe(outcome: HotCacheOutcome): void {
    try {
      this.observer?.recordHotCache(outcome);
    } catch {
      // intentionally empty
    }
  }
}
