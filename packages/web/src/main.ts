/**
 * App entry (Increment 3C).
 *
 * Mounts the {@link App} composition root which wires the REST client,
 * WebSocket client, GameSync, and CoreMoveOracle into the game view.
 * The server remains authoritative; the client sends intents and reconciles
 * from authoritative snapshots/broadcasts.
 *
 * Framework-independent: the DOM is only touched here and in board-view.ts.
 */
import { App } from './app.js';

function mount(): void {
  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const flipEl = document.getElementById('flip');
  if (!boardEl) return;

  new App({
    boardEl,
    statusEl,
    flipEl,
  });
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
