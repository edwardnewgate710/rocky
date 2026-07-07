/**
 * DOM entry for the composition root: build the application graph, mount the
 * interactive board, and return the wired handles. This is the only app-layer
 * module that reads the DOM; it is invoked from `main.ts`. Keeping it separate
 * from {@link createApp} lets the object graph be composed and tested with no
 * DOM present.
 *
 * Routing: the bootstrap reads the URL pathname via {@link parseRoute} and
 * mounts the appropriate view:
 * - `/` → lobby (seek list + create-seek form)
 * - `/game/{id}` → game view (board + clock + status)
 * - `/profile` or `/profile/{handle}` → profile view
 *
 * The theme toggle is always wired, regardless of route.
 */
import { createApp } from './composition.js';
import type { App, AppDependencies } from './composition.js';
import { resolveConfig } from './config.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';
import { GameController } from './game-controller.js';
import type { GameController as GameControllerType } from './game-controller.js';
import { LobbyController } from './lobby-controller.js';
import type { LobbyController as LobbyControllerType } from './lobby-controller.js';
import { ProfileController } from './profile-controller.js';
import type { ProfileController as ProfileControllerType } from './profile-controller.js';
import { ThemeToggle } from './theme-toggle.js';
import type { ThemeToggle as ThemeToggleType } from './theme-toggle.js';
import { parseRoute, navigate } from './router.js';
import type { SeekView } from '../api/models.js';

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped {
  readonly app: App;
  readonly board: MountedBoard | null;
  readonly controller: GameControllerType | null;
  readonly lobby: LobbyControllerType | null;
  readonly profile: ProfileControllerType | null;
  readonly theme: ThemeToggleType;
}

/**
 * Extract a game ID from a URL-like path. Only `/game/{id}` is accepted.
 * Returns `null` when no game ID is found.
 */
export function extractGameId(pathname: string): string | null {
  const route = parseRoute(pathname);
  return route.name === 'game' ? route.gameId : null;
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
  /** Override the access token (for authenticated join). */
  readonly token?: string;
}

/**
 * Render a seek list into a DOM element. Each seek is a row with variant,
 * speed, time control, and a cancel button (if owned).
 */
function renderSeeks(container: HTMLElement, seeks: readonly SeekView[]): void {
  container.innerHTML = '';
  for (const seek of seeks) {
    const row = document.createElement('div');
    row.className = 'seek-row';
    row.dataset.seekId = seek.id;

    const info = document.createElement('span');
    info.className = 'seek-info';
    const tc = `${Math.floor(seek.timeControl.initialMs / 60000)}+${Math.floor(seek.timeControl.incrementMs / 1000)}`;
    info.textContent = `${seek.variant} · ${seek.speed} · ${tc}${seek.rated ? ' · rated' : ''}`;
    row.appendChild(info);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'seek-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.dataset.seekId = seek.id;
    row.appendChild(cancelBtn);

    container.appendChild(row);
  }
}

/**
 * Compose the app and mount views against the given document. The route is
 * determined from the URL pathname (or `deps.gameId` override).
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

  // --- Theme toggle (always wired) ---
  const theme = new ThemeToggle({
    callbacks: {
      onTheme: (t) => {
        doc.documentElement.classList.toggle('dark', t === 'dark');
      },
    },
    ...(deps?.storage !== undefined ? { storage: deps.storage } : {}),
  });
  theme.emit();

  // --- Determine route ---
  const pathname = typeof location !== 'undefined' ? location.pathname : '/';
  const route = parseRoute(pathname);
  const gameId = deps?.gameId ?? (route.name === 'game' ? route.gameId : null);
  const token = deps?.token;

  // --- Game view ---
  const boardEl = doc.getElementById('board');
  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const clockEl = doc.getElementById('clock');
  const whiteClockEl = doc.getElementById('clock-white');
  const blackClockEl = doc.getElementById('clock-black');

  if (boardEl && gameId) {
    const gameSync = app.createGameSync({ gameId, ...(token !== undefined ? { token } : {}) });
    const oracle = app.createGameOracle(gameSync);

    let controller: GameController;

    const board = mountBoard(
      { boardEl, statusEl, flipEl },
      {
        oracle,
        onMove: (uci: string) => {
          controller.submitMove(uci);
        },
      },
    );

    controller = new GameController({
      gameSync,
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
        onColor: (color) => {
          if (color === 'b') board.setOrientation('black');
        },
      },
    });

    controller.start();
    gameSync.start();

    return { app, board, controller, lobby: null, profile: null, theme };
  }

  // --- Lobby view ---
  const lobbyEl = doc.getElementById('lobby');
  if (lobbyEl && route.name === 'lobby') {
    const seekListEl = doc.getElementById('seek-list');
    const createBtn = doc.getElementById('create-seek');
    const errorEl = doc.getElementById('lobby-error');

    const lobby = new LobbyController({
      client: app.api,
      callbacks: {
        onSeeks: (seeks) => {
          if (seekListEl) renderSeeks(seekListEl, seeks);
        },
        onCreatePending: (pending) => {
          if (createBtn) (createBtn as HTMLButtonElement).disabled = pending;
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    // Wire create-seek button.
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        void lobby.createSeek({
          variant: 'standard',
          timeControl: { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
          rated: false,
        });
      });
    }

    // Wire cancel buttons (event delegation on the seek list).
    if (seekListEl) {
      seekListEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('seek-cancel')) {
          const id = target.dataset.seekId;
          if (id) void lobby.cancelSeek(id);
        }
      });
    }

    lobby.start();

    return { app, board: null, controller: null, lobby, profile: null, theme };
  }

  // --- Profile view ---
  const profileEl = doc.getElementById('profile');
  if (profileEl && route.name === 'profile') {
    const handleEl = doc.getElementById('profile-handle');
    const ratingsEl = doc.getElementById('profile-ratings');
    const gamesEl = doc.getElementById('profile-games');
    const profileErrorEl = doc.getElementById('profile-error');

    const profile = new ProfileController({
      client: app.api,
      callbacks: {
        onProfile: (p) => {
          if (handleEl) handleEl.textContent = p.user.handle;
          if (ratingsEl) {
            ratingsEl.innerHTML = '';
            for (const r of p.ratings) {
              const row = document.createElement('div');
              row.className = 'rating-row';
              row.textContent = `${r.variant}: ${Math.round(r.rating)} (RD ${Math.round(r.rd)})`;
              ratingsEl.appendChild(row);
            }
          }
        },
        onGames: (games) => {
          if (gamesEl) {
            gamesEl.innerHTML = '';
            for (const g of games) {
              const row = document.createElement('div');
              row.className = 'game-row';
              row.textContent = `${g.variant} · ${g.speed} · ${g.result ?? 'ongoing'} · ${g.plyCount} ply`;
              gamesEl.appendChild(row);
            }
          }
        },
        onError: (msg) => {
          if (profileErrorEl) profileErrorEl.textContent = msg;
        },
      },
    });

    const handle = route.name === 'profile' ? route.handle : null;
    if (handle) {
      void profile.load(handle);
    } else {
      void profile.loadSelf();
    }

    return { app, board: null, controller: null, lobby: null, profile, theme };
  }

  // --- Standalone board (no game ID, no lobby, no profile) ---
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return { app, board, controller: null, lobby: null, profile: null, theme };
}
