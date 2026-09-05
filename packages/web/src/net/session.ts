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

export interface SessionChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

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

function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    (typeof process === 'undefined' || typeof process.versions !== 'object' || !process.versions?.node)
  );
}

export interface SessionManagerOptions {
  readonly refresh: RefreshFn;
  readonly store?: TokenStore;
  readonly now?: () => number;
  /** Treat the access token as expired this many ms before its real expiry. Default 30000. */
  readonly expiryLeewayMs?: number;
  /** Cross-tab session sync channel. Pass null to disable or custom channel for tests. */
  readonly channel?: SessionChannel | null;
}

export class SessionManager {
  private readonly store: TokenStore;
  private readonly doRefresh: RefreshFn;
  private readonly now: () => number;
  private readonly leewayMs: number;
  private invalidatedHandler: (() => void) | null = null;
  private adoptedHandler: ((session: StoredSession) => void) | null = null;
  private resetHandler: (() => void) | null = null;
  private refreshInFlight: Promise<StoredSession> | null = null;
  private sessionGeneration = 0;
  private channel: SessionChannel | null = null;

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

  private handleChannelMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;
    if (msg['type'] === 'session_adopted' && isAuthResponse(msg['auth'])) {
      this.adopt(msg['auth'], false);
    } else if (msg['type'] === 'session_reset') {
      this.reset(false);
      this.resetHandler?.();
    }
  }

  get current(): StoredSession | null {
    return this.store.load();
  }

  get isAuthenticated(): boolean {
    return this.store.load() !== null;
  }

  /** Persist tokens+user from an auth response, computing access-token expiry. */
  adopt(auth: AuthResponse, broadcast = true): StoredSession {
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
    this.adoptedHandler?.(session);
    return session;
  }

  /**
   * Register the handler for when a session is adopted (including via peer tab broadcast).
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

  /** Forget the local session (does not call the server). */
  reset(broadcast = true): void {
    this.sessionGeneration++;
    this.store.clear();
    this.refreshInFlight = null;
    if (broadcast && this.channel) {
      try {
        this.channel.postMessage({ type: 'session_reset' });
      } catch {
        // Channel closed or in error state.
      }
    }
  }

  /** Permanently close the cross-tab channel. */
  dispose(): void {
    this.sessionGeneration++;
    this.refreshInFlight = null;
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
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

    const opGen = this.sessionGeneration;

    let pending: Promise<StoredSession> | null = null;
    pending = (async (): Promise<StoredSession> => {
      try {
        // Pass the refresh token if available (non-browser path).
        // For the browser flow, the token is undefined and the cookie is sent.
        const auth = await this.doRefresh(session.tokens.refreshToken);
        if (this.sessionGeneration !== opGen) {
          throw new NoSessionError('session was reset while refresh was in flight');
        }
        return this.adopt(auth);
      } catch (error) {
        if (this.sessionGeneration !== opGen) {
          if (error instanceof NoSessionError) {
            throw error;
          }
          throw new NoSessionError('session was reset while refresh was in flight');
        }
        // If a concurrent tab refreshed and updated our store with a fresh token,
        // adopt that valid session rather than destroying it.
        const current = this.store.load();
        if (
          current &&
          current.tokens.accessToken !== session.tokens.accessToken &&
          !this.isAccessTokenExpired(current)
        ) {
          return current;
        }
        this.reset();
        this.invalidatedHandler?.();
        throw error;
      } finally {
        if (this.refreshInFlight === pending) {
          this.refreshInFlight = null;
        }
      }
    })();

    this.refreshInFlight = pending;
    return pending;
  }
}
