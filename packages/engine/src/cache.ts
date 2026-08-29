/**
 * Analysis cache seam. Analysis is deterministic for a given
 * `(fingerprint, fen, variant, multiPv)`, so caching avoids repeating expensive deep
 * searches. The *backend* is deliberately behind a port (ADR-0002 Decision 4): M5 ships
 * an in-process LRU and a null cache; Redis (ephemeral) and Postgres (durable) are
 * future implementations of the same interface — a durable backend touches the approved
 * persistence contract and is gated separately (future ADR-0003).
 */
import { createHash } from 'node:crypto';
import type { AnalysisLimits, EngineConfig, EngineResult } from './types.js';

export interface AnalysisKey {
  readonly fingerprint: string;
  readonly fen: string;
  readonly variant: string;
  readonly multiPv: number;
}

export interface CacheMeta {
  /** The limits the cached search actually achieved. */
  readonly limits: AnalysisLimits;
}

export interface AnalysisCache {
  /**
   * Return cached results only if a previous search was **at least as deep/long** as
   * `requested` (a deeper request must recompute). Otherwise resolve `undefined`.
   */
  get(key: AnalysisKey, requested: AnalysisLimits): Promise<readonly EngineResult[] | undefined>;
  set(key: AnalysisKey, value: readonly EngineResult[], meta: CacheMeta): Promise<void>;
}

/** True if a search that achieved `have` also satisfies a request for `want`. */
export function limitsSatisfy(have: AnalysisLimits, want: AnalysisLimits): boolean {
  if (want.depth !== undefined && !(have.depth !== undefined && have.depth >= want.depth)) return false;
  if (want.nodes !== undefined && !(have.nodes !== undefined && have.nodes >= want.nodes)) return false;
  if (want.timeMs !== undefined && !(have.timeMs !== undefined && have.timeMs >= want.timeMs)) return false;
  return true;
}

export function cacheKeyString(key: AnalysisKey): string {
  return JSON.stringify([key.fingerprint, key.variant, key.multiPv, key.fen]);
}

/** Namespace a build fingerprint by the option values that affect its searches. */
export function analysisCacheFingerprint(fingerprint: string, config: EngineConfig | undefined): string {
  const settings: unknown[] = [];
  if (config?.threads !== undefined) settings.push(['Threads', config.threads]);
  if (config?.hashMb !== undefined) settings.push(['Hash', config.hashMb]);
  if (config?.options) {
    settings.push(
      ...Object.entries(config.options)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, configured]) => [name, configured]),
    );
  }
  if (settings.length === 0) return fingerprint;
  return createHash('sha256')
    .update(`${fingerprint}\u0000${JSON.stringify(settings)}`)
    .digest('hex')
    .slice(0, 32);
}

/** No-op cache; the safe default when caching is undesirable (e.g. in tests). */
export class NullCache implements AnalysisCache {
  async get(_key: AnalysisKey, _requested: AnalysisLimits): Promise<readonly EngineResult[] | undefined> {
    return undefined;
  }

  async set(_key: AnalysisKey, _value: readonly EngineResult[], _meta: CacheMeta): Promise<void> {
    // intentionally empty
  }
}

interface LruEntry {
  readonly value: readonly EngineResult[];
  readonly limits: AnalysisLimits;
}

/**
 * Bounded in-process LRU. Keyed by `(fingerprint, variant, multiPv, fen)`; a fresh set
 * for a key replaces the prior entry (a deeper search supersedes a shallower one).
 * Eviction is strict LRU by insertion/most-recent-access order.
 */
export class InMemoryLruCache implements AnalysisCache {
  private readonly entries = new Map<string, LruEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    if (maxEntries < 1) throw new RangeError('maxEntries must be >= 1');
    this.maxEntries = maxEntries;
  }

  async get(key: AnalysisKey, requested: AnalysisLimits): Promise<readonly EngineResult[] | undefined> {
    const keyString = cacheKeyString(key);
    const entry = this.entries.get(keyString);
    if (!entry || !limitsSatisfy(entry.limits, requested)) return undefined;
    // Mark most-recently-used.
    this.entries.delete(keyString);
    this.entries.set(keyString, entry);
    return entry.value;
  }

  async set(key: AnalysisKey, value: readonly EngineResult[], meta: CacheMeta): Promise<void> {
    const keyString = cacheKeyString(key);
    const current = this.entries.get(keyString);
    if (current && !limitsSatisfy(meta.limits, current.limits)) return;
    this.entries.delete(keyString);
    this.entries.set(keyString, { value, limits: meta.limits });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Current number of cached entries (diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }
}
