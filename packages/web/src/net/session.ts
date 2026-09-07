/**
 * Session / authentication abstraction.
 *
 * The M4 contract issues a short-lived access token plus an opaque, single-use
 * refresh token. This module owns that lifecycle on the client:
 *
 *  - a pluggable {@link TokenStore} (in-memory by default) so *where* tokens live
 *    is a choice, not a hard dependency;
 *  - a {@link SessionManager} that adopts auth responses, tracks access-token
 *    expiry, hands out `Authorization` headers, and refreshes proactively (before
 *    expiry) with a **single-flight** guard so concurrent requests trigger at
 *    most one refresh.
 *
 * Refresh is injected as a plain function, not the whole API client, to avoid a
 * dependency cycle and keep the manager unit-testable in isolation.
 *
 * M12 inc 2: Neither the refresh token NOR the access token is persisted to
 * storage. Both live in memory only. The browser flow relies on an httpOnly
 * cookie (set by the API on login/refresh) that is sent automatically with
 * `credentials: 'include'`. On reload, `AuthController.restore()` calls
 * `client.auth.refresh()` which uses the cookie to obtain a fresh access token
 * and populate the in-memory `SessionManager`.
 */
import type { AuthResponse, SelfUser, TokenPair } from '../api/models.js';

/** A refresh call: exchange a refresh token for a fresh auth response. */
export type RefreshFn = (refreshToken?: string) => Promise<AuthResponse>;

/**
 * Full in-memory session (includes the refresh token for the refresh call).
 * The refresh token is never persisted to storage — only kept in memory.
 */
export interface StoredSession {
  readonly user: SelfUser;
  readonly tokens: TokenPair;
  /** Epoch-ms when the access token expires (derived from `tokens.expiresIn`). */
  readonly accessTokenExpiresAt: number;
}

export interface TokenStore {
  load(): StoredSession | null;
  save(session: StoredSession): void;
  clear(): void;
}

/** Default store: keeps the session in memory only (cleared on reload). */
export class MemoryTokenStore implements TokenStore {
  private session: StoredSession | null = null;
  load(): StoredSession | null {
    return this.session;
  }
  save(session: StoredSession): void {
    this.session = session;
  }
  clear(): void {
    this.session = null;
  }
}

/** The subset of the Web Storage API we depend on (localStorage/sessionStorage). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Raised when an operation needs a session but none is present. */
export class NoSessionError extends Error {
  constructor(message = 'no active session') {
    super(message);
    this.name = 'NoSessionError';
  }
}

/**
 * Cross-tab messaging channel abstraction for multi-tab session synchronization.
 * Uses BroadcastChannel when available in browser environments.
 */
export interface SessionChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

/**
 * Reason or trigger for a session reset across tabs.
 *
 * - `logout`: Voluntary explicit user sign-out (e.g. user clicked log out or reset local session).
 *   All peer tabs must immediately clear their session unconditionally.
 * - `invalidation`: Involuntary failed token refresh (e.g. concurrent race loser or network failure).
 *   Peer tabs that hold an active, valid successor session must NOT be cleared by a loser tab.
 */
export type SessionResetCause = 'logout' | 'invalidation';

/**
 * Options configuring local and cross-tab session reset semantics.
 */
export interface SessionResetOptions {
  /** Whether to broadcast the reset over the cross-tab channel. Default true. */
  readonly broadcast?: boolean;
  /** Cause of the reset. Defaults to 'logout' (voluntary explicit sign-out). */
  readonly cause?: SessionResetCause;
  /** Access token of the session that was reset, if known. Used by peers for freshness checks. */
  readonly token?: string;
}

/**
 * Type-guard that narrows `val` to {@link AuthResponse}.
 *
 * Performs a structural duck-type check rather than a branded type check so
 * it works across serialization boundaries (e.g. postMessage payloads from
 * peer tabs where the prototype chain is lost).
 */
function isAuthResponse(val: unknown): val is AuthResponse {
  if (!val || typeof val !== 'object') return false;
  const cand = val as Record<string, unknown>;
  return (
    typeof cand['user'] === 'object' &&
    cand['user'] !== null &&
    typeof cand['tokens'] === 'object' &&
    cand['tokens'] !== null
  );
}

/**
 * Returns `true` when running in a real browser (not Node.js or Deno).
 *
 * Used to gate the automatic `BroadcastChannel` creation so that the
 * `SessionManager` can be imported in server-side / test environments without
 * throwing on `window` or `BroadcastChannel` access.
 */
function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    (typeof process === 'undefined' || typeof process.versions !== 'object' || !process.versions?.node)
  );
}

/** Construction-time options for {@link SessionManager}. */
export interface SessionManagerOptions {
  readonly refresh: RefreshFn;
  readonly store?: TokenStore;
  readonly now?: () => number;
  /** Treat the access token as expired this many ms before its real expiry. Default 30000. */
  readonly expiryLeewayMs?: number;
  /** Cross-tab session sync channel. Pass null to disable or custom channel for tests. */
  readonly channel?: SessionChannel | null;
}

/**
 * Manages authentication token storage, proactive refresh, and cross-tab session synchronization.
 *
 * The manager maintains a single in-flight refresh promise so concurrent callers coalesce onto
 * one request. A monotonic `sessionGeneration` counter ensures that stale refresh responses from
 * a prior session never overwrite a freshly adopted or cleared session.
 *
 * Cross-tab synchronization is done through a BroadcastChannel: adoption events broadcast the
 * new session to peer tabs, and reset events (logout/invalidation) propagate the cleared state.
 * The `adoptedHandler` is only invoked for genuine cross-tab messages — never for local API calls
 * — via the private {@link adoptFromChannel} method, preventing double-adoption.
 */
export class SessionManager {
  private readonly store: TokenStore;
  private readonly doRefresh: RefreshFn;
  private readonly now: () => number;
  private readonly leewayMs: number;
  private invalidatedHandler: (() => void) | null = null;
  private adoptedHandler: ((session: StoredSession) => void) | null = null;
  private resetHandler: (() => void) | null = null;
  private refreshInFlight: Promise<StoredSession> | null = null;
  /**
   * Monotonically increasing generation counter tracking local session lifecycle changes
   * (resets, adoptions, and disposals). In-flight refreshes capture the generation at initiation
   * and check it upon completion to ensure stale responses from an older session do not resurrect
   * or poison newly adopted or cleared sessions.
   */
  private sessionGeneration = 0;
  private channel: SessionChannel | null = null;

  /** Initialize the session manager; opens the BroadcastChannel if running in a browser context. */
  constructor(options: SessionManagerOptions) {
    this.store = options.store ?? new MemoryTokenStore();
    this.doRefresh = options.refresh;
    this.now = options.now ?? ((): number => Date.now());
    this.leewayMs = options.expiryLeewayMs ?? 30_000;

    if (options.channel !== undefined) {
      this.channel = options.channel;
    } else if (isBrowserEnvironment() && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('gambit-session-sync');
      } catch {
        this.channel = null;
      }
    }

    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent): void => {
        this.handleChannelMessage(event.data);
      };
    }
  }

  /**
   * Handle incoming cross-tab channel events.
   *
   * Enforces ordering and freshness invariants:
   * - `session_adopted`: Adopts fresh auth tokens received from a peer tab without re-broadcasting.
   * - `session_reset`:
   *   - If cause is 'invalidation' (involuntary failed refresh from a peer), verifies whether this
   *     manager already holds an active, non-expired successor session. A legitimate concurrent
   *     refresh loser must never invalidate the winner's valid session.
   *   - If cause is 'logout' (or unspecified legacy), unconditionally clears the session.
   */
  private handleChannelMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;
    if (msg['type'] === 'session_adopted' && isAuthResponse(msg['auth'])) {
      this.adoptFromChannel(msg['auth']);
    } else if (msg['type'] === 'session_reset') {
      const cause = typeof msg['cause'] === 'string' ? msg['cause'] : 'logout';
      if (cause === 'invalidation') {
        const current = this.store.load();
        const resetToken = typeof msg['token'] === 'string' ? msg['token'] : undefined;
        // If this manager holds an active, non-expired session that has already rotated
        // beyond the failed token (or is a valid successor), do NOT clear it.
        if (current && !this.isAccessTokenExpired(current)) {
          if (!resetToken || current.tokens.accessToken !== resetToken) {
            return;
          }
        }
      }
      this.reset(false);
      this.resetHandler?.();
    }
  }

  /**
   * Current session snapshot stored in memory, or null when unauthenticated.
   */
  get current(): StoredSession | null {
    return this.store.load();
  }

  /**
   * True if there is currently an active stored session.
   */
  get isAuthenticated(): boolean {
    return this.store.load() !== null;
  }

  /**
   * Persist tokens+user from an auth response, computing access-token expiry.
   *
   * Increments `sessionGeneration` and clears `refreshInFlight` so that any stale in-flight
   * refresh started before this adoption cannot overwrite the freshly adopted session.
   * Optionally broadcasts a `session_adopted` message to notify peer tabs.
   */
  adopt(auth: AuthResponse, broadcast = true): StoredSession {
    this.sessionGeneration++;
    this.refreshInFlight = null;
    const session: StoredSession = {
      user: auth.user,
      tokens: auth.tokens,
      accessTokenExpiresAt: this.now() + auth.tokens.expiresIn * 1000,
    };
    this.store.save(session);
    if (broadcast && this.channel) {
      try {
        this.channel.postMessage({ type: 'session_adopted', auth });
      } catch {
        // Channel closed or in error state.
      }
    }
    return session;
  }

  /**
   * Adopt a session received from a peer tab via cross-tab channel broadcast.
   *
   * Unlike the general-purpose {@link adopt} (used for local API calls), this
   * method additionally fires `adoptedHandler` to synchronize controller
   * identity. It never re-broadcasts, because the message already originated
   * from a peer tab — re-broadcasting would create a loop across all open tabs.
   *
   * This separation ensures that `adoptedHandler` is ONLY invoked for genuine
   * cross-tab adoption events, never for local login, register, or refresh
   * calls where the controller already drives the session update directly.
   */
  private adoptFromChannel(auth: AuthResponse): void {
    const session = this.adopt(auth, false);
    this.adoptedHandler?.(session);
  }

  /**
   * Register the handler invoked when a session is adopted from a peer tab via
   * cross-tab channel broadcast. It is NOT called for local login, register, or
   * refresh calls — those are handled directly by the controller.
   */
  onAdopted(handler: (session: StoredSession) => void): void {
    this.adoptedHandler = handler;
  }

  /**
   * Register the handler for when a session is reset from a peer tab via channel broadcast.
   */
  onReset(handler: () => void): void {
    this.resetHandler = handler;
  }

  /**
   * Register the handler for an *involuntary* session loss: a refresh that failed because the
   * refresh token expired or the session was revoked from another device. A deliberate sign-out
   * does not call it, because the caller already knows.
   *
   * Late registration rather than a constructor option because the party that needs to know is the
   * {@link AuthController}, which is built from this client and so cannot exist before it.
   */
  onInvalidated(handler: () => void): void {
    this.invalidatedHandler = handler;
  }

  /**
   * Forget the local session (does not call the server).
   *
   * Bumps `sessionGeneration` to invalidate in-flight refresh requests, clears local store,
   * and optionally broadcasts a `session_reset` message tagged with cause and token for cross-tab sync.
   *
   * @param options - Structured {@link SessionResetOptions} or a boolean broadcast flag for backwards compatibility.
   */
  reset(options: boolean | SessionResetOptions = true): void {
    const broadcast = typeof options === 'boolean' ? options : (options.broadcast ?? true);
    const cause: SessionResetCause = typeof options === 'object' && options.cause ? options.cause : 'logout';
    const currentToken = this.store.load()?.tokens.accessToken;
    const token = typeof options === 'object' && options.token !== undefined ? options.token : currentToken;

    this.sessionGeneration++;
    this.store.clear();
    this.refreshInFlight = null;
    if (broadcast && this.channel) {
      try {
        this.channel.postMessage({
          type: 'session_reset',
          cause,
          token,
          generation: this.sessionGeneration,
        });
      } catch {
        // Channel closed or in error state.
      }
    }
  }

  /**
   * Permanently close the cross-tab channel and invalidate any in-flight refresh requests.
   * Increments `sessionGeneration` so pending asynchronous responses cannot mutate state after disposal.
   */
  dispose(): void {
    this.sessionGeneration++;
    this.refreshInFlight = null;
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  /**
   * Whether the stored session's access token is expired or within the leeway window.
   *
   * @param session - The stored session to evaluate (defaults to loading current store).
   * @returns True if expired or near expiry (within `expiryLeewayMs`), or if no session exists.
   */
  isAccessTokenExpired(session: StoredSession | null = this.store.load()): boolean {
    if (!session) return true;
    return this.now() >= session.accessTokenExpiresAt - this.leewayMs;
  }

  /** `Authorization` header value for the current access token, or undefined. */
  authorizationHeader(): string | undefined {
    const session = this.store.load();
    return session ? `Bearer ${session.tokens.accessToken}` : undefined;
  }

  /**
   * Return a non-expired access token, refreshing proactively when the current
   * one is (near) expiry. Resolves to undefined when there is no session at all.
   */
  async validAccessToken(): Promise<string | undefined> {
    const session = this.store.load();
    if (!session) return undefined;
    if (!this.isAccessTokenExpired(session)) return session.tokens.accessToken;
    const refreshed = await this.refreshNow();
    return refreshed.tokens.accessToken;
  }

  /**
   * Refresh the session now, coalescing concurrent callers onto one in-flight
   * refresh. On failure the local session is cleared and the error rethrown.
   *
   * Concurrent state transitions:
   * - If the manager adopts a newer session while the refresh is in flight, the
   *   in-flight refresh result is discarded to prevent stale overwrite.
   * - A failed refresh checks if a valid successor was adopted concurrently. If so,
   *   the session is preserved instead of being cleared.
   *
   * M12 inc 2: The refresh token is passed from the in-memory session if
   * available, but the browser flow relies on the httpOnly cookie (the
   * `RefreshFn` sends `credentials: 'include'` so the cookie is attached
   * automatically). The body token is omitted for the browser flow.
   */
  async refreshNow(): Promise<StoredSession> {
    const existing = this.refreshInFlight;
    if (existing) return existing;

    const session = this.store.load();
    if (!session) throw new NoSessionError('cannot refresh without a session');

    const opGen = this.sessionGeneration;

    const pending = (async (): Promise<StoredSession> => {
      try {
        // Pass the refresh token if available (non-browser path).
        // For the browser flow, the token is undefined and the cookie is sent.
        const auth = await this.doRefresh(session.tokens.refreshToken);
        if (this.sessionGeneration !== opGen) {
          throw new NoSessionError('session was reset while refresh was in flight');
        }
        return this.adopt(auth);
      } catch (error) {
        if (!(error instanceof NoSessionError)) {
          // If a concurrent tab refreshed and updated our store with a fresh successor token,
          // adopt that valid session rather than destroying it.
          const current = this.store.load();
          if (
            current &&
            current.tokens.accessToken !== session.tokens.accessToken &&
            !this.isAccessTokenExpired(current)
          ) {
            return current;
          }
        }
        if (this.sessionGeneration !== opGen) {
          if (error instanceof NoSessionError) {
            throw error;
          }
          throw new NoSessionError('session was reset while refresh was in flight');
        }
        this.reset({ broadcast: true, cause: 'invalidation', token: session.tokens.accessToken });
        this.invalidatedHandler?.();
        throw error;
      }
    })();

    this.refreshInFlight = pending;
    pending
      .finally(() => {
        if (this.refreshInFlight === pending) {
          this.refreshInFlight = null;
        }
      })
      .catch(() => {});

    return pending;
  }
}
