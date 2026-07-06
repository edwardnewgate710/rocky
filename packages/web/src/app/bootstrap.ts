/**
 * DOM entry for the composition root: build the application graph, mount the
 * interactive board, and return the wired handles. This is the only app-layer
 * module that reads the DOM; it is invoked from `main.ts`. Keeping it separate
 * from {@link createApp} lets the object graph be composed and tested with no
 * DOM present.
 *
 * When a game ID is present (extracted from the URL path or passed explicitly),
 * the bootstrap assembles the full game view: `GameSync` + `GameController` +
 * `AuthoritativeMoveOracle` + `mountBoard`, with callbacks wired so the board
 * displays live server positions, clock, status, and forwards user moves
 * through the controller to the server.
 */
import { createApp } from './composition.js';
import type { App, AppDependencies } from './composition.js';
import { resolveConfig } from './config.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import { GameController } from './game-controller.js';
import type { GameController as GameControllerType } from './game-controller.js';
import type { WsColor } from '../net/ws-protocol.js';

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped {
  readonly app: App;
  /** The mounted board, or `null` when the board element is absent. */
  readonly board: MountedBoard | null;
  /** The game controller, or `null` when no game ID is present. */
  readonly controller: GameControllerType | null;
}

/**
 * Extract a game ID from a URL-like path. The path is expected to be
 * `/game/{id}` or `/{id}`. Returns `null` when no game ID is found.
 */
export function extractGameId(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  // /game/{id}
  if (segments[0] === 'game' && segments.length >= 2) return segments[1]!;
  // /{id} — single-segment path, treat as game ID
  if (segments.length === 1) return segments[0]!;
  return null;
}

/**
 * Format clock milliseconds as `M:SS`.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Injectable seams for the bootstrap. Omit any to use browser defaults. */
export interface BootstrapDependencies extends Partial<AppDependencies> {
  /** Override the game ID (takes precedence over URL extraction). */
  readonly gameId?: string;
  /** Override the user ID. */
  readonly userId?: string;
}

/**
 * Compose the app and mount the board against the given document. When a game
 * ID is available (from `deps.gameId` or the URL path), the full game view is
 * assembled: GameSync + GameController + oracle + board, with callbacks wired.
 */
export function bootstrap(
  doc: Document,
  deps?: BootstrapDependencies,
): Bootstrapped {
  const config = deps?.config ?? resolveConfig();
  const appDeps: AppDependencies = {
    config,
    ...(deps?.httpTransport !== undefined ? { httpTransport: deps.httpTransport } : {}),
    ...(deps?.wsFactory !== undefined ? { wsFactory: deps.wsFactory } : {}),
    ...(deps?.tokenStore !== undefined ? { tokenStore: deps.tokenStore } : {}),
    ...(deps?.storage !== undefined ? { storage: deps.storage } : {}),
  };
  const app = createApp(appDeps);

  const boardEl = doc.getElementById('board');
  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const clockEl = doc.getElementById('clock');
  const whiteClockEl = doc.getElementById('clock-white');
  const blackClockEl = doc.getElementById('clock-black');

  // Determine game ID: explicit override > URL path > none.
  const gameId = deps?.gameId ?? extractGameId(
    typeof location !== 'undefined' ? location.pathname : '/',
  );
  const userId = deps?.userId ?? 'anon';

  if (boardEl && gameId) {
    // --- Full game view wiring ---
    const gameSync = app.createGameSync({ gameId, userId });
    const oracle = app.createGameOracle(gameSync);

    // Determine our color from the DOM (data-color attribute) or default to white.
    const colorAttr = boardEl.getAttribute('data-color');
    const myColor: WsColor | null =
      colorAttr === 'b' ? 'b' : colorAttr === 'spectator' ? null : 'w';

    const board = mountBoard(
      { boardEl, statusEl, flipEl },
      {
        oracle,
        onMove: (uci: string) => {
          controller.submitMove(uci);
        },
      },
    );

    const controller = new GameController({
      gameSync,
      myColor,
      callbacks: {
        onPosition: (fen: string) => board.setPosition(fen),
        onTurn: (myTurn: boolean) => board.setTurn(myTurn),
        onClock: (whiteMs: number, blackMs: number) => {
          if (whiteClockEl) whiteClockEl.textContent = formatClock(whiteMs);
          if (blackClockEl) blackClockEl.textContent = formatClock(blackMs);
          if (clockEl) {
            clockEl.textContent = `${formatClock(whiteMs)} \u2013 ${formatClock(blackMs)}`;
          }
        },
        onStatus: (text: string) => {
          if (statusEl) statusEl.textContent = text;
        },
        onLastMove: (from: string | null, to: string | null) => {
          if (from && to) board.setLastMove(from, to);
        },
      },
    });

    // Start the controller (subscribes to GameSync state).
    // GameSync.start() is NOT called here — the caller (or a game lobby)
    // decides when to open the connection. The controller will emit state
    // as soon as GameSync receives snapshots.
    controller.start();

    return { app, board, controller };
  }

  // --- Standalone board (no game ID) ---
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return { app, board, controller: null };
}
