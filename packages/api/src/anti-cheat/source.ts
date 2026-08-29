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

    // Replay can now throw on a stream this method would previously have folded without complaint:
    // ADR-0137 made `Game.reduce` reject a stored Chess960 start id that is out of range, sits on a
    // non-Chess960 event, or disagrees with the stored FEN. Those throws are the point — a corrupt
    // creation event must not silently become a board — but an anti-cheat *read* is not the place they
    // should surface. This method's contract is "the finished game, or null"; an unanalysable game is
    // an absent one, and letting the error escape would turn a bad row into a failed request on an
    // endpoint that has nothing to do with it. Raised in the CodeRabbit review of PR #12.
    let state;
    try {
      state = Game.fromEvents(events).snapshot();
    } catch {
      return null;
    }
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
