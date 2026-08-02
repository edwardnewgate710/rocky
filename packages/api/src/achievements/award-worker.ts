/**
 * @packageDocumentation
 * Live worker that listens for game-ended events and awards achievements.
 */
import type {
  AchievementsRepository,
  FinishedGameSummary,
  PlayerStateForEvaluation,
} from '@chess-platform/achievements';
import { evaluateGameAchievements } from '@chess-platform/achievements';

/** Minimal subscriber interface (satisfied by PubSub). */
export interface AchievementsSubscriber {
  subscribe(channel: string, handler: (msg: unknown) => void): () => void;
}

/** Minimal game reader interface for awarding. */
export interface AchievementsGameSource {
  findGame(id: string): Promise<FinishedGameSummary | null>;
}

export interface AchievementsAwardWorkerOptions {
  /** Called when awarding a game fails or rejects. Defaults to console.error. Never rethrows. */
  readonly onError?: (gameId: string, err: unknown) => void;
}

/** Defensive type guard for game-ended broadcast events. */
function isGameEndedMessage(msg: unknown): msg is { readonly t: 'ended'; readonly gameId: string } {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return obj['t'] === 'ended' && typeof obj['gameId'] === 'string' && obj['gameId'].trim().length > 0;
}

export class AchievementsAwardWorker {
  private static readonly MAX_SEEN = 10_000;

  private unsubscribe: (() => void) | undefined;
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly subscriber: AchievementsSubscriber,
    private readonly channel: string,
    private readonly source: AchievementsGameSource,
    private readonly repo: AchievementsRepository,
    private readonly options: AchievementsAwardWorkerOptions = {}
  ) {}

  /** Start listening for game-ended events. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.subscriber.subscribe(this.channel, (msg) => {
      if (!isGameEndedMessage(msg)) return;
      const { gameId } = msg;

      if (this.seen.has(gameId)) return;

      // Bound dedup set with FIFO eviction
      if (this.seen.size >= AchievementsAwardWorker.MAX_SEEN) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) {
          this.seen.delete(oldest);
        }
      }
      this.seen.add(gameId);

      const promise = (async () => {
        try {
          const game = await this.source.findGame(gameId);
          if (!game || game.result === '*') {
            this.seen.delete(gameId);
            return;
          }

          const players = [game.whitePlayerId, game.blackPlayerId];
          const at = new Date();

          // Contained per player, not per game. One try/catch around the whole loop means a player
          // whose award fails — a deleted account, a transient write error — silently costs their
          // opponent every achievement from the same game. The two players did not do anything to
          // each other; a failure on one is not a reason to skip the other.
          let firstFailure: unknown;
          for (const playerId of players) {
            try {
              await this.awardPlayer(game, playerId, at);
            } catch (err: unknown) {
              firstFailure ??= err;
            }
          }
          if (firstFailure !== undefined) {
            throw firstFailure;
          }
        } catch (err: unknown) {
          this.seen.delete(gameId);
          try {
            if (this.options.onError) {
              this.options.onError(gameId, err);
            } else {
              // eslint-disable-next-line no-console
              console.error(`[AchievementsAwardWorker] Awarding failed for game ${gameId}:`, err);
            }
          } catch {
            /* Error hook must never throw */
          }
        }
      })();

      this.inFlight.add(promise);
      void promise.finally(() => {
        this.inFlight.delete(promise);
      });
    });
  }

  /** Evaluates and applies one player's awards for a finished game. */
  private async awardPlayer(
    game: FinishedGameSummary,
    playerId: string,
    at: Date
  ): Promise<void> {
    const page = await this.repo.listPlayerAchievements(playerId);
    const existingAchievements = new Map<string, { progress: number; unlockedAt?: Date }>();
    for (const item of page.items) {
      existingAchievements.set(item.key, {
        progress: item.progress,
        ...(item.unlockedAt ? { unlockedAt: item.unlockedAt } : {}),
      });
    }

    const state: PlayerStateForEvaluation = { playerId, existingAchievements };
    for (const intent of evaluateGameAchievements(game, state)) {
      await this.repo.award(intent.playerId, intent.achievementKey, intent.increment, at);
    }
  }

  /** Stop listening for events and clear seen set. Idempotent. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.seen.clear();
  }

  /** Await all in-flight awarding tasks. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }
}
