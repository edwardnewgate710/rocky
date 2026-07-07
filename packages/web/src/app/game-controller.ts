/**
 * Game view controller — a pure, DOM-free orchestrator that bridges
 * {@link GameSync} state to the board UI.
 *
 * It subscribes to {@link GameSync} state changes, projects the current FEN
 * from the authoritative snapshot + live move ledger (using the view-only
 * {@link applyMove} mover), and exposes callbacks for position / status / turn /
 * clock updates. Move submissions are forwarded to {@link GameSync}.
 *
 * This module is the "game view" wiring that M6 requires. It imports from the
 * networking layer (`GameSync`, `GameSyncState`) and the presentation core
 * (`applyMove`) — appropriate for the app composition layer — but never touches
 * the DOM. The concrete DOM wiring (connecting these callbacks to `BoardView`)
 * lands in a later increment.
 */
import type { GameSync, GameSyncState } from '../net/game-sync.js';
import type { WsColor } from '../net/ws-protocol.js';
import { applyMove } from '../core/mover.js';
import type { PromotionRole } from '../core/interaction.js';

/**
 * Callbacks the controller invokes when the projected game state changes.
 * The consumer (e.g. `bootstrap` or a future game-view module) wires these to
 * the DOM `BoardView` and status elements.
 */
export interface GameControllerCallbacks {
  /** Called when the projected FEN changes (snapshot applied or move replayed). */
  onPosition: (fen: string) => void;
  /** Called when the side-to-move / my-turn status changes. */
  onTurn: (myTurn: boolean) => void;
  /** Called when the clock values change (ms remaining for white / black). */
  onClock: (whiteMs: number, blackMs: number) => void;
  /** Called when the game status changes (e.g. "playing", "checkmate 1-0"). */
  onStatus: (text: string) => void;
  /**
   * Called when the last move changes (from/to squares), so the board can
   * highlight it. Called with `null` when there are no moves yet.
   */
  onLastMove?: (from: string | null, to: string | null) => void;
  /**
   * Called when the controller's color is first resolved from the server's
   * `joined` message (via `GameSyncState.myColor`). The bootstrap uses this
   * to set board orientation. Called once, with `null` for spectators.
   */
  onColor?: (color: WsColor | null) => void;
}

/**
 * Options for constructing a {@link GameController}.
 */
export interface GameControllerOptions {
  readonly gameSync: GameSync;
  readonly callbacks: GameControllerCallbacks;
}

/**
 * Pure, DOM-free game view controller.
 *
 * Create via the composition root, then call {@link GameController.start} to
 * begin listening to `GameSync` state. Call {@link GameController.stop} to
 * unsubscribe. Call {@link GameController.submitMove} to forward a move
 * intention to the server via `GameSync`.
 */
export class GameController {
  private readonly gameSync: GameSync;
  private readonly callbacks: GameControllerCallbacks;
  private unsubscribe: (() => void) | null = null;
  private currentFen = '';
  private currentMyTurn: boolean | undefined = undefined;
  private currentLastMove: { from: string; to: string } | null | undefined = undefined;
  private currentClock: { w: number; b: number } | undefined = undefined;
  private colorEmitted = false;

  constructor(options: GameControllerOptions) {
    this.gameSync = options.gameSync;
    this.callbacks = options.callbacks;
  }

  /** Start listening to GameSync state changes. */
  start(): void {
    this.unsubscribe = this.gameSync.subscribe((state) => this.handleState(state));
    // Emit the current state immediately (may be pre-join, empty).
    this.handleState(this.gameSync.getState());
  }

  /** Stop listening. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The current projected FEN (valid at the latest applied ply). */
  get fen(): string {
    return this.currentFen;
  }

  /**
   * Submit an intended move (UCI) to the server via GameSync. Returns the
   * pending move info, or `null` if the send failed (e.g. not a player or
   * socket not open).
   */
  submitMove(uci: string): { readonly uci: string; readonly clientSeq: number } | null {
    return this.gameSync.submitMove(uci);
  }

  private handleState(state: GameSyncState): void {
    // --- Position projection ---
    if (state.snapshot !== null) {
      let fen = state.snapshot.fen;
      // Replay only moves that came after the snapshot ply. The snapshot FEN
      // is already the position at snapshot.ply; the moves ledger includes
      // snapshot moves + live broadcasts, so we must skip the pre-snapshot ones.
      for (const move of state.moves) {
        if (move.ply > state.snapshot.ply) {
          fen = applyMove(fen, {
            from: move.uci.slice(0, 2),
            to: move.uci.slice(2, 4),
            ...(move.uci.length > 4 ? { promotion: move.uci[4] as PromotionRole } : {}),
          });
        }
      }
      if (fen !== this.currentFen) {
        this.currentFen = fen;
        this.callbacks.onPosition(fen);
      }
    }

    // --- Color (emit once when resolved from server join) ---
    if (!this.colorEmitted && state.myColor !== null) {
      this.colorEmitted = true;
      this.callbacks.onColor?.(state.myColor);
    } else if (!this.colorEmitted && state.role !== null) {
      // Spectator: role is resolved but myColor is null.
      this.colorEmitted = true;
      this.callbacks.onColor?.(null);
    }

    // --- Turn ---
    // Derive myTurn from GameSyncState: it's our turn only when the server
    // assigned us a color, it's our color's turn, and no optimistic move is
    // pending (the pending===null term closes the stale-oracle race during
    // the optimistic window — see M6). Fire onTurn when the *derived* value
    // changes, not just when state.turn changes, because pending toggles
    // while turn stays constant.
    const myTurn = state.turn !== null
      && state.myColor !== null
      && state.turn === state.myColor
      && state.pending === null;
    if (myTurn !== this.currentMyTurn) {
      this.currentMyTurn = myTurn;
      this.callbacks.onTurn(myTurn);
    }

    // --- Clock (with change detection) ---
    if (state.clock !== null) {
      const clockChanged = this.currentClock === undefined
        || this.currentClock.w !== state.clock.w
        || this.currentClock.b !== state.clock.b;
      if (clockChanged) {
        this.currentClock = { w: state.clock.w, b: state.clock.b };
        this.callbacks.onClock(state.clock.w, state.clock.b);
      }
    }

    // --- Status ---
    const statusText = this.statusText(state);
    this.callbacks.onStatus(statusText);

    // --- Last move ---
    if (this.callbacks.onLastMove) {
      const lastMove = state.moves.length > 0
        ? { from: state.moves[state.moves.length - 1]!.uci.slice(0, 2), to: state.moves[state.moves.length - 1]!.uci.slice(2, 4) }
        : null;
      const changed = (this.currentLastMove === undefined) ||
        (lastMove === null && this.currentLastMove !== null) ||
        (lastMove !== null && (this.currentLastMove === null || this.currentLastMove === undefined ||
          lastMove.from !== this.currentLastMove.from || lastMove.to !== this.currentLastMove.to));
      if (changed) {
        this.currentLastMove = lastMove;
        this.callbacks.onLastMove(lastMove?.from ?? null, lastMove?.to ?? null);
      }
    }
  }

  private statusText(state: GameSyncState): string {
    if (state.status === null) return 'Waiting…';
    if (!state.status.over) {
      if (state.turn === null) return 'Waiting…';
      const turnLabel = state.turn === 'w' ? 'White' : 'Black';
      if (state.myColor === null) return `${turnLabel} to move`;
      const myTurn = state.turn === state.myColor;
      return myTurn ? 'Your move' : `${turnLabel} to move`;
    }
    // Game over
    const { result, termination, winner } = state.status;
    const winnerLabel = winner === 'w' ? 'White' : winner === 'b' ? 'Black' : null;
    if (termination === 'checkmate' && winnerLabel) return `Checkmate — ${winnerLabel} wins (${result})`;
    if (termination === 'resignation' && winnerLabel) return `${winnerLabel} wins by resignation (${result})`;
    if (termination === 'timeout' && winnerLabel) return `${winnerLabel} wins on time (${result})`;
    if (termination === 'stalemate') return `Stalemate (${result})`;
    if (termination === 'agreement') return `Draw by agreement (${result})`;
    if (termination === 'insufficient_material') return `Draw — insufficient material (${result})`;
    if (termination === 'fifty_move') return `Draw — fifty-move rule (${result})`;
    if (termination === 'threefold') return `Draw — threefold repetition (${result})`;
    if (termination === 'variant') return `Variant end (${result})`;
    if (termination === 'aborted') return 'Game aborted';
    return `${result}`;
  }
}
