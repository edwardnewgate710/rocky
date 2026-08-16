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

export interface SessionManagerOptions {
  readonly refresh: RefreshFn;
  readonly store?: TokenStore;
  readonly now?: () => number;
  /** Treat the access token as expired this many ms before its real expiry. Default 30000. */
  readonly expiryLeewayMs?: number;
}

export class SessionManager {
  private readonly store: TokenStore;
  private readonly doRefresh: RefreshFn;
  private readonly now: () => number;
  private readonly leewayMs: number;
  private invalidatedHandler: (() => void) | null = null;
  private refreshInFlight: Promise<StoredSession> | null = null;

  constructor(options: SessionManagerOptions) {
    this.store = options.store ?? new MemoryTokenStore();
    this.doRefresh = options.refresh;
    this.now = options.now ?? ((): number => Date.now());
    this.leewayMs = options.expiryLeewayMs ?? 30_000;
  }

  get current(): StoredSession | null {
    return this.store.load();
  }

  get isAuthenticated(): boolean {
    return this.store.load() !== null;
  }

  /** Persist tokens+user from an auth response, computing access-token expiry. */
  adopt(auth: AuthResponse): StoredSession {
    const session: StoredSession = {
      user: auth.user,
      tokens: auth.tokens,
      accessTokenExpiresAt: this.now() + auth.tokens.expiresIn * 1000,
    };
    this.store.save(session);
    return session;
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

  /** Forget the local session (does not call the server). */
  reset(): void {
    this.store.clear();
    this.refreshInFlight = null;
  }

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

    const pending = (async (): Promise<StoredSession> => {
      try {
        // Pass the refresh token if available (non-browser path).
        // For the browser flow, the token is undefined and the cookie is sent.
        const auth = await this.doRefresh(session.tokens.refreshToken);
        return this.adopt(auth);
      } catch (error) {
        // The session is gone and the user did not ask for that, so tell whoever is showing them as
        // signed in. Clearing only this store would leave the header and account controls claiming a
        // session that no request can use.
        this.reset();
        this.invalidatedHandler?.();
        throw error;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    this.refreshInFlight = pending;
    return pending;
  }
}
