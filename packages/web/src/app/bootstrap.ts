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
import { applyNavCapabilities } from './capabilities-nav.js';
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
import { LeaderboardController } from './leaderboard-controller.js';
import { renderLeaderboard, renderVariantSelector, bindVariantSelector } from './leaderboard-view.js';
import { OFFERED_VARIANTS } from '../api/models.js';
import type { Variant } from '../api/models.js';
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
  appendPanelRow,
} from './render-helpers.js';
import type { EmptyStateOptions, RowAction } from './render-helpers.js';
import { SocialController } from './social-controller.js';
import type { Relationship, SelfSocial } from './social-controller.js';
import { AchievementsController } from './achievements-controller.js';
import { renderAchievements } from './achievements-view.js';
import { summaryLabel } from './achievements-helpers.js';
import { SearchController } from './search-controller.js';
import type { SearchController as SearchControllerType } from './search-controller.js';
import { LearningController } from './learning-controller.js';
import type { LearningController as LearningControllerType } from './learning-controller.js';
import { renderCourseList, renderCourseDetail, renderLessonDetail } from './learning-view.js';
import { courseProgressLabel, stepStatusLabel } from './learning-helpers.js';
import { StudiesController } from './studies-controller.js';
import type { StudiesController as StudiesControllerType } from './studies-controller.js';
import { renderStudyList, renderStudyDetail, renderChapterDetail } from './studies-view.js';
import { MessagesController } from './messages-controller.js';
import { TeamsController } from './teams-controller.js';
import { ForumController } from './forum-controller.js';
import type { ForumController as ForumControllerType } from './forum-controller.js';
import { renderThreadList, renderPosts } from './forum-view.js';
import { canStartThread, canReply, abilityExplanation, threadDisplayTitle } from './forum-helpers.js';
import type { TeamsController as TeamsControllerType } from './teams-controller.js';
import { renderTeamList, renderTeamMembers, renderJoinRequests } from './teams-view.js';
import { teamAction, actionExplanation, membershipOf, createJoinRequestQueue } from './teams-helpers.js';
import type { MessagesController as MessagesControllerType } from './messages-controller.js';
import { renderSearchResults, renderSearchPrompt } from './search-view.js';
import { renderInbox, renderThread } from './messages-view.js';
import { parseSearchMode } from './search-results.js';
import type { JoinRequestView, SearchMode, SocialPlayer, TournamentDetail } from '../api/models.js';
import { ThemeToggle } from './theme-toggle.js';
import type { ThemeToggle as ThemeToggleType } from './theme-toggle.js';
import { AuthController } from './auth-controller.js';
import type { AuthController as AuthControllerType } from './auth-controller.js';
import type { AuthSession } from './auth-controller.js';
import { PasskeysController } from './passkeys-controller.js';
import { renderPasskeys } from './passkeys-view.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';
import { parseRoute } from './router.js';
import { shortId } from '../api/graphql.js';
import type { SeekView } from '../api/models.js';
import type { TimeControl } from '../net/ws-protocol.js';

export { renderEmpty, formatClock, formatTimeControl };
export type { EmptyStateOptions };

/** Disposables returned by bootstrap, torn down on SPA route navigation. */
export interface BootstrappedDisposables {
  readonly app: App;
  readonly controller: GameControllerType | null;
  readonly board: MountedBoard | null;
  readonly lobby: LobbyControllerType | null;
  readonly profile: ProfileControllerType | null;
  readonly leaderboard: { dispose: () => void } | null;
  readonly tournament: TournamentControllerType | null;
  readonly search: SearchControllerType | null;
  readonly messages: MessagesControllerType | null;
  readonly teams: TeamsControllerType | null;
  readonly forum: ForumControllerType | null;
  readonly learning: LearningControllerType | null;
  readonly studies: StudiesControllerType | null;
  readonly passkeys: { dispose: () => void } | null;
  readonly connectivity: { dispose: () => void } | null;
}

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped extends BootstrappedDisposables {
  readonly auth: AuthControllerType;
  readonly theme: ThemeToggleType;
}

/** Key of disposables returned by bootstrap. Driven by BootstrappedDisposables for structural teardown exhaustiveness. */
export type DisposableKey = keyof BootstrappedDisposables;

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
  /** Override native WebAuthn ceremonies for tests or alternate browser hosts. */
  readonly webauthnAdapter?: WebAuthnAdapter;
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
  onOpenMessage?: () => void,
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

    if (onOpenMessage) {
      actions.push({ label: 'Message', run: onOpenMessage, communicative: true });
    }

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
    if (action.communicative) button.classList.add('social-action-communicate');
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

  // --- Capabilities-driven navigation ---
  void applyNavCapabilities(doc, app.api);

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
  const authPasskeyEl = doc.getElementById('auth-passkey');
  const authLogoutEl = doc.getElementById('auth-logout');
  const authStatusEl = doc.getElementById('auth-status');
  const authSectionEl = doc.getElementById('auth');

  let selfProfileSessionHandler: ((session: AuthSession | null) => void) | null = null;
  let playBotDialog: PlayBotDialog | null = null;
  const auth = new AuthController({
    client: app.api,
    ...(deps?.webauthnAdapter !== undefined ? { webauthnAdapter: deps.webauthnAdapter } : {}),
    callbacks: {
      onSessionChange: (session) => {
        if (authStatusEl) {
          authStatusEl.textContent = session ? `Signed in as ${session.handle}` : 'Not signed in';
        }
        // Show/hide the sign-in surface vs the logout button. The *section* is what hides, not just
        // the form inside it: the section carries the heading and the panel, so hiding only the
        // form left a signed-in visitor looking at an empty box titled "Sign in". That was
        // invisible while the section had no styling and obvious the moment it got some.
        if (authSectionEl) authSectionEl.hidden = session !== null;
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
        if (authPasskeyEl instanceof HTMLButtonElement) {
          authPasskeyEl.disabled = pending;
        }
      },
      onError: (msg) => {
        if (authErrorEl) authErrorEl.textContent = msg;
      },
    },
    ...(deps?.storage !== undefined ? { storage: deps.storage } : typeof localStorage !== 'undefined' ? { storage: localStorage } : {}),
  });

  // Wire auth form submit (sign in). Bound on the *form*, not on the button's click: the markup
  // used to carry `onsubmit="return false"` with both buttons `type="button"`, so pressing Enter
  // in the password field did nothing at all and signing in required reaching for the mouse. Every
  // other form in this file already binds `onsubmit` and calls `preventDefault()`; this one now
  // does too, and `auth-submit` is `type="submit"` so the click arrives through the same path.
  const submitSignIn = (): void => {
    const handle = authHandleEl?.value ?? '';
    const password = authPasswordEl?.value ?? '';
    if (handle && password) {
      void auth.login(handle, password);
    }
  };
  if (authFormEl instanceof HTMLFormElement) {
    authFormEl.onsubmit = (e): void => {
      e.preventDefault();
      submitSignIn();
    };
  }

  // Static auth controls survive SPA re-bootstrap, so property assignment keeps these bindings
  // idempotent. The register button is type="button", so trigger native form validation explicitly.
  if (authRegisterEl instanceof HTMLButtonElement) {
    authRegisterEl.onclick = () => {
      if (authFormEl instanceof HTMLFormElement && !authFormEl.reportValidity()) {
        return;
      }
      const handle = authHandleEl?.value ?? '';
      const password = authPasswordEl?.value ?? '';
      if (handle && password) {
        void auth.register(handle, password);
      }
    };
  }

  if (authPasskeyEl instanceof HTMLButtonElement) {
    authPasskeyEl.onclick = () => {
      const handle = authHandleEl?.value ?? '';
      void auth.loginWithPasskey(handle);
    };
  }

  if (authLogoutEl instanceof HTMLButtonElement) {
    authLogoutEl.onclick = () => {
      void auth.logout();
    };
  }

  // The header search form lives in the nav, outside every section this function replaces, so it
  // survives each re-run — and a listener attached here would be added again on every navigation
  // until one submit fired a whole stack of them. Its handler is bound once in `main.ts`, next to
  // the other document-level handlers, for exactly that reason. Only the value is refreshed here.
  const searchInputEl = doc.getElementById('search-input') as HTMLInputElement | null;

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
  const leaderboardSectionEl = doc.getElementById('leaderboard');
  const tournamentsSectionEl = doc.getElementById('tournaments');
  const tournamentSectionEl = doc.getElementById('tournament');
  const searchSectionEl = doc.getElementById('search');
  const messagesSectionEl = doc.getElementById('messages');
  const conversationSectionEl = doc.getElementById('conversation');
  const teamsSectionEl = doc.getElementById('teams');
  const teamSectionEl = doc.getElementById('team');
  const forumSectionEl = doc.getElementById('forum');
  const threadSectionEl = doc.getElementById('thread');
  const coursesSectionEl = doc.getElementById('courses');
  const courseSectionEl = doc.getElementById('course');
  const lessonSectionEl = doc.getElementById('lesson');
  const studiesSectionEl = doc.getElementById('studies');
  const studySectionEl = doc.getElementById('study');
  const studyChapterSectionEl = doc.getElementById('study-chapter');
  const showGame = route.name === 'game';
  const showLobby = route.name === 'lobby';
  const showProfile = route.name === 'profile';
  const showLeaderboard = route.name === 'leaderboard';
  const showTournaments = route.name === 'tournaments';
  const showTournament = route.name === 'tournament';
  const showSearch = route.name === 'search';
  const showMessages = route.name === 'messages';
  const showConversation = route.name === 'conversation';
  const showTeams = route.name === 'teams';
  const showTeam = route.name === 'team';
  const showForum = route.name === 'forum';
  const showThread = route.name === 'thread';
  const showCourses = route.name === 'courses';
  const showCourse = route.name === 'course';
  const showLesson = route.name === 'lesson';
  const showStudies = route.name === 'studies';
  const showStudy = route.name === 'study';
  const showStudyChapter = route.name === 'study-chapter';
  doc.body.classList.toggle('route-game', showGame);
  if (mainEl) mainEl.hidden = !showGame;
  if (lobbySectionEl) lobbySectionEl.hidden = !showLobby;
  if (profileSectionEl) profileSectionEl.hidden = !showProfile;
  if (leaderboardSectionEl) leaderboardSectionEl.hidden = !showLeaderboard;
  if (tournamentsSectionEl) tournamentsSectionEl.hidden = !showTournaments;
  if (tournamentSectionEl) tournamentSectionEl.hidden = !showTournament;
  if (searchSectionEl) searchSectionEl.hidden = !showSearch;
  if (messagesSectionEl) messagesSectionEl.hidden = !showMessages;
  if (conversationSectionEl) conversationSectionEl.hidden = !showConversation;
  if (teamsSectionEl) teamsSectionEl.hidden = !showTeams;
  if (teamSectionEl) teamSectionEl.hidden = !showTeam;
  if (forumSectionEl) forumSectionEl.hidden = !showForum;
  if (threadSectionEl) threadSectionEl.hidden = !showThread;
  if (coursesSectionEl) coursesSectionEl.hidden = !showCourses;
  if (courseSectionEl) courseSectionEl.hidden = !showCourse;
  if (lessonSectionEl) lessonSectionEl.hidden = !showLesson;
  if (studiesSectionEl) studiesSectionEl.hidden = !showStudies;
  if (studySectionEl) studySectionEl.hidden = !showStudy;
  if (studyChapterSectionEl) studyChapterSectionEl.hidden = !showStudyChapter;

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
    let connectivity: { dispose: () => void } | null = null;
    if (typeof window !== 'undefined') {
      const connectivityTarget = window;
      const onOffline = (): void => gameSync.networkOffline();
      const onOnline = (): void => gameSync.networkOnline();
      connectivityTarget.addEventListener('offline', onOffline);
      connectivityTarget.addEventListener('online', onOnline);
      connectivity = {
        dispose: (): void => {
          connectivityTarget.removeEventListener('offline', onOffline);
          connectivityTarget.removeEventListener('online', onOnline);
        },
      };
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

    return { app, board, controller, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity, auth, theme };
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

    return { app, board: null, controller: null, lobby, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
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

    // --- Achievements region (M14 inc 22) ---
    const achievementsEl = doc.getElementById('achievements');
    const achievementsListEl = doc.getElementById('achievements-list');
    const achievementsCountEl = doc.getElementById('achievements-count');
    const achievementsErrorEl = doc.getElementById('achievements-error');

    // --- Passkeys region (M14 inc 44) ---
    const passkeysSelfEl = doc.getElementById('passkeys-self');
    const passkeysCountEl = doc.getElementById('passkeys-count');
    const passkeysRegisterEl = doc.getElementById('passkey-register');
    const passkeysListEl = doc.getElementById('passkeys-list');
    const passkeysNoteEl = doc.getElementById('passkeys-note');
    const passkeysErrorEl = doc.getElementById('passkeys-error');

    let socialBusy = false;
    let passkeysBusy = false;
    let lastRelationship: Relationship | null = null;
    let lastSelfSocial: SelfSocial | null = null;
    let passkeysCtrl: PasskeysController | null = null;
    let passkeysUnbind = () => {};

    const handle = route.name === 'profile' ? route.handle : null;
    if (!handle) {
      passkeysCtrl = new PasskeysController({
        client: app.api,
        ...(deps?.webauthnAdapter !== undefined ? { webauthnAdapter: deps.webauthnAdapter } : {}),
        callbacks: {
          onPasskeys: (items) => {
            if (passkeysCountEl) passkeysCountEl.textContent = items.length > 0 ? `(${items.length})` : '';
            if (passkeysListEl) {
              renderPasskeys(
                passkeysListEl,
                items,
                (id) => void passkeysCtrl?.deletePasskey(id),
                passkeysBusy,
              );
            }
          },
          onPending: (pending) => {
            passkeysBusy = pending;
            if (passkeysRegisterEl instanceof HTMLButtonElement) {
              passkeysRegisterEl.disabled = pending;
            }
            if (passkeysListEl) {
              for (const btn of passkeysListEl.querySelectorAll('button')) {
                btn.disabled = pending;
              }
            }
          },
          onError: (msg) => {
            if (passkeysErrorEl) passkeysErrorEl.textContent = msg;
          },
          onStatus: (msg) => {
            if (passkeysNoteEl) passkeysNoteEl.textContent = msg;
            if (passkeysErrorEl) passkeysErrorEl.textContent = '';
          },
        },
      });

      if (passkeysRegisterEl instanceof HTMLButtonElement) {
        const handler = () => {
          if (passkeysNoteEl) passkeysNoteEl.textContent = '';
          if (passkeysErrorEl) passkeysErrorEl.textContent = '';
          void passkeysCtrl?.registerPasskey();
        };
        passkeysRegisterEl.addEventListener('click', handler);
        passkeysUnbind = () => passkeysRegisterEl.removeEventListener('click', handler);
      }
    }

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
          if (socialActionsEl) renderSocialActions(socialActionsEl, r, social, socialBusy, getOpenMessageFn());
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
          if (socialActionsEl) renderSocialActions(socialActionsEl, lastRelationship, social, busy, getOpenMessageFn());
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
    const getOpenMessageFn = (): (() => void) | undefined => {
      const viewerId = auth.currentSession?.userId;
      const targetId = socialSubject?.id;
      if (!viewerId || !targetId || viewerId === targetId) return undefined;
      return () => {
        void (async () => {
          try {
            const conv = await app.api.messages.openWith(targetId);
            const url = `/messages/${encodeURIComponent(conv.id)}`;
            history.pushState(null, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
          } catch (err) {
            if (socialErrorEl) socialErrorEl.textContent = err instanceof Error ? err.message : String(err);
          }
        })();
      };
    };

    const loadSocialFor = (player: SocialPlayer): void => {
      socialSubject = player;
      if (socialErrorEl) socialErrorEl.textContent = '';
      void social.load(player, auth.currentSession?.userId ?? null);
    };

    const achievements = new AchievementsController({
      client: app.api,
      callbacks: {
        onAchievements: (items, summary) => {
          if (achievementsCountEl) achievementsCountEl.textContent = summaryLabel(summary, items);
          if (achievementsListEl) renderAchievements(achievementsListEl, items);
          if (achievementsErrorEl) achievementsErrorEl.textContent = '';
          if (achievementsEl) achievementsEl.hidden = false;
        },
        onError: (msg) => {
          // Revealed on failure, unlike the unavailable case: a load that broke for this profile is
          // something the visitor can retry, so saying nothing would look like the player has none.
          if (achievementsErrorEl) achievementsErrorEl.textContent = msg;
          if (achievementsEl) achievementsEl.hidden = false;
        },
        onUnavailable: () => {
          if (achievementsEl) achievementsEl.hidden = true;
        },
      },
    });

    const loadAchievementsFor = (playerId: string): void => {
      achievements.reset();
      if (achievementsListEl) achievementsListEl.replaceChildren();
      if (achievementsCountEl) achievementsCountEl.textContent = '';
      if (achievementsErrorEl) achievementsErrorEl.textContent = '';
      void achievements.load(playerId);
    };

    const profile = new ProfileController({
      client: app.api,
      callbacks: {
        onProfile: (p) => {
          if (handleEl) handleEl.textContent = p.user.handle;
          loadSocialFor({ id: p.user.id, handle: p.user.handle });
          // Keyed by id, not handle: both achievements routes take a player id, and this is the
          // first point on the page where one is known.
          loadAchievementsFor(p.user.id);
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
        // Achievements are public, so a stale one is not a disclosure the way a friends list is —
        // but leaving the previous account's row of unlocks under a blank handle still reads as
        // the next visitor's, so it goes with the rest.
        achievements.reset();
        passkeysCtrl?.reset();
        if (achievementsEl) achievementsEl.hidden = true;
        if (achievementsCountEl) achievementsCountEl.textContent = '';
        if (passkeysCountEl) passkeysCountEl.textContent = '';
        if (passkeysNoteEl) passkeysNoteEl.textContent = '';
        if (passkeysErrorEl) passkeysErrorEl.textContent = '';
        if (passkeysSelfEl) passkeysSelfEl.hidden = true;
        for (const el of [socialActionsEl, followersEl, followingEl, incomingEl, outgoingEl, friendsEl, blockedEl, achievementsListEl, passkeysListEl]) {
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
        if (passkeysSelfEl) passkeysSelfEl.hidden = false;
        void passkeysCtrl?.load();
      };
      if (auth.currentSession !== null) {
        selfProfileSessionHandler(auth.currentSession);
      } else {
        void restorePromise.then((session) => selfProfileSessionHandler?.(session));
      }
    }

    const passkeys = passkeysCtrl
      ? {
          dispose: (): void => {
            passkeysUnbind();
            passkeysCtrl?.dispose();
          },
        }
      : null;
    return { app, board: null, controller: null, lobby: null, profile, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys, connectivity: null, auth, theme };
  }

  // --- Leaderboard view ---
  const leaderboardEl = doc.getElementById('leaderboard');
  if (leaderboardEl && route.name === 'leaderboard') {
    const selectEl = doc.getElementById('leaderboard-variant-select') as HTMLSelectElement | null;
    const loadingEl = doc.getElementById('leaderboard-loading');
    const resultsEl = doc.getElementById('leaderboard-results');
    const errorEl = doc.getElementById('leaderboard-error');
    let resultsRendered = false;

    let activeVariant: Variant = 'standard';
    if (selectEl) {
      renderVariantSelector(selectEl, activeVariant);
    }

    const leaderboardCtrl = new LeaderboardController({
      client: app.api,
      callbacks: {
        onResults: (entries, names, _variant) => {
          resultsRendered = true;
          if (errorEl) errorEl.textContent = '';
          if (resultsEl) renderLeaderboard(resultsEl, entries, names);
        },
        onLoading: (loading) => {
          if (!resultsEl || !loadingEl) return;
          resultsEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (loading) {
            resultsRendered = false;
            if (errorEl) errorEl.textContent = '';
            resultsEl.hidden = true;
            loadingEl.hidden = false;
            return;
          }
          loadingEl.hidden = true;
          resultsEl.hidden = false;
          if (!resultsRendered) resultsEl.innerHTML = '';
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    let unbind = () => {};
    if (selectEl) {
      unbind = bindVariantSelector(selectEl, (val) => {
        activeVariant = val;
        void leaderboardCtrl.loadLeaderboard(activeVariant);
      });
    }

    void leaderboardCtrl.loadLeaderboard(activeVariant);
    return {
      app, board: null, controller: null, lobby: null, profile: null,
      leaderboard: {
        dispose: () => {
          unbind();
          leaderboardCtrl.dispose();
        }
      },
      tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme
    };
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
    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
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
    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Search view ---
  const searchEl = doc.getElementById('search');
  if (searchEl && route.name === 'search') {
    const modeMountEl = doc.getElementById('search-mode');
    const resultsEl = doc.getElementById('search-results');
    const errorEl = doc.getElementById('search-error');

    // These elements are static in index.html, so state set by a previous run outlives it. A search
    // abandoned by navigating away is disposed before `onLoading(false)` reaches the DOM, which
    // would otherwise leave the region announcing itself as busy forever. Starting each run from a
    // known state costs nothing and does not depend on the controller getting a last word in.
    if (resultsEl) resultsEl.setAttribute('aria-busy', 'false');
    if (errorEl) errorEl.textContent = '';

    const searchParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const rawQ = searchParams.get('q') ?? '';
    const q = rawQ.trim();
    const activeMode = parseSearchMode(searchParams.get('mode'));

    if (searchInputEl) {
      searchInputEl.value = rawQ;
    }

    // Render mode selector (segmented control matching create-game-panel.ts)
    if (modeMountEl) {
      modeMountEl.innerHTML = '';
      const modes: { readonly value: SearchMode; readonly label: string }[] = [
        { value: 'keyword', label: 'Keyword' },
        { value: 'semantic', label: 'Semantic' },
        { value: 'hybrid', label: 'Hybrid' },
      ];
      for (const m of modes) {
        const labelEl = doc.createElement('label');
        labelEl.className = 'cg-seg';
        const inputEl = doc.createElement('input');
        inputEl.type = 'radio';
        inputEl.name = 'search-mode-option';
        inputEl.value = m.value;
        if (m.value === activeMode) inputEl.checked = true;

        inputEl.addEventListener('change', () => {
          if (inputEl.checked) {
            const params = new URLSearchParams();
            if (q) params.set('q', q);
            if (m.value !== 'keyword') params.set('mode', m.value);
            const url = `/search?${params.toString()}`;

            // Reuse the single navigation path: update history and dispatch popstate.
            history.pushState(null, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }
        });

        const spanEl = doc.createElement('span');
        spanEl.className = 'cg-seg-label';
        spanEl.textContent = m.label;

        labelEl.append(inputEl, spanEl);
        modeMountEl.appendChild(labelEl);
      }
    }

    let resultsRendered = false;
    const searchCtrl = new SearchController({
      client: app.api,
      callbacks: {
        onResults: (hits) => {
          resultsRendered = true;
          if (errorEl) errorEl.textContent = '';
          if (resultsEl) renderSearchResults(resultsEl, hits);
        },
        onLoading: (loading) => {
          if (!resultsEl) return;
          // `aria-busy` carries the state on its own. The placeholder that used to sit here was a
          // `.panel-row` reading "Loading…" — a counterfeit result inside the results list, which a
          // screen reader announces as a row. It existed to cover the window while per-result
          // hydration filled in; hits now arrive complete in one request (ADR-0094), so the window
          // it covered is a single round trip and the fake row costs more than it buys.
          resultsEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (loading) {
            resultsRendered = false;
            return;
          }
          if (!resultsRendered) resultsEl.innerHTML = '';
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    if (q) {
      void searchCtrl.search(q, activeMode);
    } else {
      if (resultsEl) renderSearchPrompt(resultsEl);
    }

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: searchCtrl, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Messages Inbox view (/messages) ---
  const messagesEl = doc.getElementById('messages');
  if (messagesEl && route.name === 'messages') {
    const inboxEl = doc.getElementById('messages-inbox');
    const errorEl = doc.getElementById('messages-error');
    const getUserId = () => app.api.session.current?.user.id ?? null;

    const messagesCtrl = new MessagesController({
      client: app.api,
      callbacks: {
        onInbox: (items, names) => {
          if (errorEl) errorEl.textContent = '';
          if (inboxEl) renderInbox(inboxEl, items, names, getUserId());
        },
        onThread: () => {},
        onLoading: (loading) => {
          if (inboxEl) inboxEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    if (auth.currentSession !== null) {
      void messagesCtrl.loadInbox();
    } else {
      void restorePromise
        .then(() => void messagesCtrl.loadInbox())
        .catch(() => undefined);
    }

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: messagesCtrl, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Conversation Thread view (/messages/:id) ---
  const conversationEl = doc.getElementById('conversation');
  if (conversationEl && route.name === 'conversation') {
    const threadEl = doc.getElementById('conversation-thread');
    const participantEl = doc.getElementById('conversation-participant');
    const errorEl = doc.getElementById('conversation-error');
    const composerEl = doc.getElementById('conversation-composer') as HTMLFormElement | null;
    const composerInputEl = doc.getElementById('composer-input') as HTMLInputElement | null;
    const getUserId = () => app.api.session.current?.user.id ?? null;
    const convId = route.id;

    const messagesCtrl = new MessagesController({
      client: app.api,
      callbacks: {
        onInbox: () => {},
        onThread: (_id, messages, names, otherParticipantId) => {
          if (errorEl) errorEl.textContent = '';
          const currentUserId = getUserId();
          if (threadEl) renderThread(threadEl, messages, names, currentUserId);

          if (participantEl) {
            // Named from the conversation's participants, never inferred from who has posted: a
            // thread the viewer alone has written in used to label itself with the viewer's own
            // handle, which is the state every conversation starts in.
            participantEl.textContent =
              otherParticipantId === null
                ? 'Conversation'
                : `Conversation with ${names.get(otherParticipantId)?.handle ?? shortId(otherParticipantId)}`;
          }
        },
        onLoading: (loading) => {
          if (threadEl) threadEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
      },
    });

    if (composerEl && composerInputEl) {
      composerEl.onsubmit = (e) => {
        e.preventDefault();
        const text = composerInputEl.value.trim();
        if (!text) return;
        // Clear only once the send has landed. Clearing first loses what the user typed whenever
        // the request fails, and the error message alone gives them no way to get it back.
        composerInputEl.disabled = true;
        void messagesCtrl.send(convId, text).then((sent) => {
          composerInputEl.disabled = false;
          if (sent) composerInputEl.value = '';
          composerInputEl.focus();
        });
      };
    }

    const startThread = () => {
      void messagesCtrl.loadThread(convId);
      messagesCtrl.startPolling(convId);
    };

    if (auth.currentSession !== null) {
      startThread();
    } else {
      void restorePromise
        .then(() => startThread())
        .catch(() => undefined);
    }

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: messagesCtrl, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Teams list view (/teams) ---
  const teamsEl = doc.getElementById('teams');
  if (teamsEl && route.name === 'teams') {
    const listEl = doc.getElementById('team-list');
    const errorEl = doc.getElementById('teams-error');
    const formEl = doc.getElementById('team-search-form') as HTMLFormElement | null;
    const inputEl = doc.getElementById('team-search-input') as HTMLInputElement | null;
    let searched = false;

    const teamsCtrl = new TeamsController({
      client: app.api,
      callbacks: {
        onList: (teams) => {
          if (errorEl) errorEl.textContent = '';
          if (listEl) renderTeamList(listEl, teams, searched);
        },
        onTeam: () => {},
        onLoading: (loading) => {
          if (listEl) listEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onNotFound: () => {},
      },
    });

    if (formEl && inputEl) {
      formEl.onsubmit = (e) => {
        e.preventDefault();
        const term = inputEl.value.trim();
        searched = term.length > 0;
        void teamsCtrl.loadList(term || undefined);
      };
    }

    void teamsCtrl.loadList();
    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: teamsCtrl, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Team detail view (/teams/:slug) ---
  const teamEl = doc.getElementById('team');
  if (teamEl && route.name === 'team') {
    const nameEl = doc.getElementById('team-name');
    const descEl = doc.getElementById('team-description');
    const noteEl = doc.getElementById('team-action-note');
    const actionsEl = doc.getElementById('team-actions');
    const membersEl = doc.getElementById('team-members');
    const joinRequestsHeadingEl = doc.getElementById('join-requests-heading');
    const joinRequestsEl = doc.getElementById('join-requests');
    const forumLinkEl = doc.getElementById('team-forum-link');
    const errorEl = doc.getElementById('team-error');
    const slug = route.slug;
    // Read late, never captured: the access token arrives asynchronously, so the viewer's identity
    // is only known once the session restore has settled.
    const viewerId = (): string | null => app.api.session.current?.user.id ?? null;

    const teamsCtrl = new TeamsController({
      client: app.api,
      callbacks: {
        onList: () => {},
        onTeam: (team, members, names, joinRequests) => {
          if (errorEl) errorEl.textContent = '';
          if (nameEl) nameEl.textContent = team.name;
          if (descEl) descEl.textContent = team.description;
          if (membersEl) renderTeamMembers(membersEl, members, names);
          // The forum belongs to THIS team, so its href is only knowable once the team has loaded.
          // The SPA click handler navigates to whatever `href` says, so leaving a placeholder here
          // sends every visitor back to the teams list instead of into the forum.
          if (forumLinkEl instanceof HTMLAnchorElement) {
            forumLinkEl.href = `/teams/${encodeURIComponent(team.slug)}/forum`;
          }

          if (joinRequestsHeadingEl) joinRequestsHeadingEl.hidden = joinRequests === undefined;
          if (joinRequestsEl) joinRequestsEl.hidden = joinRequests === undefined;
          if (joinRequestsEl && joinRequests !== undefined) {
            const queue = createJoinRequestQueue({
              renderQueue: (busy) => {
                renderJoinRequests(joinRequestsEl, joinRequests, names, busy, {
                  onAccept: (req) => void queue.respond(req.id, 'accepted'),
                  onDecline: (req) => void queue.respond(req.id, 'declined'),
                });
              },
              respond: (requestId, status) => teamsCtrl.respondToJoinRequest(team.id, requestId, status, slug),
            });
            queue.render();
          }

          if (!actionsEl || !noteEl) return;
          actionsEl.replaceChildren();
          noteEl.textContent = '';

          const viewer = viewerId();
          const action = teamAction(team, team.viewerRole, viewer);
          if (action.kind === 'none') {
            noteEl.textContent = actionExplanation(action.reason);
            return;
          }

          const button = doc.createElement('button');
          button.type = 'button';
          button.textContent = action.kind === 'join' ? 'Join team' : 'Leave team';
          button.addEventListener('click', () => {
            button.disabled = true;
            const own = membershipOf(members, viewer);
            const done =
              action.kind === 'join'
                ? teamsCtrl.join(team.id, slug)
                : own === null
                  ? Promise.resolve(false)
                  : teamsCtrl.leave(team.id, own.playerId, slug);
            void done.then(() => {
              button.disabled = false;
            });
          });
          actionsEl.appendChild(button);
        },
        onLoading: (loading) => {
          if (membersEl) membersEl.setAttribute('aria-busy', loading ? 'true' : 'false');
          if (joinRequestsEl) joinRequestsEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onNotFound: () => {
          // A private team the viewer cannot see answers 404 exactly as a missing one does
          // (ADR-0069). Saying "not permitted" here would confirm that it exists.
          if (nameEl) nameEl.textContent = 'Team not found';
          if (descEl) descEl.textContent = 'No such team, or it is private.';
          if (membersEl) membersEl.replaceChildren();
          if (actionsEl) actionsEl.replaceChildren();
          if (noteEl) noteEl.textContent = '';
          if (joinRequestsHeadingEl) joinRequestsHeadingEl.hidden = true;
          if (joinRequestsEl) joinRequestsEl.hidden = true;
        },
      },
    });

    // The team routes are public, but WHICH action to offer depends on knowing the viewer, so the
    // load waits for the session the same way the messages routes do.
    const load = (): void => void teamsCtrl.loadTeam(slug);
    if (auth.currentSession !== null) load();
    else void restorePromise.then(() => load()).catch(() => undefined);

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: teamsCtrl, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Forum thread list (/teams/:slug/forum) ---
  const forumEl = doc.getElementById('forum');
  if (forumEl && route.name === 'forum') {
    const titleEl = doc.getElementById('forum-title');
    const listEl = doc.getElementById('thread-list');
    const noteEl = doc.getElementById('forum-note');
    const errorEl = doc.getElementById('forum-error');
    const formEl = doc.getElementById('thread-form') as HTMLFormElement | null;
    const titleInputEl = doc.getElementById('thread-title-input') as HTMLInputElement | null;
    const bodyInputEl = doc.getElementById('thread-body-input') as HTMLInputElement | null;
    const slug = route.slug;
    const viewerId = (): string | null => app.api.session.current?.user.id ?? null;
    let teamId: string | null = null;

    const forumCtrl = new ForumController({
      client: app.api,
      callbacks: {
        onThreads: (team, threads, members, names) => {
          teamId = team.id;
          if (errorEl) errorEl.textContent = '';
          if (titleEl) titleEl.textContent = `${team.name} forum`;
          if (listEl) renderThreadList(listEl, slug, threads, names);

          const ability = canStartThread(members, viewerId());
          if (formEl) formEl.hidden = ability.kind !== 'allowed';
          if (noteEl) {
            noteEl.textContent = ability.kind === 'allowed' ? '' : abilityExplanation(ability.reason);
          }
        },
        onThread: () => {},
        onLoading: (loading) => {
          if (listEl) listEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onNotFound: () => {
          if (titleEl) titleEl.textContent = 'Team not found';
          if (listEl) listEl.replaceChildren();
          if (formEl) formEl.hidden = true;
          if (noteEl) noteEl.textContent = 'No such team, or it is private.';
        },
      },
    });

    if (formEl && titleInputEl && bodyInputEl) {
      formEl.onsubmit = (e) => {
        e.preventDefault();
        const title = titleInputEl.value.trim();
        const body = bodyInputEl.value.trim();
        if (!title || !body || teamId === null) return;
        // Clear only once the thread exists; a failed create otherwise discards what was typed.
        titleInputEl.disabled = true;
        bodyInputEl.disabled = true;
        void forumCtrl.createThread(teamId, slug, title, body).then((created) => {
          titleInputEl.disabled = false;
          bodyInputEl.disabled = false;
          if (created) {
            titleInputEl.value = '';
            bodyInputEl.value = '';
          }
          titleInputEl.focus();
        });
      };
    }

    const load = (): void => void forumCtrl.loadThreads(slug);
    if (auth.currentSession !== null) load();
    else void restorePromise.then(() => load()).catch(() => undefined);

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: forumCtrl, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Forum thread (/teams/:slug/forum/:threadId) ---
  const threadEl = doc.getElementById('thread');
  if (threadEl && route.name === 'thread') {
    const titleEl = doc.getElementById('thread-title');
    const postsEl = doc.getElementById('thread-posts');
    const noteEl = doc.getElementById('thread-note');
    const errorEl = doc.getElementById('thread-error');
    const formEl = doc.getElementById('reply-form') as HTMLFormElement | null;
    const inputEl = doc.getElementById('reply-input') as HTMLInputElement | null;
    const slug = route.slug;
    const threadId = route.threadId;
    const viewerId = (): string | null => app.api.session.current?.user.id ?? null;
    let teamId: string | null = null;

    const forumCtrl = new ForumController({
      client: app.api,
      callbacks: {
        onThreads: () => {},
        onThread: (team, thread, posts, members, names) => {
          teamId = team.id;
          if (errorEl) errorEl.textContent = '';
          if (titleEl) titleEl.textContent = threadDisplayTitle(thread);
          if (postsEl) renderPosts(postsEl, posts, names, viewerId());

          const ability = canReply(thread, members, viewerId());
          if (formEl) formEl.hidden = ability.kind !== 'allowed';
          if (noteEl) {
            noteEl.textContent = ability.kind === 'allowed' ? '' : abilityExplanation(ability.reason);
          }
        },
        onLoading: (loading) => {
          if (postsEl) postsEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onNotFound: () => {
          if (titleEl) titleEl.textContent = 'Thread not found';
          if (postsEl) postsEl.replaceChildren();
          if (formEl) formEl.hidden = true;
          if (noteEl) noteEl.textContent = 'No such thread, or the team is private.';
        },
      },
    });

    if (formEl && inputEl) {
      formEl.onsubmit = (e) => {
        e.preventDefault();
        const body = inputEl.value.trim();
        if (!body || teamId === null) return;
        inputEl.disabled = true;
        void forumCtrl.createPost(teamId, slug, threadId, body).then((sent) => {
          inputEl.disabled = false;
          if (sent) inputEl.value = '';
          inputEl.focus();
        });
      };
    }

    const load = (): void => void forumCtrl.loadThread(slug, threadId);
    if (auth.currentSession !== null) load();
    else void restorePromise.then(() => load()).catch(() => undefined);

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: forumCtrl, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Courses list view (/courses) ---
  const coursesEl = doc.getElementById('courses');
  if (coursesEl && route.name === 'courses') {
    const listEl = doc.getElementById('course-list');
    const errorEl = doc.getElementById('courses-error');

    const learningCtrl = new LearningController({
      client: app.api,
      callbacks: {
        onCourseList: (courses) => {
          if (errorEl) errorEl.textContent = '';
          if (listEl) renderCourseList(listEl, courses);
        },
        onCourse: () => {},
        onLesson: () => {},
        onAttemptResult: () => {},
        onLoading: (loading) => {
          if (listEl) listEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onUnavailable: () => {
          if (coursesEl) {
            coursesEl.replaceChildren();
            const p = doc.createElement('p');
            p.className = 'count';
            p.textContent = 'Learning service unavailable.';
            coursesEl.appendChild(p);
          }
        },
      },
    });

    void learningCtrl.loadCourses();
    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: learningCtrl, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Course detail view (/courses/:slug) ---
  const courseEl = doc.getElementById('course');
  if (courseEl && route.name === 'course') {
    const slug = route.slug;
    const errorEl = doc.getElementById('course-error');

    const learningCtrl = new LearningController({
      client: app.api,
      callbacks: {
        onCourseList: () => {},
        onCourse: (course, lessons, progress) => {
          if (errorEl) errorEl.textContent = '';
          renderCourseDetail(courseEl, course, lessons, progress);
        },
        onLesson: () => {},
        onAttemptResult: () => {},
        onLoading: (loading) => {
          const listEl = doc.getElementById('lesson-list');
          if (listEl) listEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onUnavailable: () => {
          if (courseEl) {
            courseEl.replaceChildren();
            const p = doc.createElement('p');
            p.className = 'count';
            p.textContent = 'Learning service unavailable.';
            courseEl.appendChild(p);
          }
        },
      },
    });

    const load = (): void => void learningCtrl.loadCourse(slug);
    if (auth.currentSession !== null) load();
    else void restorePromise.then(() => load()).catch(() => undefined);

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: learningCtrl, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Lesson detail view (/lessons/:id) ---
  const lessonEl = doc.getElementById('lesson');
  if (lessonEl && route.name === 'lesson') {
    const lessonId = route.id;
    const errorEl = doc.getElementById('lesson-error');
    let currentCourseId = '';

    const learningCtrl = new LearningController({
      client: app.api,
      callbacks: {
        onCourseList: () => {},
        onCourse: () => {},
        onLesson: (lesson, steps, progress, stepAttempts) => {
          currentCourseId = lesson.courseId;
          if (errorEl) errorEl.textContent = '';
          renderLessonDetail(
            lessonEl,
            lesson,
            steps,
            progress,
            stepAttempts,
            async (stepId, input) => {
              await learningCtrl.submitAttempt(stepId, currentCourseId, input);
            },
          );
        },
        onAttemptResult: (stepId, result, courseProgress) => {
          const stepCard = lessonEl.querySelector(`[data-step-id="${stepId}"]`);
          if (stepCard) {
            const statusEl = stepCard.querySelector('.step-status');
            if (statusEl) statusEl.textContent = stepStatusLabel(result);
          }
          const progressEl = doc.getElementById('lesson-progress');
          if (progressEl) progressEl.textContent = courseProgressLabel(courseProgress);
        },
        onLoading: (loading) => {
          const stepListEl = doc.getElementById('step-list');
          if (stepListEl) stepListEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onUnavailable: () => {
          if (lessonEl) {
            lessonEl.replaceChildren();
            const p = doc.createElement('p');
            p.className = 'count';
            p.textContent = 'Learning service unavailable.';
            lessonEl.appendChild(p);
          }
        },
      },
    });

    const load = (): void => void learningCtrl.loadLesson(lessonId);
    if (auth.currentSession !== null) load();
    else void restorePromise.then(() => load()).catch(() => undefined);

    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: learningCtrl, studies: null, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Studies list view (/studies) ---
  const studiesEl = doc.getElementById('studies');
  if (studiesEl && route.name === 'studies') {
    const listEl = doc.getElementById('study-list');
    const errorEl = doc.getElementById('studies-error');
    const searchFormEl = doc.getElementById('study-search-form') as HTMLFormElement | null;

    const studiesCtrl = new StudiesController({
      client: app.api,
      callbacks: {
        onStudyList: (studies) => {
          if (errorEl) errorEl.textContent = '';
          if (listEl) renderStudyList(listEl, studies);
        },
        onStudy: () => {},
        onChapterDetail: () => {},
        onLoading: (loading) => {
          if (listEl) listEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onUnavailable: () => {
          if (studiesEl) {
            studiesEl.replaceChildren();
            const p = doc.createElement('p');
            p.className = 'count';
            p.textContent = 'Studies service unavailable.';
            studiesEl.appendChild(p);
          }
        },
      },
    });

    if (searchFormEl) {
      // Assignment, not addEventListener: `#study-search-form` lives in index.html and outlives the
      // route, so a listener added per bootstrap would stack one more copy — each holding a disposed
      // controller — on every visit. `onsubmit` replaces. Same as the teams and forum forms.
      searchFormEl.onsubmit = (e): void => {
        e.preventDefault();
        const input = doc.getElementById('study-search-input') as HTMLInputElement | null;
        const q = input?.value.trim() ?? '';
        void studiesCtrl.loadStudies(q);
      };
    }

    void studiesCtrl.loadStudies();
    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: studiesCtrl, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Study detail view (/studies/:id) ---
  const studyEl = doc.getElementById('study');
  if (studyEl && route.name === 'study') {
    const studyId = route.id;
    const errorEl = doc.getElementById('study-error');

    const studiesCtrl = new StudiesController({
      client: app.api,
      callbacks: {
        onStudyList: () => {},
        onStudy: (study, chapters, collaborators, exportUrl) => {
          if (errorEl) errorEl.textContent = '';
          renderStudyDetail(
            {
              nameEl: doc.getElementById('study-name'),
              descEl: doc.getElementById('study-description'),
              visEl: doc.getElementById('study-visibility'),
              exportEl: doc.getElementById('study-export-link') as HTMLAnchorElement | null,
              chaptersEl: doc.getElementById('study-chapters'),
              collabsEl: doc.getElementById('study-collaborators'),
            },
            study,
            chapters,
            collaborators,
            exportUrl,
          );
        },
        onChapterDetail: () => {},
        onLoading: (loading) => {
          const chaptersEl = doc.getElementById('study-chapters');
          if (chaptersEl) chaptersEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onUnavailable: () => {
          if (studyEl) {
            studyEl.replaceChildren();
            const p = doc.createElement('p');
            p.className = 'count';
            p.textContent = 'Studies service unavailable.';
            studyEl.appendChild(p);
          }
        },
      },
    });

    void studiesCtrl.loadStudy(studyId);
    return { app, board: null, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: studiesCtrl, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Study chapter detail view (/studies/:id/chapters/:chapterId) ---
  const studyChapterEl = doc.getElementById('study-chapter');
  if (studyChapterEl && route.name === 'study-chapter') {
    const { id: studyId, chapterId } = route;
    const errorEl = doc.getElementById('study-chapter-error');
    const boardEl = doc.getElementById('chapter-board');

    const chapterBoard = boardEl ? mountBoard({ boardEl }) : null;
    if (chapterBoard) {
      chapterBoard.setTurn(false);
    }

    const studiesCtrl = new StudiesController({
      client: app.api,
      callbacks: {
        onStudyList: () => {},
        onStudy: () => {},
        onChapterDetail: (study, chapter, tree, chapters, exportUrl) => {
          if (errorEl) errorEl.textContent = '';
          chapterBoard?.setPosition(chapter.startingFen);
          renderChapterDetail(
            {
              studyLinkEl: doc.getElementById('chapter-study-link') as HTMLAnchorElement | null,
              chapterNameEl: doc.getElementById('chapter-name'),
              exportEl: doc.getElementById('chapter-export-link') as HTMLAnchorElement | null,
              treeEl: doc.getElementById('chapter-tree'),
              navEl: doc.getElementById('chapter-list-nav'),
            },
            study,
            chapter,
            tree,
            chapters,
            exportUrl,
            (fenAfter) => {
              chapterBoard?.setPosition(fenAfter);
            },
          );
        },
        onLoading: (loading) => {
          const treeEl = doc.getElementById('chapter-tree');
          if (treeEl) treeEl.setAttribute('aria-busy', loading ? 'true' : 'false');
        },
        onError: (msg) => {
          if (errorEl) errorEl.textContent = msg;
        },
        onUnavailable: () => {
          if (studyChapterEl) {
            studyChapterEl.replaceChildren();
            const p = doc.createElement('p');
            p.className = 'count';
            p.textContent = 'Studies service unavailable.';
            studyChapterEl.appendChild(p);
          }
        },
      },
    });

    void studiesCtrl.loadChapter(studyId, chapterId);
    return { app, board: chapterBoard, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: studiesCtrl, passkeys: null, connectivity: null, auth, theme };
  }

  // --- Standalone board (no game ID, no lobby, no profile, no tournament, no search, no messages) ---
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return { app, board, controller: null, lobby: null, profile: null, leaderboard: null, tournament: null, search: null, messages: null, teams: null, forum: null, learning: null, studies: null, passkeys: null, connectivity: null, auth, theme };
}
