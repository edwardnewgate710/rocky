import type { TournamentService, ArenaService } from '@chess-platform/api';
import type { GameResult } from '@chess-platform/tournament';
import { type PubSub, gameChannel } from '@chess-platform/realtime-gateway';
import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot } from '@chess-platform/persistence';

export class TournamentResultReporter {
  constructor(
    private readonly pubsub: PubSub,
    private readonly repo: TournamentsRepository,
    private readonly tournamentService: TournamentService,
    private readonly arenaService: ArenaService
  ) {}

  watch(tournamentId: string, gameId: string): void {
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), async (msg) => {
      if (msg.t === 'ended') {
        unsubscribe();
        
        let mappedResult: GameResult;
        if (msg.result === '1-0') {
          mappedResult = 'white_win';
        } else if (msg.result === '0-1') {
          mappedResult = 'black_win';
        } else if (msg.result === '1/2-1/2') {
          mappedResult = 'draw';
        }

        try {
          const snap = await this.repo.findById(tournamentId);
          if (!snap) return;

          const isArena = isArenaSnapshot(snap);

          if (msg.result === '*') {
            // '*' (aborted): no result. Abandon the game so a fresh one is
            // launched for the same pairing and the round can still finish.
            if (isArena) {
              await this.arenaService.abandonGame(tournamentId, gameId);
            } else {
              await this.tournamentService.abandonGame(tournamentId, gameId);
            }
            return;
          }

          if (isArena) {
            await this.arenaService.recordResultByGame(tournamentId, gameId, mappedResult!);
          } else {
            await this.tournamentService.recordResultByGame(tournamentId, gameId, mappedResult!);
          }
        } catch (e: any) {
          // Swallow duplicate or already recorded results
          console.error(`TournamentResultReporter: Error processing result for game ${gameId}:`, e);
        }
      }
    });
  }
}
