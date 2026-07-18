import type { GameResult } from '@chess-platform/tournament';
import type { ResultString } from '@chess-platform/game';
import { type PubSub, gameChannel } from '@chess-platform/realtime-gateway';
import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot } from '@chess-platform/persistence';
import type { TournamentService } from './service';
import type { ArenaService } from './arena.service';

export interface ReporterOptions {
  /**
   * How often to re-scan running tournaments for games launched by OTHER
   * processes (e.g. an API replica handling POST /start). The launcher
   * callback only covers games launched inside this process, and the startup
   * scan only covers games that existed at boot — the periodic scan closes
   * the gap. Pass 0 to disable the timer (tests call `scan()` directly).
   */
  readonly scanIntervalMs?: number;
}

/**
 * Long-running subscriber that records tournament/arena results from
 * authoritative `EndedBroadcast` messages. Discovery of games to watch comes
 * from three sources: the startup scan (`start()`), the periodic re-scan, and
 * the composition root's launcher callback (`watch()`).
 */
export class TournamentResultReporter {
  /** In-flight subscriptions, keyed by gameId, for stop() and cleanup. */
  private readonly subscriptions = new Map<string, () => void>();
  /**
   * Every gameId ever watched. Entries outlive their subscription on purpose:
   * round-based tournaments keep finished games in `gameLinks`, and this set
   * is what stops a later scan from re-subscribing to them.
   */
  private readonly watched = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly scanIntervalMs: number;

  constructor(
    private readonly pubsub: PubSub,
    private readonly repo: TournamentsRepository,
    private readonly tournamentService: TournamentService,
    private readonly arenaService: ArenaService,
    options: ReporterOptions = {}
  ) {
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
  }

  /** Rehydrate watches from storage, then keep re-scanning on an interval. */
  async start(): Promise<void> {
    await this.scan();
    if (this.scanIntervalMs > 0 && this.timer === undefined) {
      this.timer = setInterval(() => {
        void this.scan().catch((err: unknown) => {
          console.error('TournamentResultReporter: periodic scan failed:', err);
        });
      }, this.scanIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Subscribe to every not-yet-watched in-flight game of running tournaments. */
  async scan(): Promise<void> {
    const running = (await this.repo.list(100)).filter((t) => t.state === 'running');
    for (const t of running) {
      const stored = await this.repo.findById(t.id);
      if (!stored) continue;
      for (const [, gameId] of stored.snapshot.gameLinks ?? []) {
        this.watch(t.id, gameId);
      }
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
    this.watched.clear();
  }

  watch(tournamentId: string, gameId: string): void {
    if (this.watched.has(gameId)) return;
    this.watched.add(gameId);
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => {
      if (msg.t !== 'ended') return;
      this.subscriptions.get(gameId)?.();
      this.subscriptions.delete(gameId);
      void this.onEnded(tournamentId, gameId, msg.result).catch((err: unknown) => {
        // Duplicate/already-recorded results and transient failures must never
        // crash the host process; the periodic scan gives lost results another
        // chance only while the game link is still in-flight.
        console.error(`TournamentResultReporter: error processing result for game ${gameId}:`, err);
      });
    });
    this.subscriptions.set(gameId, unsubscribe);
  }

  private async onEnded(
    tournamentId: string,
    gameId: string,
    result: ResultString
  ): Promise<void> {
    const stored = await this.repo.findById(tournamentId);
    if (!stored) return;
    const isArena = isArenaSnapshot(stored.snapshot);

    if (result === '*') {
      // '*' (aborted): no result. Abandon the game so a fresh one is launched
      // for the same pairing and the round can still finish.
      if (isArena) {
        await this.arenaService.abandonGame(tournamentId, gameId);
      } else {
        await this.tournamentService.abandonGame(tournamentId, gameId);
      }
      return;
    }

    const mapped: GameResult =
      result === '1-0' ? 'white_win' : result === '0-1' ? 'black_win' : 'draw';
    if (isArena) {
      await this.arenaService.recordResultByGame(tournamentId, gameId, mapped);
    } else {
      await this.tournamentService.recordResultByGame(tournamentId, gameId, mapped);
    }
  }
}
