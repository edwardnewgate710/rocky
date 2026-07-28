import type { GameDocumentInput, SearchRepository } from '@chess-platform/search';
import { gameToDocument } from '@chess-platform/search';

/**
 * Minimal subscriber port required by SearchIndexWorker.
 * Satisfied by `PubSub` from `@chess-platform/realtime-gateway` without introducing a package dependency.
 */
export interface SearchIndexSubscriber {
  subscribe(channel: string, handler: (msg: unknown) => void): () => void;
}

/**
 * Minimal single-entity game reader required by SearchIndexWorker (satisfied by SearchBackfillSource).
 */
export interface SearchGameSource {
  findGame(id: string): Promise<GameDocumentInput | null>;
}

export interface SearchIndexWorkerOptions {
  /** Called when indexing a game fails or rejects. Defaults to console.error. Never rethrows. */
  readonly onError?: (gameId: string, err: unknown) => void;
}

/**
 * Type guard for game-ended event payloads crossing process boundaries.
 */
function isGameEndedMessage(msg: unknown): msg is { readonly t: 'ended'; readonly gameId: string } {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return obj['t'] === 'ended' && typeof obj['gameId'] === 'string' && obj['gameId'].trim().length > 0;
}

/**
 * Worker that subscribes to game-ended events once and automatically indexes
 * finished games in real-time.
 */
export class SearchIndexWorker {
  /**
   * Cap on the dedup set so a worker running indefinitely over every finished
   * game does not grow memory without bound. Indexing is an upsert, so an
   * evicted-then-redelivered game is safely reindexed.
   */
  private static readonly MAX_SEEN = 10_000;

  private unsubscribe: (() => void) | undefined;
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly subscriber: SearchIndexSubscriber,
    private readonly channel: string,
    private readonly source: SearchGameSource,
    private readonly repo: SearchRepository,
    private readonly options: SearchIndexWorkerOptions = {},
  ) {}

  /** Start listening for game-ended broadcasts. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.subscriber.subscribe(this.channel, (msg) => {
      if (!isGameEndedMessage(msg)) return;
      const { gameId } = msg;

      if (this.seen.has(gameId)) return;

      // Bound the dedup set with FIFO eviction (Set preserves insertion order).
      if (this.seen.size >= SearchIndexWorker.MAX_SEEN) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) {
          this.seen.delete(oldest);
        }
      }
      this.seen.add(gameId);

      const promise = (async () => {
        try {
          const gameInput = await this.source.findGame(gameId);
          // Not indexable right now: either the row is not visible yet, or the game
          // is aborted (`result === '*'`).
          //
          // Release the dedup slot before returning. The `games` projection is written
          // by a different process than the one broadcasting `ended`, so a lagging row
          // is indistinguishable here from a genuinely aborted game. Keeping the id in
          // `seen` would make that lag permanent — the game would stay missing from the
          // index until an operator reran `reindex-search`. Freeing the slot costs one
          // cheap re-read on a redelivery and keeps aborted games unindexed either way.
          if (!gameInput || gameInput.result === '*') {
            this.seen.delete(gameId);
            return;
          }

          const doc = gameToDocument(gameInput);
          await this.repo.index(doc);
        } catch (err: unknown) {
          this.seen.delete(gameId);
          try {
            if (this.options.onError) {
              this.options.onError(gameId, err);
            } else {
              // eslint-disable-next-line no-console
              console.error(`[SearchIndexWorker] Indexing failed for game ${gameId}:`, err);
            }
          } catch {
            /* error hook must never throw or break worker */
          }
        }
      })();

      this.inFlight.add(promise);
      void promise.finally(() => {
        this.inFlight.delete(promise);
      });
    });
  }

  /** Stop listening for broadcasts and clear local state. Idempotent. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.seen.clear();
  }

  /** Test hook to await all currently in-flight indexing tasks deterministically. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }
}
