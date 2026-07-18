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
  SeeksRepository,
  SessionsRepository,
  UsersRepository,
  TournamentsRepository,
  IdentityTokensRepository
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

/** The full set of repositories the API consumes. */
export interface Repositories {
  readonly users: UsersRepository;
  readonly sessions: SessionsRepository;
  readonly ratings: RatingsRepository;
  readonly games: GamesRepository;
  readonly seeks: SeeksRepository;
  readonly audit: AuditRepository;
  readonly identityTokens: IdentityTokensRepository;
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
  /** Production dependency check used by the readiness endpoint. */
  readonly readiness?: () => Promise<void>;
}
