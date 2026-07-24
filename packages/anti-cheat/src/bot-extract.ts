import type { Color } from '@chess-platform/core';
import type { TimedMove } from './bot-behavior';

/**
 * One move's timing as recorded by the game authority — the minimal, decoupled
 * projection of a `MovePlayedEvent` this module needs. Map from a real event as
 * `{ by: ev.by, moveTimeMs: ev.moveTimeMs }`.
 */
export interface MoveTiming {
  /** The side that made the move. */
  readonly by: Color;
  /** Wall-clock milliseconds the mover spent (>= 0; from `MovePlayedEvent.moveTimeMs`). */
  readonly moveTimeMs: number;
}

/** Per-player move timings for one game, ready for `analyzeBotBehavior`. */
export interface GameTimings {
  readonly white: TimedMove[];
  readonly black: TimedMove[];
}

/**
 * Split a game's ordered per-move timings into per-player `TimedMove[]` for
 * `analyzeBotBehavior`. Pure and deterministic; does not mutate the input.
 * Opening-book plies (by 0-based game move index) can be marked via `isBook`
 * so the analyzer excludes them — mirrors `extractPlies`.
 */
export function extractTimedMoves(
  moves: readonly MoveTiming[],
  isBook: (moveIndex: number) => boolean = () => false,
): GameTimings {
  const white: TimedMove[] = [];
  const black: TimedMove[] = [];

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const book = isBook(i);
    const timedMove: TimedMove = {
      ms: move.moveTimeMs,
      ...(book ? { isBook: true } : {}),
    };

    if (move.by === 'w') {
      white.push(timedMove);
    } else {
      black.push(timedMove);
    }
  }

  return { white, black };
}
