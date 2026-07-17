/**
 * Response cache seam.  Keyed by (task, model, messageHash, groundingHash).
 * The backend is deliberately behind a port: M7 ships an in-process LRU;
 * Redis (ephemeral) and Postgres (durable) are future implementations of
 * the same interface.
 */

import { createHash } from 'node:crypto';
import type { CompletionRequest, CompletionResponse } from './types.js';

/** Cache key — identifies a unique request. */
export interface CacheKey {
  readonly task: string;
  readonly model: string;
  readonly messageHash: string;
  readonly groundingHash: string;
  readonly temperature: number;
  readonly maxTokens: number | undefined;
  /** Hash of response-shaping and routing inputs not represented above. */
  readonly optionsHash: string;
}

/** Cache entry with metadata. */
export interface CacheEntry {
  readonly response: CompletionResponse;
  readonly storedAt: number;
  readonly ttlMs: number;
}

/** The cache port. */
export interface ResponseCache {
  get(key: CacheKey): Promise<CacheEntry | undefined>;
  set(key: CacheKey, response: CompletionResponse): Promise<void>;
  clear(): void;
  readonly size: number;
}

/** Compute a collision-resistant stable hash from a string. */
export function hashString(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Build a cache key from a request. */
export function buildCacheKey(request: CompletionRequest): CacheKey {
  const messageHash = hashString(
    stableSerialize(request.messages),
  );
  const groundingHash = request.grounding
    ? hashString(stableSerialize(request.grounding))
    : 'none';
  return {
    task: request.task,
    model: request.model ?? 'auto',
    messageHash,
    groundingHash,
    temperature: request.temperature ?? 1,
    maxTokens: request.maxTokens,
    optionsHash: hashString(stableSerialize({
      modality: request.modality,
      structured: request.structured ?? false,
      schema: request.schema,
      providerPreference: request.providerPreference,
      latencyBudgetMs: request.latencyBudgetMs,
      costCeiling: request.costCeiling,
      userId: request.userId,
      metadata: request.metadata,
    })),
  };
}

/** Canonical JSON-like serialization with sorted object and Map keys. */
function stableSerialize(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, entry]) => [stableSerialize(key), stableSerialize(entry)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${key}:${entry}`).join(',')}}`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** Check if a cache entry is still valid. */
export function isExpired(entry: CacheEntry, now: number): boolean {
  if (entry.ttlMs === 0) return false;
  return now - entry.storedAt > entry.ttlMs;
}

/** No-op cache; the safe default when caching is undesired. */
export class NullCache implements ResponseCache {
  async get(_key: CacheKey): Promise<CacheEntry | undefined> {
    return undefined;
  }
  async set(_key: CacheKey, _response: CompletionResponse): Promise<void> {
    // intentionally empty
  }
  clear(): void {
    // intentionally empty
  }
  get size(): number {
    return 0;
  }
}

interface LruEntry extends CacheEntry {
  readonly keyString: string;
}

/**
 * Bounded in-process LRU cache.  Keyed by stringified CacheKey;
 * eviction is strict LRU by insertion/access order.
 */
export class InMemoryLruCache implements ResponseCache {
  private readonly entries = new Map<string, LruEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 1_000, ttlMs = 300_000) {
    if (maxEntries < 1) throw new RangeError('maxEntries must be >= 1');
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  async get(key: CacheKey): Promise<CacheEntry | undefined> {
    const keyString = cacheKeyString(key);
    const entry = this.entries.get(keyString);
    if (!entry) return undefined;
    if (isExpired(entry, Date.now())) {
      this.entries.delete(keyString);
      return undefined;
    }
    // Move to most-recently-used.
    this.entries.delete(keyString);
    this.entries.set(keyString, entry);
    return entry;
  }

  async set(key: CacheKey, response: CompletionResponse): Promise<void> {
    const keyString = cacheKeyString(key);
    const entry: LruEntry = {
      keyString,
      response,
      storedAt: Date.now(),
      ttlMs: this.ttlMs,
    };
    this.entries.delete(keyString);
    this.entries.set(keyString, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Stringify a cache key for Map storage. */
function cacheKeyString(key: CacheKey): string {
  return `${key.task}|${key.model}|${key.messageHash}|${key.groundingHash}|${key.temperature}|${key.maxTokens ?? 'n'}|${key.optionsHash}`;
}
