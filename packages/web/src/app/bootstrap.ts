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
import { CreateGamePanel } from './create-game-panel.js';
import { ProfileController } from './profile-controller.js';
import type { ProfileController as ProfileControllerType } from './profile-controller.js';
import { ThemeToggle } from './theme-toggle.js';
import type { ThemeToggle as ThemeToggleType } from './theme-toggle.js';
import { AuthController } from './auth-controller.js';
import type { AuthController as AuthControllerType } from './auth-controller.js';
import { parseRoute } from './router.js';
import type { SeekView } from '../api/models.js';

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped {
  readonly app: App;
  readonly board: MountedBoard | null;
  readonly controller: GameControllerType | null;
  readonly lobby: LobbyControllerType | null;
  readonly profile: ProfileControllerType | null;
  readonly auth: AuthControllerType;
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

/** Options for {@link renderEmpty}. */
interface EmptyStateOptions {
  /** Optional decorative glyph (a chess piece symbol); hidden from a11y. */
  readonly mark?: string;
  readonly title: string;
  readonly body: string;
  /** Optional call-to-action rendered as a SPA nav link. */
  readonly cta?: { readonly label: string; readonly href: string; readonly route: string };
  /** Lighter, left-aligned variant for small sub-sections (no panel). */
  readonly inline?: boolean;
}

/**
 * Render a first-run / no-data empty state into a container, replacing its
 * contents. Empty states name the next action rather than leaving blank space.
 */
function renderEmpty(container: HTMLElement, opts: EmptyStateOptions): void {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = opts.inline ? 'empty empty-inline' : 'empty';

  if (opts.mark && !opts.inline) {
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = opts.mark;
    wrap.appendChild(mark);
  }

  const title = document.createElement('p');
  title.className = 'empty-title';
  title.textContent = opts.title;
  wrap.appendChild(title);

  const body = document.createElement('p');
  body.className = 'empty-body';
  body.textContent = opts.body;
  wrap.appendChild(body);

  if (opts.cta) {
    const link = document.createElement('a');
    link.className = 'empty-cta';
    link.href = opts.cta.href;
    link.dataset.route = opts.cta.route;
    link.textContent = opts.cta.label;
    wrap.appendChild(link);
  }

  container.appendChild(wrap);
}

/**
 * Render a seek list into a DOM element. Each seek is a row with variant,
 * speed, time control, and a cancel button (if owned). An empty list renders
 * a first-run empty state pointing at the Create-seek action.
 */
function renderSeeks(container: HTMLElement, seeks: readonly SeekView[]): void {
  container.innerHTML = '';
  if (seeks.length === 0) {
    renderEmpty(container, {
      mark: '♟',
      title: 'No open seeks right now',
      body: 'Create a game above — the first player to accept joins you.',
    });
    return;
  }
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
    ...(deps?.storage !== undefined ? { storage: deps.storage } : typeof localStorage !== 'undefined' ? { storage: localStorage } : {}),
  });
  theme.emit();

  // --- Auth controller (always wired) ---
  const authErrorEl = doc.getElementById('auth-error');
  const authFormEl = doc.getElementById('auth-form');
  const authHandleEl = doc.getElementById('auth-handle') as HTMLInputElement | null;
  const authPasswordEl = doc.getElementById('auth-password') as HTMLInputElement | null;
  const authSubmitEl = doc.getElementById('auth-submit');
  const authRegisterEl = doc.getElementById('auth-register');
  const authLogoutEl = doc.getElementById('auth-logout');
  const authStatusEl = doc.getElementById('auth-status');

  const auth = new AuthController({
    client: app.api,
    callbacks: {
      onSessionChange: (session) => {
        if (authStatusEl) {
          authStatusEl.textContent = session ? `Signed in as ${session.handle}` : 'Not signed in';
        }
        // Show/hide auth form vs logout button.
        if (authFormEl) authFormEl.hidden = session !== null;
        if (authLogoutEl) authLogoutEl.hidden = session === null;
        // Update create-seek button state (M2 gating).
        const createBtn = doc.getElementById('create-seek');
        if (createBtn instanceof HTMLButtonElement) {
          createBtn.disabled = session === null;
          createBtn.title = session === null ? 'Sign in to create a seek' : '';
        }
      },
      onPending: (pending) => {
        if (authSubmitEl instanceof HTMLButtonElement) {
          authSubmitEl.disabled = pending;
        }
        if (authRegisterEl instanceof HTMLButtonElement) {
          authRegisterEl.disabled = pending;
        }
      },
      onError: (msg) => {
        if (authErrorEl) authErrorEl.textContent = msg;
      },
    },
    ...(deps?.storage !== undefined ? { storage: deps.storage } : typeof localStorage !== 'undefined' ? { storage: localStorage } : {}),
  });

  // Wire auth form submit (sign in).
  if (authSubmitEl instanceof HTMLButtonElement) {
    authSubmitEl.addEventListener('click', () => {
      const handle = authHandleEl?.value ?? '';
      const password = authPasswordEl?.value ?? '';
      if (handle && password) {
        void auth.login(handle, password);
      }
    });
  }

  // Wire register button (create a new account). Both buttons are
  // type="button" (they share one form with two submit actions), so native
  // `required` validation never fires on click — trigger it explicitly.
  if (authRegisterEl instanceof HTMLButtonElement) {
    authRegisterEl.addEventListener('click', () => {
      if (authFormEl instanceof HTMLFormElement && !authFormEl.reportValidity()) {
        return;
      }
      const handle = authHandleEl?.value ?? '';
      const password = authPasswordEl?.value ?? '';
      if (handle && password) {
        void auth.register(handle, password);
      }
    });
  }

  // Wire logout button.
  if (authLogoutEl instanceof HTMLButtonElement) {
    authLogoutEl.addEventListener('click', () => {
      void auth.logout();
    });
  }

  // Restore any persisted session. Kept as a promise so the authenticated game
  // socket below can wait for the access token, which M12 inc 2 obtains
  // asynchronously via the httpOnly refresh cookie rather than from storage.
  const restorePromise = auth.restore();

  // --- Determine route ---
  const pathname = typeof location !== 'undefined' ? location.pathname : '/';
  const route = parseRoute(pathname);
  const gameId = deps?.gameId ?? (route.name === 'game' ? route.gameId : null);
  const token = deps?.token ?? app.api.session.current?.tokens.accessToken;

  // --- Toggle top-level section visibility for the active route ---
  // index.html ships lobby/profile hidden; the game <main> is always present.
  // Show exactly the section that matches the current route.
  const mainEl = doc.getElementById('game-main');
  const lobbySectionEl = doc.getElementById('lobby');
  const profileSectionEl = doc.getElementById('profile');
  const showGame = route.name === 'game';
  const showLobby = route.name === 'lobby';
  const showProfile = route.name === 'profile';
  if (mainEl) mainEl.hidden = !showGame;
  if (lobbySectionEl) lobbySectionEl.hidden = !showLobby;
  if (profileSectionEl) profileSectionEl.hidden = !showProfile;

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
            clockEl.textContent = `${formatClock(whiteMs)} – ${formatClock(blackMs)}`;
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
    if (token !== undefined) {
      gameSync.start();
    } else {
      // M12 inc 2: the access token arrives asynchronously via the httpOnly
      // refresh cookie (restore → refresh). Open the authenticated socket once
      // it resolves; fall back to a spectator connection if restore fails.
      void restorePromise
        .then(() => {
          const t = app.api.session.current?.tokens.accessToken;
          if (t !== undefined) gameSync.setToken(t);
        })
        .catch(() => undefined)
        .finally(() => gameSync.start());
    }

    return { app, board, controller, lobby: null, profile: null, auth, theme };
  }

  // --- Lobby view ---
  const lobbyEl = doc.getElementById('lobby');
  if (lobbyEl && route.name === 'lobby') {
    const seekListEl = doc.getElementById('seek-list');
    const createGameEl = doc.getElementById('create-game');
    const errorEl = doc.getElementById('lobby-error');

    let panel: CreateGamePanel | null = null;

    const lobby = new LobbyController({
      client: app.api,
      callbacks: {
        onSeeks: (seeks) => {
          if (seekListEl) renderSeeks(seekListEl, seeks);
        },
        onCreatePending: (pending) => {
          panel?.setPending(pending);
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
      isAuthenticated: () => auth.isAuthenticated(),
    });

    // Mount the create-a-game panel; it hands validated params to the lobby.
    if (createGameEl) {
      panel = new CreateGamePanel({
        doc,
        mount: createGameEl,
        initialAuthenticated: auth.isAuthenticated(),
        callbacks: {
          onSubmit: async (params) => {
            const seek = await lobby.createSeek(params);
            return seek !== null;
          },
          onError: (msg) => {
            if (errorEl) errorEl.textContent = msg ?? '';
          },
        },
      });
    }

    // Wire cancel buttons (event delegation on the seek list).
    if (seekListEl) {
      seekListEl.addEventListener('click', (e) => {
        const target = e.target;
        if (target instanceof HTMLElement && target.classList.contains('seek-cancel')) {
          const id = target.dataset.seekId;
          if (id) void lobby.cancelSeek(id);
        }
      });
    }

    lobby.start();

    return { app, board: null, controller: null, lobby, profile: null, auth, theme };
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
            if (p.ratings.length === 0) {
              renderEmpty(ratingsEl, {
                title: 'No ratings yet',
                body: 'Play a rated game to establish a rating.',
                inline: true,
              });
            } else {
              ratingsEl.innerHTML = '';
              for (const r of p.ratings) {
                const row = document.createElement('div');
                row.className = 'rating-row';
                row.textContent = `${r.variant}: ${Math.round(r.rating)} (RD ${Math.round(r.rd)})`;
                ratingsEl.appendChild(row);
              }
            }
          }
        },
        onGames: (games) => {
          if (gamesEl) {
            if (games.length === 0) {
              renderEmpty(gamesEl, {
                mark: '♞',
                title: 'No games yet',
                body: 'Your finished games will show up here.',
                cta: { label: 'Find a game', href: '/', route: 'lobby' },
              });
            } else {
              gamesEl.innerHTML = '';
              for (const g of games) {
                const row = document.createElement('div');
                row.className = 'game-row';
                row.textContent = `${g.variant} · ${g.speed} · ${g.result ?? 'ongoing'} · ${g.plyCount} ply`;
                gamesEl.appendChild(row);
              }
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

    return { app, board: null, controller: null, lobby: null, profile, auth, theme };
  }

  // --- Standalone board (no game ID, no lobby, no profile) ---
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return { app, board, controller: null, lobby: null, profile: null, auth, theme };
}
