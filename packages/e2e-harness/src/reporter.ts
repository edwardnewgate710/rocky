import type { TournamentService } from '@chess-platform/api';
import type { GameResult } from '@chess-platform/tournament';
import { type PubSub, gameChannel } from '@chess-platform/realtime-gateway';

export class TournamentResultReporter {
  constructor(
    private readonly pubsub: PubSub,
    private readonly tournamentService: TournamentService
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
        } else {
          // '*' (aborted): no result. Abandon the game so a fresh one is
          // launched for the same pairing and the round can still finish.
          try {
            await this.tournamentService.abandonGame(tournamentId, gameId);
          } catch (e: any) {
            console.error(`TournamentResultReporter: Error abandoning game ${gameId}:`, e);
          }
          return;
        }

        try {
          await this.tournamentService.recordResultByGame(tournamentId, gameId, mappedResult);
        } catch (e: any) {
          // Swallow duplicate or already recorded results
          console.error(`TournamentResultReporter: Error recording result for game ${gameId}:`, e);
        }
      }
    });
  }
}
