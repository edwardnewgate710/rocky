/**
 * Typed API layer — the frontend's single entry point to the M4 REST contract.
 *
 * {@link GambitClient} composes the transport-level {@link HttpClient} with the
 * {@link SessionManager}. It:
 *   - exposes small, typed resource groups (`auth`, `users`, `games`) plus
 *     top-level `health()` / `leaderboard()`;
 *   - injects the bearer token on authenticated calls (refreshing proactively
 *     when the access token is near expiry);
 *   - recovers from a server-side 401 by refreshing once and replaying the
 *     request a single time, then surfacing the original error if that fails.
 *
 * M12 inc 2: refresh and logout now rely on the httpOnly refresh cookie
 * (`credentials: 'include'`) instead of putting the refresh token in the
 * request body. The access token stays in memory only. Login and register
 * also send `credentials: 'include'` so the browser accepts the Set-Cookie.
 * Non-browser API clients can still send the refresh token in the body
 * (the API accepts both).
 *
 * It is framework-independent and deliberately excludes lobby/matchmaking
 * (seeks) and live game streaming (WebSocket), which land in later increments.
 */
import { FetchTransport } from '../ports/http.js';
import type { HttpTransport } from '../ports/http.js';
import { HttpClient } from '../net/http-client.js';
import type { RequestSpec } from '../net/http-client.js';
import { UnauthorizedError } from '../net/errors.js';
import { SessionManager } from '../net/session.js';
import type { TokenStore } from '../net/session.js';
import { DEFAULT_RETRY_POLICY } from '../net/retry.js';
import type { RetryPolicy } from '../net/retry.js';
import type {
  AuthResponse,
  CreateSeekRequest,
  GameSummary,
  Health,
  LeaderboardEntry,
  LoginRequest,
  RatingView,
  RegisterRequest,
  SeekView,
  SelfUser,
  SessionView,
  UserProfile,
  Variant,
} from './models.js';

/** A request spec plus whether it requires authentication. */
export type ExecSpec = RequestSpec & { readonly auth?: boolean | 'optional' };

/** The bound request executor handed to resource groups. */
export type Execute = <T>(spec: ExecSpec) => Promise<T>;

export interface GambitClientOptions {
  /** API origin, e.g. `https://api.gambit.example`. Empty string = same-origin. */
  readonly baseUrl: string;
  readonly transport?: HttpTransport;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly tokenStore?: TokenStore;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly rng?: () => number;
}

export class GambitClient {
  readonly session: SessionManager;
  readonly auth: AuthApi;
  readonly users: UsersApi;
  readonly games: GamesApi;
  readonly seeks: SeeksApi;
  private readonly http: HttpClient;

  constructor(options: GambitClientOptions) {
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      transport: options.transport ?? new FetchTransport(),
      retry: options.retry ?? DEFAULT_RETRY_POLICY,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.rng ? { rng: options.rng } : {}),
    });

    this.session = new SessionManager({
      // M12 inc 2: refresh relies on the httpOnly cookie (credentials: 'include').
      // The refresh token is NOT sent in the body for the browser flow.
      refresh: (): Promise<AuthResponse> =>
        this.http.request<AuthResponse>({
          method: 'POST',
          path: '/v1/auth/refresh',
          credentials: 'include',
        }),
      ...(options.tokenStore ? { store: options.tokenStore } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

    this.auth = new AuthApi(this.execute, this.session);
    this.users = new UsersApi(this.execute);
    this.games = new GamesApi(this.execute);
    this.seeks = new SeeksApi(this.execute);
  }

  health(): Promise<Health> {
    return this.execute<Health>({ method: 'GET', path: '/v1/health' });
  }

  leaderboard(variant: Variant, opts: { limit?: number } = {}): Promise<LeaderboardEntry[]> {
    return this.execute<LeaderboardEntry[]>({
      method: 'GET',
      path: `/v1/leaderboard/${encodeURIComponent(variant)}`,
      ...(opts.limit !== undefined ? { query: { limit: opts.limit } } : {}),
    });
  }

  /**
   * Execute a request, injecting auth when required and recovering from a
   * server-side 401 with a single refresh-and-replay.
   */
  private execute = async <T>(spec: ExecSpec, retried = false): Promise<T> => {
    const { auth = false, ...rest } = spec;
    const headers: Record<string, string> = { ...spec.headers };

    if (auth) {
      const token = await this.session.validAccessToken();
      if (token === undefined) {
        if (auth === true) {
          throw new UnauthorizedError({
            status: 401,
            code: 'unauthenticated',
            message: 'no active session',
            retryable: false,
          });
        }
      } else {
        headers['authorization'] = `Bearer ${token}`;
      }
    }

    try {
      return await this.http.request<T>({ ...rest, headers });
    } catch (error) {
      if (auth && !retried && error instanceof UnauthorizedError && headers['authorization']) {
        try {
          await this.session.refreshNow();
        } catch {
          throw error;
        }
        return this.execute<T>(spec, true);
      }
      throw error;
    }
  };
}

export class AuthApi {
  private readonly execute: Execute;
  private readonly session: SessionManager;
  constructor(execute: Execute, session: SessionManager) {
    this.execute = execute;
    this.session = session;
  }

  async register(body: RegisterRequest): Promise<AuthResponse> {
    // M12 inc 2: send credentials so the browser accepts the Set-Cookie.
    const auth = await this.execute<AuthResponse>({
      method: 'POST',
      path: '/v1/auth/register',
      body,
      credentials: 'include',
    });
    this.session.adopt(auth);
    return auth;
  }

  async login(body: LoginRequest): Promise<AuthResponse> {
    // M12 inc 2: send credentials so the browser accepts the Set-Cookie.
    const auth = await this.execute<AuthResponse>({
      method: 'POST',
      path: '/v1/auth/login',
      body,
      credentials: 'include',
    });
    this.session.adopt(auth);
    return auth;
  }

  /**
   * Force a token refresh now and return the fresh auth state.
   *
   * M12 inc 2: this is the reload-restore path — it must work when there is NO
   * in-memory session yet, using only the httpOnly refresh cookie. It therefore
   * POSTs directly with `credentials: 'include'` and adopts the result, rather
   * than delegating to `session.refreshNow()` (which requires a pre-existing
   * session to read a body refresh token). The session-based `refreshNow()`
   * remains the single-flight path used by 401-recovery, where a session exists.
   */
  async refresh(): Promise<AuthResponse> {
    const auth = await this.execute<AuthResponse>({
      method: 'POST',
      path: '/v1/auth/refresh',
      credentials: 'include',
    });
    this.session.adopt(auth);
    return auth;
  }

  /**
   * Revoke the current refresh token server-side and clear the local session.
   *
   * M12 inc 2: sends `credentials: 'include'` so the httpOnly refresh cookie
   * is sent to the server. No refresh token in the body.
   */
  async logout(): Promise<void> {
    if (!this.session.isAuthenticated) return;
    try {
      await this.execute<void>({
        method: 'POST',
        path: '/v1/auth/logout',
        auth: true,
        credentials: 'include',
      });
    } finally {
      this.session.reset();
    }
  }

  sessions(): Promise<SessionView[]> {
    return this.execute<SessionView[]>({ method: 'GET', path: '/v1/auth/sessions', auth: true });
  }
}

export class UsersApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  me(): Promise<SelfUser> {
    return this.execute<SelfUser>({ method: 'GET', path: '/v1/users/me', auth: true });
  }

  byHandle(handle: string): Promise<UserProfile> {
    return this.execute<UserProfile>({ method: 'GET', path: `/v1/users/${encodeURIComponent(handle)}` });
  }

  ratings(handle: string): Promise<RatingView[]> {
    return this.execute<RatingView[]>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(handle)}/ratings`,
    });
  }

  games(handle: string, opts: { limit?: number } = {}): Promise<GameSummary[]> {
    return this.execute<GameSummary[]>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(handle)}/games`,
      ...(opts.limit !== undefined ? { query: { limit: opts.limit } } : {}),
    });
  }
}

export class GamesApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  byId(id: string): Promise<GameSummary> {
    return this.execute<GameSummary>({ method: 'GET', path: `/v1/games/${encodeURIComponent(id)}` });
  }
}

export class SeeksApi {
  private readonly execute: Execute;
  constructor(execute: Execute) {
    this.execute = execute;
  }

  list(): Promise<SeekView[]> {
    return this.execute<SeekView[]>({ method: 'GET', path: '/v1/seeks', auth: 'optional' });
  }

  create(body: CreateSeekRequest): Promise<SeekView> {
    return this.execute<SeekView>({ method: 'POST', path: '/v1/seeks', body, auth: true });
  }

  cancel(id: string): Promise<void> {
    return this.execute<void>({ method: 'DELETE', path: `/v1/seeks/${encodeURIComponent(id)}`, auth: true });
  }

  accept(id: string): Promise<SeekView> {
    return this.execute<SeekView>({ method: 'POST', path: `/v1/seeks/${encodeURIComponent(id)}/accept`, auth: true });
  }
}
