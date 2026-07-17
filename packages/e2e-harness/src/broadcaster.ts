import type { PubSub, GameAuthority, Unsubscribe } from '@chess-platform/realtime-gateway';
import type { TournamentLiveView, LiveBoard } from '@chess-platform/api';
import { tournamentChannel, gameChannel } from '@chess-platform/realtime-gateway';

/**
 * Bridges the real-time gameplay layer and the tournament API, providing live
 * state for active tournament boards.
 *
 * Implements the {@link TournamentLiveView} port for the REST API (fetching
 * current snapshot on demand) and listens to game pub/sub to fan out live
 * updates to tournament spectators.
 */
export class TournamentBroadcaster implements TournamentLiveView {
  private readonly active = new Map<string, Set<string>>();
  private readonly unsubs = new Map<string, Unsubscribe>();

  constructor(
    private readonly authority: GameAuthority,
    private readonly pubsub: PubSub,
  ) {}

  activeGames(tournamentId: string): LiveBoard[] {
    const gameIds = this.active.get(tournamentId);
    if (!gameIds) return [];
    
    const boards: LiveBoard[] = [];
    for (const gid of gameIds) {
      try {
        const state = this.authority.getState(gid);
        boards.push({
          gameId: gid,
          white: state.players.white,
          black: state.players.black,
          ply: state.ply,
          turn: state.turn,
          fen: state.fen,
          fenHash: state.fenHash,
          clock: state.clock,
          status: state.status,
        });
      } catch (e) {
        // Game state missing (e.g. wiped or invalid gameId)
      }
    }
    return boards;
  }

  /** Track a newly launched game as part of a tournament. */
  track(tournamentId: string, gameId: string): void {
    let set = this.active.get(tournamentId);
    if (!set) {
      set = new Set();
      this.active.set(tournamentId, set);
    }
    
    // Prevent double-tracking the same game
    if (set.has(gameId)) return;
    
    set.add(gameId);

    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => {
      if (msg.t === 'move' || msg.t === 'ended') {
        if (msg.t === 'ended') {
          // Cleanup when the game ends
          this.untrack(tournamentId, gameId);
        }
        
        // Broadcast the updated live state of the entire tournament
        this.pubsub.publish(tournamentChannel(tournamentId), {
          t: 'tournamentUpdate',
          tournamentId,
          games: this.activeGames(tournamentId),
          serverTs: msg.serverTs,
        });
      }
    });
    
    this.unsubs.set(gameId, unsubscribe);
  }

  private untrack(tournamentId: string, gameId: string): void {
    const set = this.active.get(tournamentId);
    if (set) {
      set.delete(gameId);
      if (set.size === 0) {
        this.active.delete(tournamentId);
      }
    }
    const unsub = this.unsubs.get(gameId);
    if (unsub) {
      unsub();
      this.unsubs.delete(gameId);
    }
  }
}
