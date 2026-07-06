/**
 * Board UI wiring for the composition root.
 *
 * Assembles the interactive board (Increment 2) from the pure
 * `BoardInteraction` state machine, a `LegalMoveOracle`, the view-only optimistic
 * mover, and the DOM `BoardView`. This module composes the UI + presentation-core
 * only; it never imports the networking or API layers, preserving the separation
 * between UI and infrastructure. Behaviour is unchanged from Increment 2;
 * Increment 3C-2 will feed live positions in through here.
 */
import { BoardView } from '../ui/board-view.js';
import type { ResolvedMove } from '../ui/board-view.js';
import { BoardInteraction } from '../core/interaction.js';
import { NullMoveOracle } from '../ports/move-oracle.js';
import type { LegalMoveOracle } from '../ports/move-oracle.js';
import { applyMove } from '../core/mover.js';
import { STARTING_FEN } from '../core/position.js';

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
 */
export interface MountBoardOptions {
  /** Legal-move oracle; defaults to {@link NullMoveOracle}. */
  readonly oracle?: LegalMoveOracle;
}

/** Handle to the mounted board. */
export interface MountedBoard {
  readonly view: BoardView;
}

/**
 * Mount the interactive board into the DOM and return a handle to it.
 *
 * The `oracle` (if provided) supplies legal-move data from the authoritative
 * server snapshot via `GameSync` state; when omitted, a `NullMoveOracle` is
 * used and the board renders without legal-move highlights.
 */
export function mountBoard(
  elements: BoardElements,
  options?: MountBoardOptions,
): MountedBoard {
  const { boardEl, statusEl, flipEl } = elements;

  let fen = STARTING_FEN;
  const oracle = options?.oracle ?? new NullMoveOracle();
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  const setStatus = (msg: string): void => {
    if (statusEl) statusEl.textContent = msg;
  };

  const view = new BoardView(boardEl, {
    interaction,
    orientation: 'white',
    onResult: (r: ResolvedMove) => {
      if (r.kind === 'move') {
        // Optimistic view update; the server would confirm/correct this.
        fen = applyMove(fen, r.move);
        view.setPosition(fen);
        view.setLastMove(r.move.from, r.move.to);
        setStatus(
          `Played ${r.move.from}\u2013${r.move.to}${r.move.promotion ? `=${r.move.promotion.toUpperCase()}` : ''}.`,
        );
      } else {
        setStatus(`Premove set: ${r.premove.from}\u2013${r.premove.to}.`);
      }
    },
  });
  view.setPosition(fen);

  flipEl?.addEventListener('click', () => view.flip());

  return { view };
}
