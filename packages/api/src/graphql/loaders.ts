/**
 * @packageDocumentation
 * A keyed batch-and-cache loader — the mechanism that keeps a nested query from turning into one
 * database round trip per node.
 *
 * Two properties do the work, and they solve different halves of the problem:
 *
 * - **Coalescing.** Every `load()` issued in the same microtask tick is served by a single call to
 *   the batch function. `followers { follower { handle } }` over 50 edges becomes one read, not 50.
 * - **Caching.** A key already requested is never requested again. This is what saves the query
 *   where the same player appears as a follower, a team member and a study owner.
 *
 * **The cache lives for exactly one request.** A loader shared between requests would answer one
 * caller from another caller's authorized view — the cache key is an id, and an id says nothing
 * about who was allowed to see the row. `createLoaders` is therefore called per request and the
 * result is never stored anywhere that outlives it.
 *
 * Coalescing depends on the executor resolving sibling fields concurrently: the batch flushes on
 * the microtask after the loads are issued, so an executor that awaited each field in turn would
 * produce a batch of one every time and this file would be an expensive no-op. `execute.ts` uses
 * `Promise.all` for exactly this reason, and the call-count test in `graphql.test.ts` is what keeps
 * the two honest.
 */

import type { UserRow, UsersRepository } from '@chess-platform/persistence';

/** The largest number of keys sent to the batch function in one call. */
export const MAX_BATCH_SIZE = 100;

interface Deferred<V> {
  readonly resolve: (value: V | undefined) => void;
  readonly reject: (err: unknown) => void;
}

/**
 * Batches and caches lookups of `V` by `K` for the lifetime of one request.
 *
 * The batch function is given the distinct keys awaiting resolution and returns the ones it found.
 * A key with no entry in the returned map resolves to `undefined` — "no such row" is an answer, not
 * a failure, and it is the same answer a single-key read would have given.
 */
export class BatchLoader<K, V> {
  private readonly cache = new Map<K, Promise<V | undefined>>();
  private queue: { key: K; deferred: Deferred<V> }[] = [];
  private flushScheduled = false;

  constructor(
    private readonly batchFn: (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>,
    private readonly maxBatchSize: number = MAX_BATCH_SIZE,
  ) {}

  load(key: K): Promise<V | undefined> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = new Promise<V | undefined>((resolve, reject) => {
      this.queue.push({ key, deferred: { resolve, reject } });
    });
    // Cached before the batch runs, so a second `load` of the same key in the same tick joins this
    // promise instead of enqueueing a duplicate.
    this.cache.set(key, promise);

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        void this.flush();
      });
    }
    return promise;
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;

    for (let i = 0; i < batch.length; i += this.maxBatchSize) {
      const slice = batch.slice(i, i + this.maxBatchSize);
      const keys = slice.map((entry) => entry.key);
      try {
        const found = await this.batchFn(keys);
        for (const entry of slice) entry.deferred.resolve(found.get(entry.key));
      } catch (err) {
        // Every caller waiting on this batch fails, and the failed keys are evicted so a retry
        // within the same request is not served a permanently rejected promise.
        for (const entry of slice) {
          this.cache.delete(entry.key);
          entry.deferred.reject(err);
        }
      }
    }
  }
}

/** The per-request loaders available to resolvers. */
export interface Loaders {
  readonly player: BatchLoader<string, UserRow>;
}

/**
 * Build the loader set for one request. Call this once per request and discard it with the
 * request — see the cache-lifetime note at the top of this file.
 */
export function createLoaders(users: UsersRepository): Loaders {
  return {
    player: new BatchLoader<string, UserRow>(async (ids) => {
      const rows = await users.findByIds(ids);
      // Keyed by id rather than zipped against the input: neither adapter promises to return rows
      // in the order asked for, and a positional match would pass in memory and scramble on
      // Postgres, where the order is whatever the plan produced.
      const byId = new Map<string, UserRow>();
      for (const row of rows) byId.set(row.id, row);
      return byId;
    }),
  };
}
