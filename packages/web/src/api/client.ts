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
  GameSummary,
  Health,
  LeaderboardEntry,
  LoginRequest,
  RatingView,
  RefreshRequest,
  RegisterRequest,
  SelfUser,
  SessionView,
  UserProfile,
  Variant,
} from './models.js';

/** A request spec plus whether it requires authentication. */
export type ExecSpec = RequestSpec & { readonly auth?: boolean };

/** The bound request executor handed to resource groups. */
export type Execute = <T>(spec: ExecSpec) => Promise<T>;

export interface GambitClientOptions {
  /** API origin, e.g. `https://api.gambit.example`. Empty string = same origin. */
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
      refresh: (refreshToken): Promise<AuthResponse> =>
        this.http.request<AuthResponse>({
          method: 'POST',
          path: '/v1/auth/refresh',
          body: { refreshToken } satisfies RefreshRequest,
        }),
      ...(options.tokenStore ? { store: options.tokenStore } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

    this.auth = new AuthApi(this.execute, this.session);
    this.users = new UsersApi(this.execute);
    this.games = new GamesApi(this.execute);
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
        throw new UnauthorizedError({
          status: 401,
          code: 'unauthenticated',
          message: 'no active session',
          retryable: false,
        });
      }
      headers['authorization'] = `Bearer ${token}`;
    }

    try {
      return await this.http.request<T>({ ...rest, headers });
    } catch (error) {
      if (auth && !retried && error instanceof UnauthorizedError) {
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
    const auth = await this.execute<AuthResponse>({ method: 'POST', path: '/v1/auth/register', body });
    this.session.adopt(auth);
    return auth;
  }

  async login(body: LoginRequest): Promise<AuthResponse> {
    const auth = await this.execute<AuthResponse>({ method: 'POST', path: '/v1/auth/login', body });
    this.session.adopt(auth);
    return auth;
  }

  /** Force a token refresh now and return the fresh auth state. */
  async refresh(): Promise<AuthResponse> {
    const refreshed = await this.session.refreshNow();
    return { user: refreshed.user, tokens: refreshed.tokens };
  }

  /** Revoke the current refresh token server-side and clear the local session. */
  async logout(): Promise<void> {
    const current = this.session.current;
    if (!current) return;
    try {
      await this.execute<void>({
        method: 'POST',
        path: '/v1/auth/logout',
        auth: true,
        body: { refreshToken: current.tokens.refreshToken } satisfies RefreshRequest,
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
