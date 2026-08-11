/**
 * Auth controller — a pure, DOM-free orchestrator that manages the
 * authentication session lifecycle (login, register, logout).
 *
 * It wraps the `GambitClient` auth/session API surface, exposes callbacks
 * for session state changes, and provides an `isAuthenticated` predicate
 * that the lobby controller (and other consumers) use to gate
 * auth-required actions like create-seek.
 *
 * Like {@link LobbyController} and {@link ProfileController}, it never
 * touches the DOM; the bootstrap layer wires callbacks to DOM elements.
 *
 * This module satisfies the C4/M2 identity entry: the existing auth stack
 * (`GambitClient.auth`) is fully built server-side — this controller is
 * the UI-side wiring that makes it reachable from the frontend.
 *
 * M12 inc 2: The access token is NO LONGER persisted to storage. Only the
 * user's handle and ID are persisted — enough to restore the UI state across
 * reloads. On reload, `restore()` calls `client.auth.refresh()` which uses
 * the httpOnly cookie to get a fresh access token. If the cookie is expired
 * or absent, the session is not restored (user must log in again).
 */
import type { GambitClient } from '../api/client.js';
import type { KeyValueStorage } from '../net/session.js';
import { NativeWebAuthnAdapter } from '../ports/webauthn.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';

/** Callbacks the bootstrap wires to DOM elements. */
export interface AuthCallbacks {
  /** Called when the session state changes (login, logout, restore). */
  onSessionChange: (session: AuthSession | null) => void;
  /** Called when an auth action is pending (for UI spinner/disabled state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string) => void;
}

/**
 * Session data persisted across reloads.
 *
 * M12 inc 2: Only the handle and userId are persisted — NOT the access token
 * (stays in memory) and NOT the refresh token (httpOnly cookie). This is
 * enough to restore the UI state; the actual access token is obtained by
 * calling refresh on reload, which uses the cookie.
 */
export interface AuthSession {
  /** The authenticated user's handle. */
  readonly handle: string;
  /** The authenticated user's ID. */
  readonly userId: string;
}

/**
 * Persisted session shape (stored in localStorage).
 * Only handle + userId — no tokens.
 */
interface PersistedAuth {
  readonly handle: string;
  readonly userId: string;
}

export interface AuthControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: AuthCallbacks;
  /** Injectable WebAuthn adapter (defaults to NativeWebAuthnAdapter). */
  readonly webauthnAdapter?: WebAuthnAdapter;
  /** Injected storage for session persistence (defaults to localStorage). */
  readonly storage?: KeyValueStorage;
  /** Storage key for the persisted session. */
  readonly storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'gambit-session';

/**
 * Manages the authentication session: login, register, logout, and restore.
 *
 * The controller is framework-independent and DOM-free. It persists only the
 * user's handle and ID to an injectable key-value store so that page reloads
 * can restore the UI state. The access token is kept in memory only (via the
 * SessionManager); the refresh token is in an httpOnly cookie. It drives the
 * UI through callbacks.
 */
export class AuthController {
  private readonly client: GambitClient;
  private readonly callbacks: AuthCallbacks;
  private readonly webauthnAdapter: WebAuthnAdapter;
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;
  private session: AuthSession | null = null;
  private sessionGeneration = 0;
  private disposed = false;

  constructor(opts: AuthControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.webauthnAdapter = opts.webauthnAdapter ?? new NativeWebAuthnAdapter();
    this.storage = opts.storage;
    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  /** Current session (snapshot), or null when unauthenticated. */
  get currentSession(): AuthSession | null {
    return this.session;
  }

  /** Whether the user is currently authenticated. */
  isAuthenticated(): boolean {
    return this.session !== null;
  }

  /**
   * Restore a previously persisted session from storage, if any.
   *
   * M12 inc 2: Only the handle and userId are restored from storage. The
   * access token is obtained by calling `client.auth.refresh()`, which uses
   * the httpOnly cookie. If the cookie is expired or absent, the session is
   * not restored.
   */
  async restore(): Promise<AuthSession | null> {
    if (this.disposed) return null;
    if (!this.storage) return null;
    const generation = this.sessionGeneration;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedAuth;
      if (parsed && typeof parsed.handle === 'string' && typeof parsed.userId === 'string') {
        // Try to get a fresh access token via the httpOnly cookie.
        try {
          const refreshed = await this.client.auth.refresh();
          if (this.disposed || generation !== this.sessionGeneration) {
            // AuthApi.refresh adopts before returning. A password reset may have
            // invalidated the local session while the network request was in flight.
            this.client.session.reset();
            return null;
          }
          return this.adoptSession(refreshed.user);
        } catch {
          // Cookie expired or absent — clear persisted state and return null.
          this.clearPersisted();
          return null;
        }
      }
    } catch {
      // Corrupted storage entry — clear it and return null.
      try {
        this.storage.removeItem(this.storageKey);
      } catch {
        // Storage unavailable — ignore.
      }
    }
    return null;
  }

  /** Log in with handle + password. Returns the session on success. */
  async login(handle: string, password: string): Promise<AuthSession | null> {
    if (this.disposed) return null;
    this.callbacks.onPending(true);
    try {
      const result = await this.client.auth.login({ handle, password });
      return this.adoptSession(result.user);
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.callbacks.onPending(false);
    }
  }

  /** Log in with passkey using the handle. Returns the session on success. */
  async loginWithPasskey(handle: string): Promise<AuthSession | null> {
    if (this.disposed) return null;
    const trimmed = handle.trim();
    if (!trimmed) {
      this.callbacks.onError('Please enter your handle to sign in with a passkey.');
      return null;
    }
    if (!this.webauthnAdapter.isSupported()) {
      this.callbacks.onError('Passkey sign-in is not supported on this browser.');
      return null;
    }
    this.callbacks.onPending(true);
    try {
      const options = await this.client.auth.loginPasskeyOptions({ handle: trimmed });
      const assertion = await this.webauthnAdapter.getCredential(options);
      const result = await this.client.auth.verifyPasskeyLogin(assertion);
      return this.adoptSession(result.user);
    } catch {
      // Do not expose account-existence details in client error copy.
      this.callbacks.onError('Sign in with passkey failed.');
      return null;
    } finally {
      this.callbacks.onPending(false);
    }
  }

  /** Register a new account. Returns the session on success. */
  async register(handle: string, password: string): Promise<AuthSession | null> {
    if (this.disposed) return null;
    this.callbacks.onPending(true);
    try {
      const result = await this.client.auth.register({ handle, password });
      return this.adoptSession(result.user);
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.callbacks.onPending(false);
    }
  }

  /** Log out and clear the persisted session. */
  async logout(): Promise<void> {
    if (this.disposed) return;
    this.callbacks.onPending(true);
    try {
      await this.client.auth.logout();
    } catch {
      // Server-side logout failure is non-fatal — clear locally regardless.
    } finally {
      this.session = null;
      this.clearPersisted();
      this.callbacks.onSessionChange(null);
      this.callbacks.onPending(false);
    }
  }

  /** Clear local session state without issuing server logout (e.g. after password reset confirm). */
  clearLocalSession(): void {
    this.sessionGeneration++;
    this.session = null;
    this.clearPersisted();
    this.client.session.reset();
    this.callbacks.onSessionChange(null);
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    this.disposed = true;
  }

  private adoptSession(user: { handle: string; id: string }): AuthSession {
    this.session = {
      handle: user.handle,
      userId: user.id,
    };
    this.persist();
    this.callbacks.onSessionChange(this.session);
    return this.session;
  }

  private persist(): void {
    if (!this.storage || !this.session) return;
    try {
      // M12 inc 2: persist only handle + userId — no tokens.
      const persisted: PersistedAuth = {
        handle: this.session.handle,
        userId: this.session.userId,
      };
      this.storage.setItem(this.storageKey, JSON.stringify(persisted));
    } catch {
      // Storage unavailable — session is in-memory only.
    }
  }

  private clearPersisted(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      // Storage unavailable — ignore.
    }
  }
}
