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
import { StaticMoveOracle } from '../ports/move-oracle.js';
import { applyMove } from '../core/mover.js';
import { STARTING_FEN } from '../core/position.js';

/** DOM elements the board binds to. */
export interface BoardElements {
  readonly boardEl: HTMLElement;
  readonly statusEl?: HTMLElement | null;
  readonly flipEl?: HTMLElement | null;
}

/** Handle to the mounted board. */
export interface MountedBoard {
  readonly view: BoardView;
}

/**
 * Opening-move table used only so the offline scaffold is demonstrable before a
 * real (core/server-backed) oracle is wired. Unchanged from Increment 2.
 */
const OPENING_MOVES: Record<string, string[]> = {
  a2: ['a3', 'a4'], b2: ['b3', 'b4'], c2: ['c3', 'c4'], d2: ['d3', 'd4'],
  e2: ['e3', 'e4'], f2: ['f3', 'f4'], g2: ['g3', 'g4'], h2: ['h3', 'h4'],
  b1: ['a3', 'c3'], g1: ['f3', 'h3'],
};

/** Mount the interactive board into the DOM and return a handle to it. */
export function mountBoard(elements: BoardElements): MountedBoard {
  const { boardEl, statusEl, flipEl } = elements;

  let fen = STARTING_FEN;
  const oracle = new StaticMoveOracle({ [STARTING_FEN]: OPENING_MOVES });
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
