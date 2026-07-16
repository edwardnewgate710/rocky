import type { Variant } from '@chess-platform/core';
import type { TimeControl } from '@chess-platform/game';

/**
 * Round-robin tournament configuration.
 * Number of rounds is derived from participant count (N−1 for even N, N for odd N).
 */
export interface RoundRobinConfig {
  readonly id: string;
  readonly name: string;
  readonly format: 'round_robin';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
}

/**
 * Swiss tournament configuration.
 * The number of rounds is explicitly configured.
 */
export interface SwissConfig {
  readonly id: string;
  readonly name: string;
  readonly format: 'swiss';
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  /** The number of rounds to play. */
  readonly rounds: number;
}

/**
 * Discriminated union of all tournament configurations.
 */
export type TournamentConfig = RoundRobinConfig | SwissConfig;
