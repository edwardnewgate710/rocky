/**
 * @packageDocumentation
 * Event-sourcing types for games. A game is an append-only sequence of events;
 * current state is a fold over them ({@link ../game.Game.fromEvents}). Events
 * are the durable source of truth — projections (PGN, ratings) derive from them.
 */

import type { Color, Variant } from '@chess-platform/core';
import type { TimeControl } from './clock';

/** How a game terminated. */
export type Termination =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'agreement'
  | 'insufficient_material'
  | 'fifty_move'
  | 'threefold'
  | 'variant'
  | 'aborted';

/** Standard result string. */
export type ResultString = '1-0' | '0-1' | '1/2-1/2' | '*';

/** Player references at game creation. */
export interface Players {
  readonly white: string;
  readonly black: string;
}

export interface GameCreatedEvent {
  readonly type: 'GameCreated';
  readonly gameId: string;
  readonly variant: Variant;
  readonly initialFen: string;
  readonly timeControl: TimeControl;
  readonly players: Players;
  readonly rated: boolean;
  readonly at: number;
}

export interface MovePlayedEvent {
  readonly type: 'MovePlayed';
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
  readonly moveTimeMs: number;
  /** Remaining clock (ms) for both sides after this move. */
  readonly remaining: { readonly w: number; readonly b: number };
  readonly at: number;
}

export interface DrawOfferedEvent {
  readonly type: 'DrawOffered';
  readonly by: Color;
  readonly at: number;
}

export interface DrawDeclinedEvent {
  readonly type: 'DrawDeclined';
  readonly by: Color;
  readonly at: number;
}

export interface GameEndedEvent {
  readonly type: 'GameEnded';
  readonly result: ResultString;
  readonly termination: Termination;
  /** Winner, or null for a draw / abort. */
  readonly winner: Color | null;
  readonly at: number;
}

/** The discriminated union of all persisted game events. */
export type GameEvent =
  | GameCreatedEvent
  | MovePlayedEvent
  | DrawOfferedEvent
  | DrawDeclinedEvent
  | GameEndedEvent;
