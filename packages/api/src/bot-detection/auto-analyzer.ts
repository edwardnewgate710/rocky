import { type PubSub, gamesEndedChannel } from '@chess-platform/realtime-gateway';
import type { GameBotReport } from '@chess-platform/anti-cheat';

/** The narrow analysis capability the worker needs (satisfied by BotAnalysisService). */
export interface BotGameAnalyzer {
  analyzeAndStore(gameId: string): Promise<GameBotReport | null>;
}

export interface BotAutoAnalyzerOptions {
  /** Called when a game's analysis rejects. Defaults to console.error. Never rethrow. */
  readonly onError?: (gameId: string, err: unknown) => void;
}

/**
 * Worker that subscribes to the global `gamesEndedChannel()` once and
 * automatically triggers bot detection analysis for finished games.
 */
export class BotAutoAnalyzer {
  /**
   * Cap on the dedup set so a worker running indefinitely over every finished
   * game doesn't grow it without bound. Analysis is idempotent (the service
   * upserts), so an evicted-then-redelivered game is safely re-analyzed.
   */
  private static readonly MAX_SEEN = 10_000;

  private unsubscribe: (() => void) | undefined;
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly pubsub: PubSub,
    private readonly analyzer: BotGameAnalyzer,
    private readonly options: BotAutoAnalyzerOptions = {},
  ) {}

  /** Start listening for game end broadcasts. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pubsub.subscribe(gamesEndedChannel(), (msg) => {
      if (msg.t !== 'ended') return;
      const { gameId } = msg;
      if (this.seen.has(gameId)) return;
      // Bound the dedup set with FIFO eviction (Set preserves insertion order).
      if (this.seen.size >= BotAutoAnalyzer.MAX_SEEN) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      this.seen.add(gameId);

      const promise = (async () => {
        try {
          await this.analyzer.analyzeAndStore(gameId);
        } catch (err: unknown) {
          this.seen.delete(gameId);
          // Contain the error hook: a throwing onError must never reject this
          // promise (which would surface as an unhandled rejection and fail drain()).
          try {
            if (this.options.onError) {
              this.options.onError(gameId, err);
            } else {
              console.error(`[BotAutoAnalyzer] Analysis failed for game ${gameId}:`, err);
            }
          } catch {
            /* an error hook must never break the worker */
          }
        }
      })();

      this.inFlight.add(promise);
      void promise.finally(() => {
        this.inFlight.delete(promise);
      });
    });
  }

  /** Stop listening for broadcasts and clear local state. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.seen.clear();
  }

  /** Test hook to await all currently in-flight analyses deterministically. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }
}
