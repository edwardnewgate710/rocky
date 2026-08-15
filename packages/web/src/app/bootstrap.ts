/**
 * DOM entry for the composition root: build the application graph, mount the
 * interactive board, and return the wired handles. It is invoked from
 * `main.ts` and delegates bounded DOM concerns such as route visibility to
 * focused app-layer modules. Keeping DOM composition separate from
 * {@link createApp} lets the object graph be composed and tested with no DOM
 * present.
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
import type { GameController as GameControllerType } from './game-controller.js';
import { mountGame } from './game-mount.js';
import type { LobbyController as LobbyControllerType } from './lobby-controller.js';
import { mountLobby } from './lobby-mount.js';
import type { ProfileController as ProfileControllerType } from './profile-controller.js';
import { mountProfile } from './profile-mount.js';
import type { TournamentController as TournamentControllerType } from './tournament-controller.js';
import {
  mountLeaderboard,
  mountTournamentDetail,
  mountTournamentList,
} from './competition-mounts.js';
import {
  renderEmpty,
  formatClock,
  formatTimeControl,
} from './render-helpers.js';
import type { EmptyStateOptions } from './render-helpers.js';
import type { SearchController as SearchControllerType } from './search-controller.js';
import { mountSearch } from './search-mount.js';
import type { LearningController as LearningControllerType } from './learning-controller.js';
import { mountCourseDetail, mountCourseList, mountLesson } from './learning-mounts.js';
import type { StudiesController as StudiesControllerType } from './studies-controller.js';
import { mountStudiesList, mountStudyChapter, mountStudyDetail } from './studies-mounts.js';
import { mountConversation, mountMessagesInbox } from './messaging-mounts.js';
import { mountTeamDetail, mountTeamList } from './team-mounts.js';
import { mountForum, mountForumThread } from './forum-mounts.js';
import type { ForumController as ForumControllerType } from './forum-controller.js';
import type { TeamsController as TeamsControllerType } from './teams-controller.js';
import type { MessagesController as MessagesControllerType } from './messages-controller.js';
import { ThemeToggle } from './theme-toggle.js';
import type { ThemeToggle as ThemeToggleType } from './theme-toggle.js';
import { AuthController } from './auth-controller.js';
import type { AuthController as AuthControllerType } from './auth-controller.js';
import type { AuthSession } from './auth-controller.js';
import { mountPasswordRecovery } from './password-recovery-mount.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';
import { parseRoute } from './router.js';
import { applyRouteSurface } from './route-surface.js';

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
  readonly passwordReset: { dispose: () => void } | null;
  readonly connectivity: { dispose: () => void } | null;
}

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped extends BootstrappedDisposables {
  readonly auth: AuthControllerType;
  readonly theme: ThemeToggleType;
}

/** Key of disposables returned by bootstrap. Driven by BootstrappedDisposables for structural teardown exhaustiveness. */
export type DisposableKey = keyof BootstrappedDisposables;

type ActiveBootstrappedDisposables = Partial<Omit<BootstrappedDisposables, 'app'>>;

function createBootstrapped(
  app: App,
  auth: AuthControllerType,
  theme: ThemeToggleType,
  activeDisposables: ActiveBootstrappedDisposables,
): Bootstrapped {
  return {
    app,
    controller: null,
    board: null,
    lobby: null,
    profile: null,
    leaderboard: null,
    tournament: null,
    search: null,
    messages: null,
    teams: null,
    forum: null,
    learning: null,
    studies: null,
    passkeys: null,
    passwordReset: null,
    connectivity: null,
    auth,
    theme,
    ...activeDisposables,
  };
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
  /** Override native WebAuthn ceremonies for tests or alternate browser hosts. */
  readonly webauthnAdapter?: WebAuthnAdapter;
}



/**
 * Compose the app and mount views against the given document. The route is
 * determined from the URL pathname (or `deps.gameId` override).
 */
export function bootstrap(
  doc: Document,
  deps?: BootstrapDependencies,
): Bootstrapped {
  // Extract and immediately strip secret reset token from location bar BEFORE any network call or app composition
  let activeResetToken: string | null = null;
  const rawUrl = typeof location !== 'undefined' ? location.pathname + (location.search ?? '') : '/';
  const route = parseRoute(rawUrl);
  if (route.name === 'password-reset' && typeof location !== 'undefined' && location.search) {
    const searchParams = new URLSearchParams(location.search);
    const t = searchParams.get('token');
    if (t) {
      activeResetToken = t;
      if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
        history.replaceState(null, '', '/password-reset');
      }
    }
  }

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
  let setPlayBotAuthenticated: ((authenticated: boolean) => void) | null = null;
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
        if (authSectionEl) authSectionEl.hidden = session !== null || showPasswordReset;
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
        setPlayBotAuthenticated?.(session !== null);
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

  // Restore any persisted session. Kept as a promise so the authenticated game
  // socket below can wait for the access token, which M12 inc 2 obtains
  // asynchronously via the httpOnly refresh cookie rather than from storage.
  const restorePromise = auth.restore();

  // --- Determine route & game params ---
  const gameId = deps?.gameId ?? (route.name === 'game' ? route.gameId : null);
  const token = deps?.token ?? app.api.session.current?.tokens.accessToken;
  const showPasswordReset = route.name === 'password-reset';

  // Set initial auth section visibility from already-known route and auth state
  if (authSectionEl) authSectionEl.hidden = auth.currentSession !== null || showPasswordReset;
  if (authLogoutEl) authLogoutEl.hidden = auth.currentSession === null;

  applyRouteSurface(doc, route);

  // --- Game view ---
  const boardEl = doc.getElementById('board');
  if (boardEl && gameId) {
    const mountedGame = mountGame({
      doc,
      boardEl,
      gameId,
      createGameSync: app.createGameSync,
      createGameOracle: app.createGameOracle,
      getAccessToken: () => app.api.session.current?.tokens.accessToken,
      ...(token !== undefined ? { token } : {}),
      restorePromise,
    });
    return createBootstrapped(app, auth, theme, mountedGame);
  }

  // --- Lobby view ---
  const lobbyEl = doc.getElementById('lobby');
  if (lobbyEl && route.name === 'lobby') {
    const mountedLobby = mountLobby({
      doc,
      client: app.api,
      isAuthenticated: () => auth.isAuthenticated(),
      ...(deps?.storage !== undefined ? { storage: deps.storage } : {}),
    });
    setPlayBotAuthenticated = mountedLobby.setPlayBotAuthenticated;

    return createBootstrapped(app, auth, theme, { lobby: mountedLobby.lobby });
  }

  // --- Profile view ---
  const profileEl = doc.getElementById('profile');
  if (profileEl && route.name === 'profile') {
    const mountedProfile = mountProfile({
      doc,
      client: app.api,
      handle: route.handle ?? null,
      getCurrentSession: () => auth.currentSession,
      restorePromise,
      ...(deps?.webauthnAdapter !== undefined ? { webauthnAdapter: deps.webauthnAdapter } : {}),
    });
    selfProfileSessionHandler = mountedProfile.onSessionChange;

    return createBootstrapped(app, auth, theme, {
      profile: mountedProfile.profile,
      passkeys: mountedProfile.passkeys,
    });
  }

  // --- Leaderboard view ---
  const leaderboardEl = doc.getElementById('leaderboard');
  if (leaderboardEl && route.name === 'leaderboard') {
    return createBootstrapped(app, auth, theme, {
      leaderboard: mountLeaderboard(doc, app.api),
    });
  }

  // --- Tournaments list view ---
  const tournamentsEl = doc.getElementById('tournaments');
  if (tournamentsEl && route.name === 'tournaments') {
    return createBootstrapped(app, auth, theme, {
      tournament: mountTournamentList(doc, app.api),
    });
  }

  // --- Single tournament detail view ---
  const tournamentEl = doc.getElementById('tournament');
  if (tournamentEl && route.name === 'tournament') {
    return createBootstrapped(app, auth, theme, {
      tournament: mountTournamentDetail(doc, app.api, route.id),
    });
  }

  // --- Search view ---
  const searchEl = doc.getElementById('search');
  if (searchEl && route.name === 'search') {
    return createBootstrapped(app, auth, theme, { search: mountSearch(doc, app.api) });
  }

  // --- Messages Inbox view (/messages) ---
  const messagesEl = doc.getElementById('messages');
  if (messagesEl && route.name === 'messages') {
    return createBootstrapped(app, auth, theme, {
      messages: mountMessagesInbox({
        doc,
        client: app.api,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Conversation Thread view (/messages/:id) ---
  const conversationEl = doc.getElementById('conversation');
  if (conversationEl && route.name === 'conversation') {
    return createBootstrapped(app, auth, theme, {
      messages: mountConversation({
        doc,
        client: app.api,
        conversationId: route.id,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Teams list view (/teams) ---
  const teamsEl = doc.getElementById('teams');
  if (teamsEl && route.name === 'teams') {
    return createBootstrapped(app, auth, theme, { teams: mountTeamList(doc, app.api) });
  }

  // --- Team detail view (/teams/:slug) ---
  const teamEl = doc.getElementById('team');
  if (teamEl && route.name === 'team') {
    return createBootstrapped(app, auth, theme, {
      teams: mountTeamDetail({
        doc,
        client: app.api,
        slug: route.slug,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Forum thread list (/teams/:slug/forum) ---
  const forumEl = doc.getElementById('forum');
  if (forumEl && route.name === 'forum') {
    return createBootstrapped(app, auth, theme, {
      forum: mountForum({
        doc,
        client: app.api,
        slug: route.slug,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Forum thread (/teams/:slug/forum/:threadId) ---
  const threadEl = doc.getElementById('thread');
  if (threadEl && route.name === 'thread') {
    return createBootstrapped(app, auth, theme, {
      forum: mountForumThread({
        doc,
        client: app.api,
        slug: route.slug,
        threadId: route.threadId,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Courses list view (/courses) ---
  const coursesEl = doc.getElementById('courses');
  if (coursesEl && route.name === 'courses') {
    return createBootstrapped(app, auth, theme, {
      learning: mountCourseList({ doc, client: app.api, surface: coursesEl }),
    });
  }

  // --- Course detail view (/courses/:slug) ---
  const courseEl = doc.getElementById('course');
  if (courseEl && route.name === 'course') {
    return createBootstrapped(app, auth, theme, {
      learning: mountCourseDetail({
        doc,
        client: app.api,
        surface: courseEl,
        slug: route.slug,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Lesson detail view (/lessons/:id) ---
  const lessonEl = doc.getElementById('lesson');
  if (lessonEl && route.name === 'lesson') {
    return createBootstrapped(app, auth, theme, {
      learning: mountLesson({
        doc,
        client: app.api,
        surface: lessonEl,
        lessonId: route.id,
        sessionPresent: auth.currentSession !== null,
        restorePromise,
      }),
    });
  }

  // --- Studies list view (/studies) ---
  const studiesEl = doc.getElementById('studies');
  if (studiesEl && route.name === 'studies') {
    return createBootstrapped(app, auth, theme, {
      studies: mountStudiesList({ doc, client: app.api, surface: studiesEl }),
    });
  }

  // --- Study detail view (/studies/:id) ---
  const studyEl = doc.getElementById('study');
  if (studyEl && route.name === 'study') {
    return createBootstrapped(app, auth, theme, {
      studies: mountStudyDetail({
        doc,
        client: app.api,
        surface: studyEl,
        studyId: route.id,
      }),
    });
  }

  // --- Study chapter detail view (/studies/:id/chapters/:chapterId) ---
  const studyChapterEl = doc.getElementById('study-chapter');
  if (studyChapterEl && route.name === 'study-chapter') {
    const mountedChapter = mountStudyChapter({
      doc,
      client: app.api,
      surface: studyChapterEl,
      studyId: route.id,
      chapterId: route.chapterId,
    });
    return createBootstrapped(app, auth, theme, mountedChapter);
  }

  // --- Password reset view ---
  if (showPasswordReset) {
    return createBootstrapped(app, auth, theme, {
      passwordReset: mountPasswordRecovery({
        doc,
        client: app.api,
        resetToken: activeResetToken,
        onSessionInvalidated: () => auth.clearLocalSession(),
      }),
    });
  }

  // --- Standalone board (no game ID, no lobby, no profile, no tournament, no search, no messages) ---
  const statusEl = doc.getElementById('status');
  const flipEl = doc.getElementById('flip');
  const board = boardEl
    ? mountBoard({ boardEl, statusEl, flipEl })
    : null;

  return createBootstrapped(app, auth, theme, { board });
}
