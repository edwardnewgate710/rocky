import type { GameResult } from './standings';

/**
 * Represents a pairing between two players in a tournament round.
 */
export interface GamePairing {
  readonly kind: 'game';
  /** The ID of the player assigned white pieces. */
  readonly white: string;
  /** The ID of the player assigned black pieces. */
  readonly black: string;
}

/**
 * Represents a bye assigned to a player in a tournament round.
 */
export interface ByePairing {
  readonly kind: 'bye';
  /** The ID of the player receiving the bye. */
  readonly player: string;
}

export type Pairing = GamePairing | ByePairing;

/**
 * A full round of pairings.
 */
export interface Round {
  readonly roundIndex: number;
  readonly pairings: Pairing[];
}

/**
 * A completed round: the pairings plus their results.
 */
export interface CompletedRound {
  readonly round: Round;
  /** matchId (roundIndex-pairingIndex) → result */
  readonly results: ReadonlyMap<string, GameResult | 'bye'>;
}

/**
 * Per-player history accumulated over the tournament so far.
 */
export interface PlayerHistory {
  /** IDs of opponents already faced. */
  readonly opponents: readonly string[];
  /** Number of games played as white. */
  readonly whiteCount: number;
  /** Number of games played as black. */
  readonly blackCount: number;
  /** Number of byes received. */
  readonly byeCount: number;
  /** Current tournament points. */
  readonly points: number;
}

/**
 * Context provided to a pairing strategy for generating the next round.
 */
export interface PairingContext {
  /** All registered participant IDs, in seed order. */
  readonly participants: readonly string[];
  /** 0-based index of the next round to generate. */
  readonly roundNumber: number;
  /** All previously completed rounds with their results. */
  readonly completedRounds: readonly CompletedRound[];
  /** Per-player accumulated history. Keyed by player ID. */
  readonly playerHistory: ReadonlyMap<string, PlayerHistory>;
}

/**
 * Pluggable port for tournament pairing strategies (Round Robin, Swiss, Arena, …).
 *
 * Generates ONE round at a time from the current tournament state.
 * Returns `null` when no further rounds should be played (tournament complete).
 */
export interface PairingStrategy {
  pairNextRound(context: PairingContext): Round | null;
}
