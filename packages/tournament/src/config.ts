import type { Variant } from '@chess-platform/core';
import type { TimeControl } from '@chess-platform/game';

/**
 * Base configuration shared by all tournament formats.
 */
export interface TournamentConfig {
  /** Unique identifier for the tournament. */
  readonly id: string;
  /** Human-readable name of the tournament. */
  readonly name: string;
  /** The tournament format. Discriminated union. */
  readonly format: 'round_robin';
  /** The chess variant played in this tournament. */
  readonly variant: Variant;
  /** The time control applied to all games in this tournament. */
  readonly timeControl: TimeControl;
}
