/**
 * App entry. Mounts the board, wires a minimal game view, and registers the
 * service worker for PWA/offline shell. Backend wiring (REST + realtime WS) is
 * introduced in the next increment behind a typed client seam.
 */
import { BoardView, type MoveIntent } from './ui/board-view.js';
import { STARTING_FEN } from './core/position.js';

function mount(): void {
  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  if (!boardEl) return;

  const board = new BoardView(boardEl, {
    orientation: 'white',
    onMoveIntent: (intent: MoveIntent) => {
      if (statusEl) statusEl.textContent = `Move intent: ${intent.from}\u2013${intent.to}`;
    },
  });
  board.setFen(STARTING_FEN);

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
