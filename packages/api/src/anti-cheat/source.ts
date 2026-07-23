import type { Variant } from '@chess-platform/core';
import type { EventStore } from '@chess-platform/persistence';
import { Game } from '@chess-platform/game';

export interface FinishedGame {
  readonly moves: readonly string[];
  readonly variant: Variant;
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
    const state = Game.fromEvents(stored.map((e) => e.event)).snapshot();
    if (!state.status.over) return null;
    if (!state.players.white || !state.players.black) return null;
    return {
      moves: state.moves.map((m) => m.uci),
      variant: state.variant,
      white: state.players.white,
      black: state.players.black,
    };
  }
}
