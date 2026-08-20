/**
 * @packageDocumentation
 * The event-sourced `Game` aggregate — the authoritative model of a single
 * chess game. Commands validate an intent against current state and return the
 * emitted {@link GameEvent}s plus the resulting `Game`. State is always a pure
 * fold of events, so {@link Game.fromEvents} reconstructs any game exactly.
 *
 * The server is the sole authority: legality is decided here via
 * `@chess-platform/core`, never by clients.
 */

import { Position, opposite, parseFen, typeOf, type Color, type Variant, repetitionKey } from '@chess-platform/core';
import {
  charge,
  hasFlagged,
  initClock,
  type ClockState,
  type TimeControl,
} from './clock';
import type {
  GameEvent,
  MovePlayedEvent,
  Players,
  ResultString,
  Termination,
} from './events';

/** Raised when a command is invalid for the current game state. */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameError';
  }
}

/** Terminal or ongoing status of a game. */
export type GameStatus =
  | { readonly over: false }
  | {
      readonly over: true;
      readonly result: ResultString;
      readonly termination: Termination;
      readonly winner: Color | null;
    };

/**
 * Map from repetition key → occurrence count. Part of {@link GameState} so it
 * survives `Game.fromEvents` replay (the reducer builds it, not a side channel).
 */
export type RepetitionHistory = ReadonlyMap<string, number>;

/** Immutable snapshot of a game's derived state. */
export interface GameState {
  readonly gameId: string;
  readonly variant: Variant;
  readonly players: Players;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly createdAt: number;
  readonly position: Position;
  readonly clock: ClockState;
  readonly ply: number;
  readonly moves: readonly MovePlayedEvent[];
  readonly status: GameStatus;
  readonly drawOffer: Color | null;
  /** Position-key → occurrence count, for threefold-repetition detection. */
  readonly repetition: RepetitionHistory;
}

/** Parameters to create a new game. */
export interface CreateGameParams {
  readonly gameId: string;
  readonly variant?: Variant;
  readonly initialFen?: string;
  readonly timeControl: TimeControl;
  readonly players: Players;
  readonly rated?: boolean;
  readonly at: number;
}

const ONGOING: GameStatus = { over: false };

// Re-exported for backward compatibility with tests and consumers.
export { repetitionKey } from '@chess-platform/core';

export class Game {
  private constructor(private readonly state: GameState) {}

  /**
   * Create a new game, returning the aggregate and its `GameCreated` event.
   *
   * Rejects `chess960`, and does so here rather than only at the API, because this is the one place
   * every game is born: seek acceptance, the bot route and the tournament launcher all arrive at
   * this call, and a future fourth caller would inherit the rule instead of having to remember it.
   *
   * The reason is not policy but honesty about what the engine can do. `Position.initial('chess960')`
   * returns the standard array — verified identical to `Position.initial('standard')` — and castling
   * generation is hardcoded to e1/a1/h1, so the only Chess960 arrangement that works is the one that
   * is ordinary chess. Creating the game anyway wrote `variant: 'chess960'` beside a standard
   * `initialFen` into an append-only event store, which is a durable lie: the row says a rule set the
   * position never used, and nothing downstream can tell it from a real one.
   *
   * ADR-0099 withheld the variant from the lobby and deliberately left the server contract open.
   * ADR-0123 closes it, because a client-side list cannot be an invariant. See ADR-0123 for what
   * implementing the variant properly requires; `chess960` stays in `Variant` throughout, since
   * reading and analysing such a position is legitimate and only *creating* one is not.
   */
  static create(params: CreateGameParams): { game: Game; events: GameEvent[] } {
    const variant = params.variant ?? 'standard';
    if (variant === 'chess960') {
      throw new GameError(
        'chess960 games cannot be created: the variant is named but not implemented, so the game ' +
          'would start from the standard position. See ADR-0123.',
      );
    }
    const initialFen = params.initialFen ?? Position.initial(variant).fen();
    const event: GameEvent = {
      type: 'GameCreated',
      gameId: params.gameId,
      variant,
      initialFen,
      timeControl: params.timeControl,
      players: params.players,
      rated: params.rated ?? false,
      at: params.at,
    };
    return { game: Game.fromEvents([event]), events: [event] };
  }

  /** Reconstruct a game by folding its full event history. */
  static fromEvents(events: readonly GameEvent[]): Game {
    let state: GameState | null = null;
    for (const event of events) {
      state = Game.reduce(state, event);
    }
    if (state === null) throw new GameError('Cannot reconstruct a game from zero events');
    return new Game(state);
  }

  /** The current derived state (read-only). */
  snapshot(): GameState {
    return this.state;
  }

  get status(): GameStatus {
    return this.state.status;
  }

  get turn(): Color {
    return this.state.position.turn;
  }

  get fen(): string {
    return this.state.position.fen();
  }

  // --- Commands ----------------------------------------------------------

  /**
   * Play a move (UCI). Emits `MovePlayed` and, if the position becomes terminal
   * or the mover flags, a following `GameEnded`. Throws on illegal moves,
   * wrong turn, or a finished game.
   */
  playMove(uci: string, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const s = this.state;
    const mover = s.position.turn;

    // Flag check first: a move submitted after the clock expired does not count.
    const charged = charge(s.clock, mover, at, s.timeControl);
    if (charged.flagged) {
      return this.endByTimeout(mover, at);
    }

    let nextPos: Position;
    let san: string;
    try {
      const move = this.resolveMove(uci);
      san = s.position.toSan(move);
      nextPos = s.position.play(move);
    } catch (err) {
      throw new GameError(`Illegal move "${uci}": ${(err as Error).message}`);
    }

    const moveEvent: MovePlayedEvent = {
      type: 'MovePlayed',
      ply: s.ply + 1,
      uci,
      san,
      by: mover,
      moveTimeMs: charged.moveTimeMs,
      remaining: charged.clock.remaining,
      at,
    };
    const events: GameEvent[] = [moveEvent];

    const posStatus = nextPos.status();
    if (posStatus.over) {
      events.push(this.terminalEventFor(posStatus, at));
    } else {
      // Check threefold repetition: if the new position's key has occurred
      // 3 times (including this one), the game ends as a draw.
      const key = repetitionKey(nextPos.snapshot());
      if ((s.repetition.get(key) ?? 0) + 1 >= 3) {
        events.push({
          type: 'GameEnded',
          result: '1/2-1/2',
          termination: 'threefold',
          winner: null,
          at,
        });
      }
    }

    return { game: Game.applyAll(this, events), events };
  }

  /** Resign as `color`. */
  resign(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: color === 'w' ? '0-1' : '1-0',
      termination: 'resignation',
      winner: opposite(color),
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Offer a draw as `color`. */
  offerDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    if (this.state.drawOffer === color) {
      throw new GameError('Draw already offered by this side');
    }
    const events: GameEvent[] = [{ type: 'DrawOffered', by: color, at }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Accept an outstanding draw offer made by the opponent of `color`. */
  acceptDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const offer = this.state.drawOffer;
    if (offer === null || offer === color) {
      throw new GameError('No draw offer from the opponent to accept');
    }
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: '1/2-1/2',
      termination: 'agreement',
      winner: null,
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Decline the outstanding draw offer as `color`. */
  declineDraw(color: Color, at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    if (this.state.drawOffer === null) throw new GameError('No draw offer to decline');
    const events: GameEvent[] = [{ type: 'DrawDeclined', by: color, at }];
    return { game: Game.applyAll(this, events), events };
  }

  /** Claim the side-to-move has flagged (opponent's clock claim). */
  claimFlag(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    const s = this.state;
    const sideToMove = s.position.turn;
    if (!hasFlagged(s.clock, sideToMove, at, s.timeControl)) {
      throw new GameError('Opponent has not flagged');
    }
    return this.endByTimeout(sideToMove, at);
  }

  /** Abort the game (allowed only before both players have moved). */
  abort(at: number): { game: Game; events: GameEvent[] } {
    this.assertOngoing();
    if (this.state.ply >= 2) throw new GameError('Game can no longer be aborted');
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: '*',
      termination: 'aborted',
      winner: null,
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  // --- Internals ---------------------------------------------------------

  private assertOngoing(): void {
    if (this.state.status.over) throw new GameError('Game is already over');
  }

  private resolveMove(uci: string) {
    // Position.play validates legality; we resolve to a Move for SAN first.
    const legal = this.state.position.legalMoves();
    for (const m of legal) {
      if (this.state.position.toUci(m) === uci) return m;
    }
    throw new GameError(`No legal move matches "${uci}"`);
  }

  private endByTimeout(flagged: Color, at: number): { game: Game; events: GameEvent[] } {
    const winner = opposite(flagged);
    // If the side that would win on time cannot possibly mate, it is a draw.
    const drawByInsufficient = !canMate(this.state.position.fen(), winner, this.state.variant);
    const events: GameEvent[] = [{
      type: 'GameEnded',
      result: drawByInsufficient ? '1/2-1/2' : winner === 'w' ? '1-0' : '0-1',
      termination: drawByInsufficient ? 'insufficient_material' : 'timeout',
      winner: drawByInsufficient ? null : winner,
      at,
    }];
    return { game: Game.applyAll(this, events), events };
  }

  private terminalEventFor(
    posStatus: Exclude<ReturnType<Position['status']>, { over: false }>,
    at: number,
  ): GameEvent {
    switch (posStatus.reason) {
      case 'checkmate':
        return {
          type: 'GameEnded',
          result: posStatus.winner === 'w' ? '1-0' : '0-1',
          termination: 'checkmate',
          winner: posStatus.winner,
          at,
        };
      case 'variant_win':
        return {
          type: 'GameEnded',
          result: posStatus.winner === 'w' ? '1-0' : '0-1',
          termination: 'variant',
          winner: posStatus.winner,
          at,
        };
      case 'stalemate':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'stalemate', winner: null, at };
      case 'insufficient_material':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'insufficient_material', winner: null, at };
      case 'fifty_move':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'fifty_move', winner: null, at };
      case 'threefold':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'threefold', winner: null, at };
      case 'variant_draw':
        return { type: 'GameEnded', result: '1/2-1/2', termination: 'variant', winner: null, at };
    }
  }

  private static applyAll(game: Game, events: readonly GameEvent[]): Game {
    let state: GameState = game.state;
    for (const event of events) state = Game.reduce(state, event);
    return new Game(state);
  }

  /** The pure reducer: `(state, event) -> state`. */
  private static reduce(state: GameState | null, event: GameEvent): GameState {
    switch (event.type) {
      case 'GameCreated': {
        const position = Position.fromFen(event.initialFen, event.variant);
        // Seed the repetition history with the initial position (count = 1).
        const rep = new Map<string, number>();
        rep.set(repetitionKey(position.snapshot()), 1);
        return {
          gameId: event.gameId,
          variant: event.variant,
          players: event.players,
          timeControl: event.timeControl,
          rated: event.rated,
          createdAt: event.at,
          position,
          clock: initClock(event.timeControl, event.at),
          ply: 0,
          moves: [],
          status: ONGOING,
          drawOffer: null,
          repetition: rep,
        };
      }
      case 'MovePlayed': {
        if (state === null) throw new GameError('MovePlayed before GameCreated');
        const position = state.position.play(event.uci);
        const charged = charge(state.clock, event.by, event.at, state.timeControl, event.moveTimeMs);
        // Update repetition history: increment the count for the new position's key.
        const key = repetitionKey(position.snapshot());
        const rep = new Map(state.repetition);
        rep.set(key, (rep.get(key) ?? 0) + 1);
        return {
          ...state,
          position,
          clock: charged.clock,
          ply: event.ply,
          moves: [...state.moves, event],
          drawOffer: null,
          repetition: rep,
        };
      }
      case 'DrawOffered': {
        if (state === null) throw new GameError('DrawOffered before GameCreated');
        return { ...state, drawOffer: event.by };
      }
      case 'DrawDeclined': {
        if (state === null) throw new GameError('DrawDeclined before GameCreated');
        return { ...state, drawOffer: null };
      }
      case 'GameEnded': {
        if (state === null) throw new GameError('GameEnded before GameCreated');
        return {
          ...state,
          status: { over: true, result: event.result, termination: event.termination, winner: event.winner },
          drawOffer: null,
        };
      }
    }
  }
}

/**
 * Whether `color` could still win, used to convert a timeout into a draw when the opponent could
 * not possibly have won anyway.
 *
 * The question is variant-specific, and asking the standard one everywhere is wrong in a way that
 * costs players games. "Enough material to deliver checkmate" only means anything in a variant whose
 * win condition *is* checkmate. King of the Hill is won by walking a king to the centre; Racing
 * Kings by reaching the eighth rank; Three-check by giving three checks; Atomic by exploding the
 * enemy king; Crazyhouse by dropping the pieces in hand, which the board position does not show at
 * all. Treating those as standard chess turned a win into a draw whenever the loser flagged.
 *
 * Conservative in one direction on purpose: it answers "could this side possibly win", so where the
 * honest answer is unclear it says yes. Awarding a draw the winner did not deserve is the failure
 * mode worth avoiding; the guard exists only to spare someone a loss they could never have converted.
 */
export function canMate(fen: string, color: Color, variant: Variant = 'standard'): boolean {
  const st = parseFen(fen, variant);

  let bishops = 0;
  let knights = 0;
  let majorOrPawn = false;
  let anyPiece = false;
  for (let sq = 0; sq < 128; sq++) {
    if ((sq & 0x88) !== 0) continue;
    const p = st.board[sq];
    if (p === null) continue;
    const isWhite = p === p.toUpperCase();
    if ((isWhite && color !== 'w') || (!isWhite && color !== 'b')) continue;
    const t = typeOf(p);
    if (t === 'k') continue;
    anyPiece = true;
    if (t === 'p' || t === 'r' || t === 'q') majorOrPawn = true;
    else if (t === 'b') bishops++;
    else if (t === 'n') knights++;
  }

  switch (variant) {
    case 'kingofthehill':
    case 'racingkings':
      // Both are won by walking a king somewhere. A player reduced to a bare king still has the only
      // piece the win condition needs, so material can never rule the win out.
      return true;

    case 'crazyhouse':
      // Anything in hand can be dropped, and the board alone never shows it — but the deciding point
      // is that a king captures like any other piece, so even a bare king with an empty pocket can
      // take something and drop it back. There is no material configuration from which winning is
      // impossible, which makes the guard inapplicable rather than merely generous.
      return true;

    case 'threecheck':
      // Won by giving three checks rather than by mating, so the two-minor threshold does not apply:
      // a lone knight can check. Only a bare king can never give check.
      return anyPiece;

    case 'atomic':
      // Won by exploding the enemy king. A king may not capture — it would explode itself — so a bare
      // king cannot win, but any other piece can deliver the capture that ends it.
      return anyPiece;

    case 'horde':
      // White is an army of pawns with no king and wins by mating Black; Black wins by capturing
      // every white piece, and a king captures perfectly well on its own. Neither side reaches a
      // material state that rules the win out, so as in Crazyhouse the guard does not apply.
      return true;

    case 'standard':
    case 'chess960':
    default:
      // Checkmate is the win condition, so the classical material test applies: a lone king, K+N and
      // K+B cannot force mate; two minors can.
      if (majorOrPawn) return true;
      return bishops + knights >= 2;
  }
}
