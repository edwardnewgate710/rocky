/**
 * Board UI wiring for the composition root.
 *
 * Assembles the interactive board (Increment 2) from the pure
 * `BoardInteraction` state machine, a `LegalMoveOracle`, the view-only optimistic
 * mover, and the DOM `BoardView`. This module composes the UI + presentation-core
 * only; it never imports the networking or API layers, preserving the separation
 * between UI and infrastructure.
 *
 * When an `onMove` callback is provided (increment 3E), resolved moves are
 * forwarded to the caller (typically a `GameController`) for server submission
 * instead of being applied optimistically here. The caller then drives position
 * updates back through `setPosition` via the controller's callbacks.
 */
import { BoardView } from '../ui/board-view.js';
import type { ResolvedMove } from '../ui/board-view.js';
import { BoardInteraction } from '../core/interaction.js';
import { NullMoveOracle } from '../ports/move-oracle.js';
import type { LegalMoveOracle } from '../ports/move-oracle.js';
import { applyMove } from '../core/mover.js';
import { STARTING_FEN } from '../core/position.js';
import type { Premove } from '../core/premove.js';

/**
 * DOM elements the board binds to.
 */
export interface BoardElements {
  readonly boardEl: HTMLElement;
  readonly statusEl?: HTMLElement | null;
  readonly flipEl?: HTMLElement | null;
}

/**
 * Optional configuration for {@link mountBoard}. The `oracle` is injected here
 * so the board module never imports the networking layer; the composition root
 * (or a game controller) creates an `AuthoritativeMoveOracle` from a `GameSync`
 * and passes it in. When omitted, a {@link NullMoveOracle} is used — the board
 * renders but offers no legal-move highlights.
 *
 * When `onMove` is provided, resolved user moves are forwarded to the caller
 * for server submission (the caller drives position updates back via
 * `setPosition`). When omitted, the board applies moves optimistically (the
 * standalone/offline mode from Increment 2).
 */
export interface MountBoardOptions {
  /** Legal-move oracle; defaults to {@link NullMoveOracle}. */
  readonly oracle?: LegalMoveOracle;
  /**
   * Callback invoked when the user resolves a move (drag/click/promotion).
   * The caller (e.g. `GameController`) submits it to the server and drives
   * position updates back via `setPosition`. When omitted, the board applies
   * moves optimistically itself.
   */
  readonly onMove?: (uci: string) => void;
}

/** Handle to the mounted board. */
export interface MountedBoard {
  readonly view: BoardView;
  /** Update the displayed position (FEN). Delegates to `BoardView.setPosition`. */
  setPosition: (fen: string) => void;
  /** Highlight the last move. Delegates to `BoardView.setLastMove`. */
  setLastMove: (from: string, to: string) => void;
  /** Update whose turn it is (affects legal highlights + premoves). */
  setTurn: (myTurn: boolean) => void;
  /** Set the board orientation ('white' or 'black' perspective). */
  setOrientation: (orientation: 'white' | 'black') => void;
}

/** Convert a {@link Premove} to UCI notation. */
function premoveToUci(m: Premove): string {
  return m.promotion ? `${m.from}${m.to}${m.promotion}` : `${m.from}${m.to}`;
}

/**
 * Mount the interactive board into the DOM and return a handle to it.
 *
 * The `oracle` (if provided) supplies legal-move data from the authoritative
 * server snapshot via `GameSync` state; when omitted, a `NullMoveOracle` is
 * used and the board renders without legal-move highlights.
 *
 * When `onMove` is provided, user-resolved moves are forwarded to the caller
 * for server submission. The caller is responsible for driving position
 * updates back via `setPosition` (typically through a `GameController`'s
 * `onPosition` callback). When `onMove` is omitted, the board applies moves
 * optimistically itself (standalone/offline mode).
 */
export function mountBoard(
  elements: BoardElements,
  options?: MountBoardOptions,
): MountedBoard {
  const { boardEl, statusEl, flipEl } = elements;

  let fen = STARTING_FEN;
  const oracle = options?.oracle ?? new NullMoveOracle();
  const onMove = options?.onMove;
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  const setStatus = (msg: string): void => {
    if (statusEl) statusEl.textContent = msg;
  };

  const view = new BoardView(boardEl, {
    interaction,
    orientation: 'white',
    onResult: (r: ResolvedMove) => {
      if (r.kind === 'move') {
        if (onMove) {
          // Server-authoritative mode: forward to the caller.
          onMove(premoveToUci(r.move));
        } else {
          // Standalone/offline mode: apply optimistically.
          fen = applyMove(fen, r.move);
          view.setPosition(fen);
          view.setLastMove(r.move.from, r.move.to);
          setStatus(
            `Played ${r.move.from}\u2013${r.move.to}${r.move.promotion ? `=${r.move.promotion.toUpperCase()}` : ''}.`,
          );
        }
      } else {
        setStatus(`Premove set: ${r.premove.from}\u2013${r.premove.to}.`);
      }
    },
  });
  view.setPosition(fen);

  flipEl?.addEventListener('click', () => view.flip());

  return {
    view,
    setPosition: (f: string) => view.setPosition(f),
    setLastMove: (from: string, to: string) => view.setLastMove(from, to),
    setTurn: (myTurn: boolean) => view.setTurn(myTurn),
    setOrientation: (orientation: 'white' | 'black') => {
      if (view.orientationColor !== orientation) view.flip();
    },
  };
}
