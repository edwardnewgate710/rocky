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
import { PlayBotDialog } from './play-bot-dialog.js';
import { ProfileController } from './profile-controller.js';
import type { ProfileController as ProfileControllerType } from './profile-controller.js';
import { TournamentController } from './tournament-controller.js';
import type { TournamentController as TournamentControllerType } from './tournament-controller.js';
import {
  renderTournamentList,
  renderTournamentDetail,
  renderStandings,
  renderLiveBoards,
} from './tournament-view.js';
import {
  renderEmpty,
  formatClock,
  formatTimeControl,
} from './render-helpers.js';
import type { EmptyStateOptions } from './render-helpers.js';
import { SocialController } from './social-controller.js';
import type { Relationship, SelfSocial } from './social-controller.js';
import type { SocialPlayer, TournamentDetail } from '../api/models.js';
import { ThemeToggle } from './theme-toggle.js';
import type { ThemeToggle as ThemeToggleType } from './theme-toggle.js';
import { AuthController } from './auth-controller.js';
import type { AuthController as AuthControllerType } from './auth-controller.js';
import type { AuthSession } from './auth-controller.js';
import { parseRoute } from './router.js';
import type { SeekView } from '../api/models.js';
import type { TimeControl } from '../net/ws-protocol.js';

export { renderEmpty, formatClock, formatTimeControl };
export type { EmptyStateOptions };

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped {
  readonly app: App;
  readonly board: MountedBoard | null;
  readonly controller: GameControllerType | null;
  readonly lobby: LobbyControllerType | null;
  readonly profile: ProfileControllerType | null;
  readonly tournament: TournamentControllerType | null;
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

/** Injectable seams for the bootstrap. Omit any to use browser defaults. */
export interface BootstrapDependencies extends Partial<AppDependencies> {
  /** Override the game ID (takes precedence over URL extraction). */
  readonly gameId?: string;
  /** Override the access token (for authenticated join). */
  readonly token?: string;
}

/** A row action: a label plus what it does. */
interface RowAction {
  readonly label: string;
  readonly run: () => void;
  /** Severs a relationship; separated from the connective actions by position. */
  readonly destructive?: boolean;
}

/**
 * Render one `panel-row` — the single row treatment every list in the app
 * shares. Actions are optional; a row without them is a plain label.
 */
function appendPanelRow(
  container: HTMLElement,
  label: string,
  actions: readonly RowAction[],
  busy: boolean,
): void {
  const row = document.createElement('div');
  row.className = 'panel-row';

  const name = document.createElement('span');
  name.textContent = label;
  row.appendChild(name);

  if (actions.length > 0) {
    const group = document.createElement('div');
    group.className = 'panel-row-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.disabled = busy;
      // The accessible name has to say who the action applies to: a column of
      // buttons all reading "Accept" is unusable without the surrounding row.
      button.setAttribute('aria-label', `${action.label} ${label}`);
      button.addEventListener('click', action.run);
      group.appendChild(button);
    }
    row.appendChild(group);
  }

  container.appendChild(row);
}

/**
 * Render the action bar shown on another player's profile.
 *
 * A relationship of `null` means there is nothing to offer — the viewer is
 * signed out, or looking at their own profile — so the bar is emptied rather
 * than filled with disabled controls that suggest a signed-in affordance.
 *
 * Follow state is carried by the verb ("Follow" vs "Unfollow"), never by colour
 * alone: this system has exactly one accent and it means "active", so a colour
 * difference here would be both off-system and invisible to a colourblind user.
 */
function renderSocialActions(
  container: HTMLElement,
  relationship: Relationship | null,
  social: SocialController,
  busy: boolean,
): void {
  container.innerHTML = '';
  if (relationship === null) return;

  const actions: RowAction[] = [];

  if (relationship.blocked) {
    // A block supersedes everything else, so offering follow or friend controls
    // beside it would advertise actions the server will refuse.
    actions.push({ label: 'Unblock', run: () => void social.unblockSubject() });
  } else {
    actions.push(
      relationship.following
        ? { label: 'Unfollow', run: () => void social.unfollow() }
        : { label: 'Follow', run: () => void social.follow() },
    );

    if (relationship.incomingRequestId !== null) {
      const id = relationship.incomingRequestId;
      actions.push(
        { label: 'Accept friend request', run: () => void social.respond(id, 'accept') },
        { label: 'Decline friend request', run: () => void social.respond(id, 'decline') },
      );
    } else if (relationship.outgoingRequestId !== null) {
      const id = relationship.outgoingRequestId;
      actions.push({ label: 'Cancel friend request', run: () => void social.respond(id, 'cancel') });
    } else {
      actions.push({ label: 'Add friend', run: () => void social.sendFriendRequest() });
    }

    actions.push({ label: 'Block', run: () => void social.block(), destructive: true });
  }

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.disabled = busy;
    // Block is destructive and must not sit flush against the connective
    // actions, where a mis-aimed click is one pixel away from severing a
    // relationship. DESIGN.md is explicit that hierarchy here comes from
    // placement and copy rather than a second button treatment, so it is
    // separated by position — not by colour or weight.
    if (action.destructive) button.classList.add('social-action-destructive');
    button.addEventListener('click', action.run);
    container.appendChild(button);
  }
}

/** Render a list of players, each with the actions that apply to them. */
function renderPlayerList(
  container: HTMLElement,
  players: readonly SocialPlayer[],
  empty: { readonly title: string; readonly body: string },
  busy: boolean,
  actionsFor: (player: SocialPlayer) => readonly RowAction[] = () => [],
): void {
  container.innerHTML = '';
  if (players.length === 0) {
    renderEmpty(container, { ...empty, inline: true });
    return;
  }
  for (const player of players) {
    appendPanelRow(container, player.handle, actionsFor(player), busy);
  }
}

/**
 * Render a seek list into a DOM element. Each seek is a row with variant,
 * speed, time control, and — only on the viewer's own seeks — a cancel button
 * (`currentUserId`). Cancelling someone else's seek is a 403, so the affordance
 * is owner-only. An empty list renders a first-run empty state.
 */
function renderSeeks(
  container: HTMLElement,
  seeks: readonly SeekView[],
  currentUserId: string | null,
): void {
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
    const owned = currentUserId !== null && seek.creatorId === currentUserId;
    const row = document.createElement('div');
    row.className = owned ? 'seek-row seek-row-own' : 'seek-row';
    row.dataset.seekId = seek.id;

    const info = document.createElement('span');
    info.className = 'seek-info';
    const tc = formatTimeControl(seek.timeControl);
    info.textContent = `${seek.variant} · ${seek.speed} · ${tc}${seek.rated ? ' · rated' : ''}`;

    if (owned) {
      // Your own open seek is live and waiting to be accepted — say so, and
      // give it the cancel affordance (only the creator can cancel; others 403).
      const main = document.createElement('div');
      main.className = 'seek-main';
      main.appendChild(info);

      const waiting = document.createElement('span');
      waiting.className = 'seek-waiting';
      const dot = document.createElement('span');
      dot.className = 'seek-dot';
      dot.setAttribute('aria-hidden', 'true');
      waiting.append(dot, 'Waiting for an opponent…');
      main.appendChild(waiting);
      row.appendChild(main);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'seek-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.dataset.seekId = seek.id;
      cancelBtn.setAttribute('aria-label', 'Cancel your seek');
      row.appendChild(cancelBtn);
    } else {
      const main = document.createElement('div');
      main.className = 'seek-main';
      main.appendChild(info);
      row.appendChild(main);

      const acceptBtn = document.createElement('button');
      acceptBtn.type = 'button';
      acceptBtn.className = 'seek-accept button primary';
      acceptBtn.textContent = 'Play';
      acceptBtn.dataset.seekId = seek.id;
      acceptBtn.setAttribute('aria-label', 'Accept seek');
      row.appendChild(acceptBtn);
    }

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
  const themeButtonEl = doc.getElementById('theme-toggle');
  const theme = new ThemeToggle({
    callbacks: {
      onTheme: (t) => {
        doc.documentElement.classList.toggle('dark', t === 'dark');
        doc.documentElement.classList.toggle('light', t === 'light');
        if (themeButtonEl) {
          const next = t === 'dark' ? 'light' : 'dark';
          themeButtonEl.textContent = t === 'dark' ? '☀️' : '🌙';
          themeButtonEl.setAttribute('aria-label', `Switch to ${next} theme`);
          themeButtonEl.setAttribute('title', `Switch to ${next} theme`);
        }
        if ('querySelector' in doc && typeof doc.querySelector === 'function') {
          const themeColor = doc.querySelector('meta[name="theme-color"]');
          themeColor?.setAttribute('content', t === 'dark' ? '#161512' : '#f7f6f5');
        }
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

  let selfProfileSessionHandler: ((session: AuthSession | null) => void) | null = null;
  let playBotDialog: PlayBotDialog | null = null;
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
        const playBotBtn = doc.getElementById('play-bot');
        if (playBotBtn instanceof HTMLButtonElement) {
          playBotBtn.disabled = session === null;
          playBotBtn.title = session === null ? 'Sign in to play the computer' : '';
        }
        playBotDialog?.setAuthenticated(session !== null);
        selfProfileSessionHandler?.(session);
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
  const tournamentsSectionEl = doc.getElementById('tournaments');
  const tournamentSectionEl = doc.getElementById('tournament');
  const showGame = route.name === 'game';
  const showLobby = route.name === 'lobby';
  const showProfile = route.name === 'profile';
  const showTournaments = route.name === 'tournaments';
  const showTournament = route.name === 'tournament';
  if (mainEl) mainEl.hidden = !showGame;
  if (lobbySectionEl) lobbySectionEl.hidden = !showLobby;
  if (profileSectionEl) profileSectionEl.hidden = !showProfile;
  if (tournamentsSectionEl) tournamentsSectionEl.hidden = !showTournaments;
  if (tournamentSectionEl) tournamentSectionEl.hidden = !showTournament;

  // Board-only controls should not suggest functionality on lobby/profile
  // routes. They were previously visible everywhere despite doing nothing.
  const routeFlipEl = doc.getElementById('flip');
  const skipBoardEl = doc.getElementById('skip-board');
  if (routeFlipEl) routeFlipEl.hidden = !showGame;
  if (skipBoardEl) skipBoardEl.hidden = !showGame;

  // --- Game view ---
  const boardEl = doc.getElementById('board');
  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const clockEl = doc.getElementById('clock');
  const whiteClockEl = doc.getElementById('clock-white');
  const blackClockEl = doc.getElementById('clock-black');

  // Game metadata
  const metaConnectionEl = doc.getElementById('meta-connection');
  const metaRoleEl = doc.getElementById('meta-role');
  const metaWhiteEl = doc.getElementById('meta-white');
  const metaWhiteNameEl = doc.getElementById('meta-white-name');
  const metaBlackEl = doc.getElementById('meta-black');
  const metaBlackNameEl = doc.getElementById('meta-black-name');
  const metaSpectatorsEl = doc.getElementById('meta-spectators');
  const metaVariantEl = doc.getElementById('meta-variant');
  const metaTimeEl = doc.getElementById('meta-time');
  const metaLiveStatusEl = doc.getElementById('meta-live-status');

  // Game action controls
  const actionsPanelEl = doc.getElementById('game-actions');
  const actionErrorEl = doc.getElementById('action-error');
  const btnOfferDraw = doc.getElementById('action-offer-draw') as HTMLButtonElement | null;
  const btnClaimFlag = doc.getElementById('action-claim-flag') as HTMLButtonElement | null;
  const btnResign = doc.getElementById('action-resign') as HTMLButtonElement | null;
  const btnAbort = doc.getElementById('action-abort') as HTMLButtonElement | null;
  const confirmResignEl = doc.getElementById('confirm-resign');
  const confirmResignYes = doc.getElementById('confirm-resign-yes');
  const confirmResignNo = doc.getElementById('confirm-resign-no');
  const confirmAbortEl = doc.getElementById('confirm-abort');
  const confirmAbortYes = doc.getElementById('confirm-abort-yes');
  const confirmAbortNo = doc.getElementById('confirm-abort-no');
  const drawOfferReceivedEl = doc.getElementById('draw-offer-received');
  const btnAcceptDraw = doc.getElementById('action-accept-draw');
  const btnDeclineDraw = doc.getElementById('action-decline-draw');

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
        onMetadata: (state) => {
          let liveAnnouncement = '';

          if (metaConnectionEl) {
            const connText = state.connected
              ? 'Connected'
              : state.role !== null
                ? 'Reconnecting…'
                : 'Connecting…';
            if (metaConnectionEl.textContent !== connText) {
              metaConnectionEl.textContent = connText;
              liveAnnouncement += `Connection: ${connText}. `;
            }
          }

          if (metaRoleEl) {
            const roleText = state.role === 'white' ? 'Playing as White'
              : state.role === 'black' ? 'Playing as Black'
              : state.role === 'spectator' ? 'Spectating'
              : 'Waiting…';
            metaRoleEl.textContent = roleText;
          }

          const unknownPresence = !state.connected || !state.presence;

          if (metaWhiteEl && metaWhiteNameEl) {
            const isMe = state.myColor === 'w';
            metaWhiteNameEl.textContent = 'White' + (isMe ? ' (You)' : '');
            
            const dot = metaWhiteEl.querySelector('.presence-dot');
            const txt = metaWhiteEl.querySelector('.presence-text');
            if (dot && txt) {
              if (unknownPresence) {
                dot.className = 'presence-dot offline';
                txt.textContent = 'Unknown';
              } else {
                const online = state.presence!.white;
                dot.className = `presence-dot ${online ? 'online' : 'offline'}`;
                const newTxt = online ? 'Online' : 'Offline';
                if (txt.textContent !== newTxt) {
                  txt.textContent = newTxt;
                  liveAnnouncement += `White is ${newTxt}. `;
                }
              }
            }
          }

          if (metaBlackEl && metaBlackNameEl) {
            const isMe = state.myColor === 'b';
            metaBlackNameEl.textContent = 'Black' + (isMe ? ' (You)' : '');
            
            const dot = metaBlackEl.querySelector('.presence-dot');
            const txt = metaBlackEl.querySelector('.presence-text');
            if (dot && txt) {
              if (unknownPresence) {
                dot.className = 'presence-dot offline';
                txt.textContent = 'Unknown';
              } else {
                const online = state.presence!.black;
                dot.className = `presence-dot ${online ? 'online' : 'offline'}`;
                const newTxt = online ? 'Online' : 'Offline';
                if (txt.textContent !== newTxt) {
                  txt.textContent = newTxt;
                  liveAnnouncement += `Black is ${newTxt}. `;
                }
              }
            }
          }

          if (metaSpectatorsEl) {
            metaSpectatorsEl.textContent = unknownPresence ? '—' : String(state.presence!.spectators);
          }

          if (metaVariantEl && state.variant) {
            metaVariantEl.textContent = state.variant.charAt(0).toUpperCase() + state.variant.slice(1);
          }
          if (metaTimeEl && state.timeControl) {
            metaTimeEl.textContent = formatTimeControl(state.timeControl);
          }

          if (metaLiveStatusEl && liveAnnouncement) {
            metaLiveStatusEl.textContent = liveAnnouncement.trim();
          }
        },
        onActionState: (state) => {
          if (actionsPanelEl) actionsPanelEl.hidden = !state.isPlayer;
          if (!state.isPlayer) return;

          const disabled = !state.connected || state.isOver || state.pendingAction !== null;

          if (btnOfferDraw) {
            if (state.drawOffer === 'sent') {
              btnOfferDraw.textContent = 'Draw offered';
              btnOfferDraw.disabled = true;
            } else {
              btnOfferDraw.textContent = 'Offer draw';
              btnOfferDraw.disabled = disabled || state.drawOffer !== 'none';
            }
          }
          if (btnClaimFlag) btnClaimFlag.disabled = disabled;

          if (btnResign) {
            btnResign.disabled = disabled;
            if (disabled && confirmResignEl && !confirmResignEl.hidden) {
              confirmResignEl.hidden = true;
              if (confirmResignYes instanceof HTMLButtonElement) confirmResignYes.disabled = true;
              if (confirmResignNo instanceof HTMLButtonElement) confirmResignNo.disabled = true;
              btnResign.hidden = false;
              statusEl?.focus();
            }
          }

          if (btnAbort) {
            btnAbort.hidden = !state.canAbort;
            btnAbort.disabled = disabled;
            if ((disabled || !state.canAbort) && confirmAbortEl && !confirmAbortEl.hidden) {
              confirmAbortEl.hidden = true;
              if (confirmAbortYes instanceof HTMLButtonElement) confirmAbortYes.disabled = true;
              if (confirmAbortNo instanceof HTMLButtonElement) confirmAbortNo.disabled = true;
              btnAbort.hidden = !state.canAbort;
              statusEl?.focus();
            }
          }

          if (drawOfferReceivedEl) {
            drawOfferReceivedEl.hidden = state.drawOffer !== 'received' || state.isOver;
          }
          if (btnAcceptDraw) {
            (btnAcceptDraw as HTMLButtonElement).disabled = disabled || state.drawOffer !== 'received';
          }
          if (btnDeclineDraw) {
            (btnDeclineDraw as HTMLButtonElement).disabled = disabled || state.drawOffer !== 'received';
          }

          if (actionErrorEl) {
            actionErrorEl.hidden = state.lastReject === null;
            actionErrorEl.textContent = state.lastReject ?? '';
          }
        },
      },
    });

    // Wire action buttons
    if (btnOfferDraw) {
      btnOfferDraw.addEventListener('click', () => controller.offerDraw());
    }
    if (btnClaimFlag) {
      btnClaimFlag.addEventListener('click', () => controller.claimFlag());
    }
    if (btnAcceptDraw) {
      btnAcceptDraw.addEventListener('click', () => controller.acceptDraw());
    }
    if (btnDeclineDraw) {
      btnDeclineDraw.addEventListener('click', () => controller.declineDraw());
    }

    // Inline confirmations
    if (btnResign && confirmResignEl && confirmResignYes && confirmResignNo) {
      btnResign.addEventListener('click', () => {
        btnResign.hidden = true;
        confirmResignEl.hidden = false;
        (confirmResignYes as HTMLButtonElement).disabled = false;
        (confirmResignNo as HTMLButtonElement).disabled = false;
        confirmResignYes.focus();
      });
      confirmResignNo.addEventListener('click', () => {
        confirmResignEl.hidden = true;
        btnResign.hidden = false;
        btnResign.focus();
      });
      confirmResignYes.addEventListener('click', () => {
        if (controller.resign()) {
          // Immediately disable to prevent double clicks before GameSync patches state
          (confirmResignYes as HTMLButtonElement).disabled = true;
          (confirmResignNo as HTMLButtonElement).disabled = true;
          statusEl?.focus();
        }
      });
    }

    if (btnAbort && confirmAbortEl && confirmAbortYes && confirmAbortNo) {
      btnAbort.addEventListener('click', () => {
        btnAbort.hidden = true;
        confirmAbortEl.hidden = false;
        (confirmAbortYes as HTMLButtonElement).disabled = false;
        (confirmAbortNo as HTMLButtonElement).disabled = false;
        confirmAbortYes.focus();
      });
      confirmAbortNo.addEventListener('click', () => {
        confirmAbortEl.hidden = true;
        btnAbort.hidden = false;
        btnAbort.focus();
      });
      confirmAbortYes.addEventListener('click', () => {
        if (controller.abort()) {
          // Immediately disable to prevent double clicks before GameSync patches state
          (confirmAbortYes as HTMLButtonElement).disabled = true;
          (confirmAbortNo as HTMLButtonElement).disabled = true;
          statusEl?.focus();
        }
      });
    }

    controller.start();

    // React to real browser connectivity changes: on `offline`, drop into the
    // reconnect flow immediately (a browser going offline should show
    // "Reconnecting…" now, not after a full heartbeat interval); on `online`,
    // retry at once instead of waiting out the backoff.
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => gameSync.networkOffline());
      window.addEventListener('online', () => gameSync.networkOnline());
    }

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

    return { app, board, controller, lobby: null, profile: null, tournament: null, auth, theme };
  }

  // --- Lobby view ---
  const lobbyEl = doc.getElementById('lobby');
  if (lobbyEl && route.name === 'lobby') {
    const seekListEl = doc.getElementById('seek-list');
    const createGameEl = doc.getElementById('create-game');
    const playBotMountEl = doc.getElementById('play-bot-mount');
    const errorEl = doc.getElementById('lobby-error');

    let panel: CreateGamePanel | null = null;

    const lobby = new LobbyController({
      client: app.api,
      callbacks: {
        onSeeks: (seeks) => {
          if (seekListEl) renderSeeks(seekListEl, seeks, app.api.session.current?.user.id ?? null);
        },
        onCreatePending: (pending) => {
          panel?.setPending(pending);
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onGameMatched: (gameId) => {
          window.location.href = `/game/${gameId}`;
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
        ...(deps?.storage !== undefined
          ? { storage: deps.storage }
          : typeof localStorage !== 'undefined'
            ? { storage: localStorage }
            : {}),
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

    // Mount the play-vs-computer dialog.
    // Variant is hardcoded to 'standard': the backend POST /v1/games/bot contract
    // accepts any variant code, but the Stockfish engine worker build only supports
    // standard chess rules (not Atomic, Crazyhouse, etc.). Offering other variants
    // would be a promise the backend engine worker cannot keep.
    if (playBotMountEl) {
      playBotDialog = new PlayBotDialog({
        doc,
        mount: playBotMountEl,
        initialAuthenticated: auth.isAuthenticated(),
        callbacks: {
          onSubmit: async (params) => {
            const result = await lobby.createBotGame({
              ...params,
              variant: 'standard',
            });
            if (!result.ok) {
              playBotDialog?.setError(result.message);
              return null;
            }
            window.location.href = `/game/${result.gameId}`;
            return result.gameId;
          },
        },
      });
    }

    // Wire cancel/accept buttons (event delegation on the seek list).
    if (seekListEl) {
      seekListEl.addEventListener('click', (e) => {
        const target = e.target;
        if (target instanceof HTMLElement && target.dataset.seekId) {
          const id = target.dataset.seekId;
          if (target.classList.contains('seek-cancel')) {
            void lobby.cancelSeek(id);
          } else if (target.classList.contains('seek-accept')) {
            void lobby.acceptSeek(id);
          }
        }
      });
    }

    lobby.start();

    return { app, board: null, controller: null, lobby, profile: null, tournament: null, auth, theme };
  }

  // --- Profile view ---
  const profileEl = doc.getElementById('profile');
  if (profileEl && route.name === 'profile') {
    const handleEl = doc.getElementById('profile-handle');
    const ratingsEl = doc.getElementById('profile-ratings');
    const gamesEl = doc.getElementById('profile-games');
    const profileErrorEl = doc.getElementById('profile-error');

    // --- Social region (M10 inc 9) ---
    const socialActionsEl = doc.getElementById('social-actions');
    const followersEl = doc.getElementById('social-followers');
    const followingEl = doc.getElementById('social-following');
    const followerCountEl = doc.getElementById('social-follower-count');
    const followingCountEl = doc.getElementById('social-following-count');
    const socialSelfEl = doc.getElementById('social-self');
    const incomingEl = doc.getElementById('social-incoming');
    const outgoingEl = doc.getElementById('social-outgoing');
    const friendsEl = doc.getElementById('social-friends');
    const friendCountEl = doc.getElementById('social-friend-count');
    const blockedEl = doc.getElementById('social-blocked');
    const socialNoteEl = doc.getElementById('social-note');
    const socialErrorEl = doc.getElementById('social-error');

    let socialBusy = false;
    let lastRelationship: Relationship | null = null;
    let lastSelfSocial: SelfSocial | null = null;

    const social = new SocialController({
      client: app.api,
      callbacks: {
        onConnections: (c) => {
          if (followerCountEl) followerCountEl.textContent = String(c.followerCount);
          if (followingCountEl) followingCountEl.textContent = String(c.followingCount);
          if (followersEl) {
            renderPlayerList(
              followersEl,
              c.followers,
              { title: 'No followers yet', body: 'Followers appear here once someone follows this player.' },
              socialBusy,
            );
          }
          if (followingEl) {
            renderPlayerList(
              followingEl,
              c.following,
              { title: 'Not following anyone yet', body: 'Players this account follows appear here.' },
              socialBusy,
            );
          }
          if (socialNoteEl) {
            // Names come only from the read layer. Saying so beats showing
            // truncated ids with no explanation.
            socialNoteEl.textContent = c.named
              ? ''
              : 'Player names are unavailable while the read layer is disabled; showing partial ids.';
          }
        },
        onRelationship: (r) => {
          lastRelationship = r;
          if (socialActionsEl) renderSocialActions(socialActionsEl, r, social, socialBusy);
        },
        onSelfSocial: (s) => {
          lastSelfSocial = s;
          if (socialSelfEl) socialSelfEl.hidden = s === null;
          if (s === null) return;
          if (incomingEl) {
            incomingEl.innerHTML = '';
            if (s.incoming.length === 0) {
              renderEmpty(incomingEl, {
                title: 'No requests waiting',
                body: 'Friend requests sent to you appear here.',
                inline: true,
              });
            } else {
              for (const { request, player } of s.incoming) {
                appendPanelRow(
                  incomingEl,
                  player.handle,
                  [
                    { label: 'Accept', run: () => void social.respond(request.id, 'accept') },
                    { label: 'Decline', run: () => void social.respond(request.id, 'decline') },
                  ],
                  socialBusy,
                );
              }
            }
          }
          if (outgoingEl) {
            outgoingEl.innerHTML = '';
            if (s.outgoing.length === 0) {
              renderEmpty(outgoingEl, {
                title: 'Nothing pending',
                body: 'Requests you send appear here until they are answered.',
                inline: true,
              });
            } else {
              for (const { request, player } of s.outgoing) {
                appendPanelRow(
                  outgoingEl,
                  player.handle,
                  [{ label: 'Cancel', run: () => void social.respond(request.id, 'cancel') }],
                  socialBusy,
                );
              }
            }
          }
          if (friendCountEl) friendCountEl.textContent = String(s.friends.length);
          if (friendsEl) {
            renderPlayerList(
              friendsEl,
              s.friends,
              { title: 'No friends yet', body: 'Accepted friend requests appear here.' },
              socialBusy,
            );
          }
          if (blockedEl) {
            renderPlayerList(
              blockedEl,
              s.blocked,
              { title: 'No blocked players', body: 'Players you block appear here.' },
              socialBusy,
              (player) => [{ label: 'Unblock', run: () => void social.unblock(player.id) }],
            );
          }
        },
        onBusy: (busy) => {
          socialBusy = busy;
          // Re-render only what carries controls, so a click cannot land twice.
          if (socialActionsEl) renderSocialActions(socialActionsEl, lastRelationship, social, busy);
          if (lastSelfSocial !== null && socialSelfEl && !socialSelfEl.hidden) {
            for (const el of [incomingEl, outgoingEl, blockedEl]) {
              if (!el) continue;
              for (const button of el.querySelectorAll('button')) button.disabled = busy;
            }
          }
        },
        onError: (msg) => {
          if (socialErrorEl) socialErrorEl.textContent = msg;
        },
      },
    });

    // Remembered so a later sign-in or sign-out can reload the region for the
    // new viewer. Without this the relationship is a snapshot of whoever was
    // signed in when the profile rendered: signing out would leave working
    // Follow/Block controls on screen, and signing in would show none at all,
    // until the visitor happened to navigate.
    let socialSubject: SocialPlayer | null = null;
    const loadSocialFor = (player: SocialPlayer): void => {
      socialSubject = player;
      if (socialErrorEl) socialErrorEl.textContent = '';
      void social.load(player, auth.currentSession?.userId ?? null);
    };

    const profile = new ProfileController({
      client: app.api,
      callbacks: {
        onProfile: (p) => {
          if (handleEl) handleEl.textContent = p.user.handle;
          loadSocialFor({ id: p.user.id, handle: p.user.handle });
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
      // Another player's profile: the page itself does not change when the
      // viewer's session does, but who they are to this player does — so the
      // social region reloads while the profile above it stays put.
      selfProfileSessionHandler = () => {
        if (socialSubject !== null) loadSocialFor(socialSubject);
      };
    } else {
      // Session restoration rotates the httpOnly refresh cookie and is
      // asynchronous. Loading /users/me before it finishes produces a false
      // "no active session" error even though the header becomes signed-in a
      // moment later. Wait for the authenticated session, and also react when
      // a user signs in while already on this route.
      let loadedUserId: string | null = null;
      const clearSelfProfile = (): void => {
        if (handleEl) handleEl.textContent = '';
        if (ratingsEl) ratingsEl.innerHTML = '';
        if (gamesEl) gamesEl.innerHTML = '';
        if (profileErrorEl) profileErrorEl.textContent = '';
        // Signing out must take the social region with it — leaving one
        // account's friends and blocked list on screen for the next visitor
        // would be a disclosure, not a stale render.
        social.reset();
        for (const el of [socialActionsEl, followersEl, followingEl, incomingEl, outgoingEl, friendsEl, blockedEl]) {
          if (el) el.innerHTML = '';
        }
        for (const el of [followerCountEl, followingCountEl, friendCountEl, socialNoteEl, socialErrorEl]) {
          if (el) el.textContent = '';
        }
        if (socialSelfEl) socialSelfEl.hidden = true;
      };
      selfProfileSessionHandler = (session) => {
        if (session === null) {
          loadedUserId = null;
          profile.reset();
          clearSelfProfile();
          if (profileErrorEl) profileErrorEl.textContent = 'Sign in to view your profile.';
          return;
        }

        if (session.userId === loadedUserId) return;

        loadedUserId = session.userId;
        profile.reset();
        clearSelfProfile();
        void profile.loadSelf();
      };
      if (auth.currentSession !== null) {
        selfProfileSessionHandler(auth.currentSession);
      } else {
        void restorePromise.then((session) => selfProfileSessionHandler?.(session));
      }
    }

    return { app, board: null, controller: null, lobby: null, profile, tournament: null, auth, theme };
  }

  // --- Tournaments list view ---
  const tournamentsEl = doc.getElementById('tournaments');
  if (tournamentsEl && route.name === 'tournaments') {
    const listEl = doc.getElementById('tournament-list');
    const errorEl = doc.getElementById('tournaments-error');
    let listRendered = false;

    const tournament = new TournamentController({
      client: app.api,
      callbacks: {
        onList: (items) => {
          listRendered = true;
          if (listEl) renderTournamentList(listEl, items);
        },
        onDetail: () => {},
        onStandings: () => {},
        onLiveGames: () => {},
        onLoading: (loading) => {
          if (!listEl) return;
          listEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (loading) {
            listRendered = false;
            listEl.innerHTML = '<div class="panel-row">Loading…</div>';
            return;
          }
          // Loading ended without a render, so the request failed. The error line says what went
          // wrong; leaving "Loading…" underneath it would contradict that and imply work still
          // in progress.
          if (!listRendered) listEl.innerHTML = '';
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    void tournament.loadList();
    return { app, board: null, controller: null, lobby: null, profile: null, tournament, auth, theme };
  }

  // --- Single tournament detail view ---
  const tournamentEl = doc.getElementById('tournament');
  if (tournamentEl && route.name === 'tournament') {
    const metaEl = doc.getElementById('tournament-meta');
    const standingsEl = doc.getElementById('tournament-standings');
    const liveEl = doc.getElementById('tournament-live');
    const errorEl = doc.getElementById('tournament-error');

    let currentDetail: TournamentDetail | null = null;

    const tournament = new TournamentController({
      client: app.api,
      callbacks: {
        onList: () => {},
        onDetail: (detail) => {
          currentDetail = detail;
          const nameEl = doc.getElementById('tournament-name');
          if (nameEl) nameEl.textContent = detail.name;
          if (metaEl) renderTournamentDetail(metaEl, detail);
          if (detail.state === 'running') {
            tournament.startLive(detail.id);
          }
        },
        onStandings: (standings, names) => {
          if (standingsEl) renderStandings(standingsEl, standings, names);
        },
        onLiveGames: (games, names) => {
          if (liveEl) renderLiveBoards(liveEl, games, names);
        },
        onLoading: (loading) => {
          if (metaEl) metaEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (standingsEl) standingsEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (liveEl) liveEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (!metaEl) return;
          if (loading && currentDetail === null) {
            metaEl.innerHTML = '<div class="panel-row">Loading…</div>';
            return;
          }
          // Loading finished with no detail: the load failed. Clear the placeholder so the error
          // line is not sitting under a claim that the page is still fetching.
          if (!loading && currentDetail === null) metaEl.innerHTML = '';
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    void tournament.loadDetail(route.id);
    return { app, board: null, controller: null, lobby: null, profile: null, tournament, auth, theme };
  }

  // --- Standalone board (no game ID, no lobby, no profile, no tournament) ---
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return { app, board, controller: null, lobby: null, profile: null, tournament: null, auth, theme };
}
