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
 * Pluggable port for tournament pairing strategies (e.g. Round Robin, Swiss, Arena).
 */
export interface PairingStrategy {
  /**
   * Given an array of registered player IDs, generates the rounds for the tournament.
   * A strategy like Round Robin returns all rounds up front, whereas dynamic
   * strategies like Swiss might return only the first round (or we'd need a more dynamic interface later).
   * For M9 Inc 1, this returns the full static schedule.
   * 
   * @param participants The list of participant IDs.
   * @returns An array of rounds.
   */
  generateRounds(participants: readonly string[]): Round[];
}
