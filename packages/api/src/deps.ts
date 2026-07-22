/**
 * @packageDocumentation
 * The dependency bundle wired into the API. Everything the services and routes
 * need arrives here explicitly (constructor injection) — there are no module-level
 * singletons, so the whole server can be constructed with in-memory fakes for
 * tests or Postgres-backed implementations in production without changing a line
 * of route or service code.
 */

import type {
  GamesRepository,
  RatingsRepository,
  SeekAcceptor,
  SeeksRepository,
  SessionsRepository,
  UsersRepository,
  TournamentsRepository,
  IdentityTokensRepository,
  WebAuthnCredentialsRepository,
  WebAuthnLoginChallengesRepository
} from '@chess-platform/persistence';
import type { PasswordHasher } from './auth/password';
import type { AccessTokenService } from './auth/tokens';
import type { AuditRepository } from './ports/audit';
import type { Clock } from './ports/clock';
import type { IdGenerator } from './ports/ids';
import type { RateLimiter } from './ports/rate-limiter';
import type { ApiConfig } from './config';
import type { GameLauncher } from './tournament/launcher';
import type { TournamentLiveView } from './tournament/live-view';
import type { EmailSender } from './ports/email';
import type { Logger } from './ports/logger';
import type { Metrics } from './ports/metrics';

/** The full set of repositories the API consumes. */
export interface Repositories {
  readonly users: UsersRepository;
  readonly sessions: SessionsRepository;
  readonly ratings: RatingsRepository;
  readonly games: GamesRepository;
  readonly seeks: SeeksRepository;
  readonly audit: AuditRepository;
  readonly identityTokens: IdentityTokensRepository;
  readonly webauthnCredentials: WebAuthnCredentialsRepository;
  readonly webauthnLoginChallenges: WebAuthnLoginChallengesRepository;
  readonly seekAcceptor: SeekAcceptor;
}

/** Everything `createApiServer` needs to construct the service. */
export interface ApiDependencies {
  readonly repos: Repositories;
  readonly hasher: PasswordHasher;
  readonly tokens: AccessTokenService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: ApiConfig;
  readonly rateLimiter: RateLimiter;
  readonly tournamentRepo: TournamentsRepository;
  readonly gameLauncher: GameLauncher;
  readonly liveView: TournamentLiveView;
  readonly emailSender: EmailSender;
  /** Structured logger (M13). Defaults to a silent {@link NullLogger}. */
  readonly logger?: Logger;
  /** Metrics registry + scrape target (M13). Defaults to {@link InMemoryMetrics}. */
  readonly metrics?: Metrics;
  /** Production dependency check used by the readiness endpoint. */
  readonly readiness?: () => Promise<void>;
}
