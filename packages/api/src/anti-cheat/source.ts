import type { Variant } from '@chess-platform/core';
import type { EventStore } from '@chess-platform/persistence';
import { Game } from '@chess-platform/game';

export interface FinishedGame {
  readonly moves: readonly string[];
  readonly variant: Variant;
  /**
   * The position the game started from.
   *
   * Carried rather than re-derived from `variant`: since ADR-0137 a Chess960 game starts from
   * whichever of the 960 arrangements the server drew, so `Position.initial(variant)` names the right
   * board for seven variants and the wrong one for most Chess960 games.
   */
  readonly initialFen: string;
  readonly white: string;
  readonly black: string;
}

export interface FinishedGameSource {
  load(gameId: string): Promise<FinishedGame | null>;
}

export class EventStoreGameSource implements FinishedGameSource {
  constructor(private readonly events: EventStore) {}

  async load(gameId: string): Promise<FinishedGame | null> {
    const stored = await this.events.load(gameId);
    if (stored.length === 0) return null;
    const events = stored.map((e) => e.event);
    // Read from the creation event rather than the folded state: the aggregate keeps the *current*
    // position, and what a replay needs is the one the game began at. The store guarantees the first
    // event is `GameCreated`, so this is a read rather than a search.
    const created = events[0];
    if (created?.type !== 'GameCreated') return null;
    const state = Game.fromEvents(events).snapshot();
    if (!state.status.over) return null;
    if (!state.players.white || !state.players.black) return null;
    return {
      moves: state.moves.map((m) => m.uci),
      variant: state.variant,
      initialFen: created.initialFen,
      white: state.players.white,
      black: state.players.black,
    };
  }
}
