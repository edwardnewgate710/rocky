import { Game, type GameEvent } from '@chess-platform/game';
import { Position, type Color, type Variant } from '@chess-platform/core';
import type { EventStore } from '@chess-platform/persistence';

/** One durable move together with the position it was played from. */
export interface FinishedGameReviewMove {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
  readonly fenBefore: string;
}

/** The private, completed-game source a player review is allowed to read. */
export interface FinishedGameForReview {
  readonly gameId: string;
  readonly variant: Variant;
  readonly white: string;
  readonly black: string;
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly termination: string;
  readonly moves: readonly FinishedGameReviewMove[];
}

/** Returns no data for an unknown or still-live game, avoiding a live-game oracle. */
export interface FinishedGameReviewArchive {
  finishedGameForReview(gameId: string): Promise<FinishedGameForReview | undefined>;
}

/** Reads completed game history from the authoritative event stream. */
export class DurableFinishedGameReviewArchive implements FinishedGameReviewArchive {
  constructor(private readonly events: EventStore) {}

  async finishedGameForReview(gameId: string): Promise<FinishedGameForReview | undefined> {
    const stored = await this.events.load(gameId);
    if (stored.length === 0) return undefined;

    const events = stored.map((entry) => entry.event);
    const game = Game.fromEvents(events);
    const state = game.snapshot();
    if (!state.status.over || state.status.result === '*') return undefined;

    const moves = reviewMoves(events);

    return {
      gameId,
      variant: state.variant,
      white: state.players.white,
      black: state.players.black,
      result: state.status.result,
      termination: state.status.termination,
      moves,
    };
  }
}

/** Capture pre-move positions in one forward pass instead of replaying every event prefix. */
function reviewMoves(events: readonly GameEvent[]): FinishedGameReviewMove[] {
  const created = events[0];
  if (created?.type !== 'GameCreated') {
    // The full aggregate replay above already enforces this invariant. Keep the local guard so this
    // helper remains total if archive assembly is later rearranged.
    throw new Error('completed game history must start with GameCreated');
  }

  let position = Position.fromFen(created.initialFen, created.variant);
  const moves: FinishedGameReviewMove[] = [];
  for (const event of events.slice(1)) {
    if (event.type !== 'MovePlayed') continue;
    moves.push({
      ply: event.ply,
      uci: event.uci,
      san: event.san,
      by: event.by,
      fenBefore: position.fen(),
    });
    position = position.play(event.uci);
  }
  return moves;
}
