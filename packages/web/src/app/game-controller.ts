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
}

/**
 * Options for constructing a {@link GameController}.
 */
export interface GameControllerOptions {
  readonly gameSync: GameSync;
  /** Our wire color (`'w'` or `'b'`), or `null` for a spectator. */
  readonly myColor: WsColor | null;
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
  private readonly myColor: WsColor | null;
  private readonly callbacks: GameControllerCallbacks;
  private unsubscribe: (() => void) | null = null;
  private currentFen = '';
  private currentTurn: WsColor | null = null;

  constructor(options: GameControllerOptions) {
    this.gameSync = options.gameSync;
    this.myColor = options.myColor;
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
      // Replay live moves on top of the snapshot FEN.
      for (const move of state.moves) {
        fen = applyMove(fen, { from: move.uci.slice(0, 2), to: move.uci.slice(2, 4) });
      }
      if (fen !== this.currentFen) {
        this.currentFen = fen;
        this.callbacks.onPosition(fen);
      }
    }

    // --- Turn ---
    if (state.turn !== this.currentTurn) {
      this.currentTurn = state.turn;
      const myTurn = state.turn !== null && state.turn === this.myColor;
      this.callbacks.onTurn(myTurn);
    }

    // --- Clock ---
    if (state.clock !== null) {
      this.callbacks.onClock(state.clock.w, state.clock.b);
    }

    // --- Status ---
    const statusText = this.statusText(state);
    this.callbacks.onStatus(statusText);
  }

  private statusText(state: GameSyncState): string {
    if (state.status === null) return 'Waiting…';
    if (!state.status.over) {
      if (state.turn === null) return 'Waiting…';
      const turnLabel = state.turn === 'w' ? 'White' : 'Black';
      if (this.myColor === null) return `${turnLabel} to move`;
      const myTurn = state.turn === this.myColor;
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
    if (termination === 'aborted') return 'Game aborted';
    return `${result}`;
  }
}
