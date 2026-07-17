import type { Color } from '@chess-platform/core';
import type { ResultString, Termination } from '@chess-platform/game';

/** Remaining clock, milliseconds, for both sides. */
export interface LiveClockView {
  readonly w: number;
  readonly b: number;
}

/** 
 * A minimal live snapshot of a single board within a tournament. 
 * This structurally matches `LiveBoardView` in the gateway, but is defined here
 * so `api` remains fully decoupled from `realtime-gateway`.
 */
export interface LiveBoard {
  readonly gameId: string;
  readonly white: string;
  readonly black: string;
  readonly ply: number;
  readonly turn: Color;
  readonly fen: string;
  readonly fenHash: string;
  readonly clock: LiveClockView;
  readonly status:
    | { readonly over: false }
    | {
        readonly over: true;
        readonly result: ResultString;
        readonly termination: Termination;
        readonly winner: Color | null;
      };
}

/**
 * Port for accessing the live active games of a tournament.
 * Implemented in the composition root (where the GameAuthority is available).
 */
export interface TournamentLiveView {
  activeGames(tournamentId: string): LiveBoard[] | Promise<LiveBoard[]>;
}
