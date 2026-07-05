/**
 * App entry. Wires the interactive board (Increment 2): drag/click movement,
 * highlights, promotion and premoves, driven by the pure BoardInteraction.
 *
 * Legality here is served by a StaticMoveOracle seeded with the opening
 * position purely so the scaffold is demonstrable offline. The real oracle —
 * `@chess-platform/core` for instant local feedback, reconciled with the
 * authoritative server over the M3 realtime WS — is wired in the next increment
 * (client seam). Moves are applied optimistically via the view-only mover; the
 * server remains authoritative.
 */
import { BoardView, type ResolvedMove } from './ui/board-view.js';
import { BoardInteraction } from './core/interaction.js';
import { StaticMoveOracle } from './ports/move-oracle.js';
import { applyMove } from './core/mover.js';
import { STARTING_FEN } from './core/position.js';

const OPENING_MOVES: Record<string, string[]> = {
  a2: ['a3', 'a4'], b2: ['b3', 'b4'], c2: ['c3', 'c4'], d2: ['d3', 'd4'],
  e2: ['e3', 'e4'], f2: ['f3', 'f4'], g2: ['g3', 'g4'], h2: ['h3', 'h4'],
  b1: ['a3', 'c3'], g1: ['f3', 'h3'],
};

function mount(): void {
  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  if (!boardEl) return;

  let fen = STARTING_FEN;
  const oracle = new StaticMoveOracle({ [STARTING_FEN]: OPENING_MOVES });
  const interaction = new BoardInteraction({ oracle, myTurn: true });

  const setStatus = (msg: string): void => {
    if (statusEl) statusEl.textContent = msg;
  };

  const board = new BoardView(boardEl, {
    interaction,
    orientation: 'white',
    onResult: (r: ResolvedMove) => {
      if (r.kind === 'move') {
        // Optimistic view update; the server would confirm/correct this.
        fen = applyMove(fen, r.move);
        board.setPosition(fen);
        board.setLastMove(r.move.from, r.move.to);
        setStatus(`Played ${r.move.from}\u2013${r.move.to}${r.move.promotion ? `=${r.move.promotion.toUpperCase()}` : ''}.`);
      } else {
        setStatus(`Premove set: ${r.premove.from}\u2013${r.premove.to}.`);
      }
    },
  });
  board.setPosition(fen);

  document.getElementById('flip')?.addEventListener('click', () => board.flip());
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
}
