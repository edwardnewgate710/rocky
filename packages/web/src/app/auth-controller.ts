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
 */
import type { GambitClient } from '../api/client.js';
import type { KeyValueStorage } from '../net/session.js';

/** Callbacks the bootstrap wires to DOM elements. */
export interface AuthCallbacks {
  /** Called when the session state changes (login, logout, restore). */
  onSessionChange: (session: AuthSession | null) => void;
  /** Called when an auth action is pending (for UI spinner/disabled state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string) => void;
}

/** Session data persisted across reloads. */
export interface AuthSession {
  /** The access token used for bearer auth. */
  readonly accessToken: string;
  /** The authenticated user's handle. */
  readonly handle: string;
  /** The authenticated user's ID. */
  readonly userId: string;
}

export interface AuthControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: AuthCallbacks;
  /** Injected storage for session persistence (defaults to localStorage). */
  readonly storage?: KeyValueStorage;
  /** Storage key for the persisted session. */
  readonly storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'gambit-session';

/**
 * Manages the authentication session: login, register, logout, and restore.
 *
 * The controller is framework-independent and DOM-free. It persists the
 * session token to an injectable key-value store so that page reloads
 * preserve the authenticated state. It drives the UI through callbacks.
 */
export class AuthController {
  private readonly client: GambitClient;
  private readonly callbacks: AuthCallbacks;
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;
  private session: AuthSession | null = null;
  private disposed = false;

  constructor(opts: AuthControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
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

  /** Restore a previously persisted session from storage, if any. */
  restore(): AuthSession | null {
    if (this.disposed) return null;
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as AuthSession;
      if (parsed && typeof parsed.accessToken === 'string' && typeof parsed.handle === 'string') {
        this.session = parsed;
        this.callbacks.onSessionChange(this.session);
        return this.session;
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
      this.session = {
        accessToken: result.tokens.accessToken,
        handle: result.user.handle,
        userId: result.user.id,
      };
      this.persist();
      this.callbacks.onSessionChange(this.session);
      return this.session;
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
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
      this.session = {
        accessToken: result.tokens.accessToken,
        handle: result.user.handle,
        userId: result.user.id,
      };
      this.persist();
      this.callbacks.onSessionChange(this.session);
      return this.session;
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

  /** Permanently dispose the controller. */
  dispose(): void {
    this.disposed = true;
  }

  private persist(): void {
    if (!this.storage || !this.session) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.session));
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
