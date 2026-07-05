/**
 * Session / authentication abstraction.
 *
 * The M4 contract issues a short-lived access token plus an opaque, single-use
 * refresh token. This module owns that lifecycle on the client:
 *
 *  - a pluggable {@link TokenStore} (in-memory by default; a Web Storage adapter
 *    for persistence across reloads) so *where* tokens live is a choice, not a
 *    hard dependency;
 *  - a {@link SessionManager} that adopts auth responses, tracks access-token
 *    expiry, hands out `Authorization` headers, and refreshes proactively (before
 *    expiry) with a **single-flight** guard so concurrent requests trigger at
 *    most one refresh.
 *
 * Refresh is injected as a plain function, not the whole API client, to avoid a
 * dependency cycle and keep the manager unit-testable in isolation.
 */
import type { AuthResponse, SelfUser, TokenPair } from '../api/models.js';

/** A refresh call: exchange a refresh token for a fresh auth response. */
export type RefreshFn = (refreshToken: string) => Promise<AuthResponse>;

/** Persisted session state. */
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

/** Persistent store backed by an injected Web Storage instance. */
export class WebStorageTokenStore implements TokenStore {
  private readonly storage: KeyValueStorage;
  private readonly key: string;
  constructor(storage: KeyValueStorage, key = 'gambit.session') {
    this.storage = storage;
    this.key = key;
  }
  load(): StoredSession | null {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (
        parsed !== null &&
        typeof parsed.accessTokenExpiresAt === 'number' &&
        parsed.tokens !== undefined &&
        parsed.user !== undefined
      ) {
        return parsed as StoredSession;
      }
    } catch {
      /* corrupt payload — treat as no session */
    }
    return null;
  }
  save(session: StoredSession): void {
    this.storage.setItem(this.key, JSON.stringify(session));
  }
  clear(): void {
    this.storage.removeItem(this.key);
  }
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
   */
  async refreshNow(): Promise<StoredSession> {
    const existing = this.refreshInFlight;
    if (existing) return existing;

    const session = this.store.load();
    if (!session) throw new NoSessionError('cannot refresh without a session');

    const pending = (async (): Promise<StoredSession> => {
      try {
        const auth = await this.doRefresh(session.tokens.refreshToken);
        return this.adopt(auth);
      } catch (error) {
        this.reset();
        throw error;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    this.refreshInFlight = pending;
    return pending;
  }
}
