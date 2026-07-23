/**
 * @packageDocumentation
 * `@chess-platform/api/pg` — the thin bootstrap layer that wires the API to real
 * Postgres-backed repositories. This is the only module that imports the `pg`
 * driver. It builds the {@link ApiDependencies} bundle (Postgres repositories +
 * scrypt hasher + HMAC token service + system clock + UUIDv7 ids) and hands it to
 * {@link createApiServer}, keeping all business logic driver-agnostic.
 */

import type { Pool } from 'pg';
import { uuidv7 } from '@chess-platform/persistence';
import type { TournamentsRepository } from '@chess-platform/persistence';
import {
  createPool,
  PgGamesRepository,
  PostgresEventStore,
  PgRatingsRepository,
  PgSeeksRepository,
  PgSessionsRepository,
  PgTournamentsRepository,
  PgUsersRepository,
  PgIdentityTokensRepository,
  PgWebAuthnCredentialsRepository,
  PgWebAuthnLoginChallengesRepository,
  PgSeekAcceptor,
  PgAntiCheatReportRepository,
} from '@chess-platform/persistence/pg';
import { ConsoleEmailSender } from './ports/email';
import type { EmailSender } from './ports/email';
import { JsonLogger } from './ports/logger';
import type { Logger, LogLevel } from './ports/logger';
import { InMemoryMetrics } from './ports/metrics';
import type { Metrics } from './ports/metrics';
import { ScryptPasswordHasher } from './auth/password';
import type { PasswordHasher } from './auth/password';
import { AccessTokenService } from './auth/tokens';
import { resolveConfig } from './config';
import type { ApiConfigInput } from './config';
import type { ApiDependencies, Repositories } from './deps';
import type { AuditEntry, AuditRepository } from './ports/audit';
import { systemClock } from './ports/clock';
import type { Clock } from './ports/clock';
import { uuidv7Generator } from './ports/ids';
import type { IdGenerator } from './ports/ids';
import { PgRateLimiter } from './ports/pg-rate-limiter';
import type { RateLimiter } from './ports/rate-limiter';
import { createApiServer } from './server';
import type { ApiServer, ApiServerOptions } from './server';
import type { GameLauncher } from './tournament/launcher';
import type { TournamentLiveView } from './tournament/live-view';
import { DurableGameLauncher } from './tournament/durable-launcher';
import { DurableTournamentLiveView } from './tournament/durable-live-view';
import type { AnalysisProvider } from '@chess-platform/engine';
import { EngineBackedEvaluator } from '@chess-platform/anti-cheat/engine';
import { AntiCheatAnalysisService } from './anti-cheat/analysis-service';
import { EventStoreGameSource } from './anti-cheat/source';

/** Postgres-backed {@link AuditRepository} writing to the `audit_log` table. */
export class PgAuditRepository implements AuditRepository {
  constructor(
    private readonly pool: Pool,
    private readonly ids: IdGenerator = uuidv7Generator,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (id, actor_id, action, target, meta, request_id, trace_id, ip, user_agent, ts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        this.ids.next(),
        entry.actorId,
        entry.action,
        entry.target ?? null,
        JSON.stringify(entry.meta ?? {}),
        entry.requestId ?? null,
        entry.traceId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        new Date(entry.at),
      ],
    );
  }
}

/** Construct the full Postgres-backed repository bundle from a pool. */
export function createPgRepositories(pool: Pool, ids: IdGenerator = uuidv7Generator): Repositories {
  return {
    users: new PgUsersRepository(pool),
    sessions: new PgSessionsRepository(pool),
    ratings: new PgRatingsRepository(pool),
    games: new PgGamesRepository(pool),
    seeks: new PgSeeksRepository(pool),
    audit: new PgAuditRepository(pool, ids),
    identityTokens: new PgIdentityTokensRepository(pool),
    webauthnCredentials: new PgWebAuthnCredentialsRepository(pool),
    webauthnLoginChallenges: new PgWebAuthnLoginChallengesRepository(pool),
    seekAcceptor: new PgSeekAcceptor(pool),
    antiCheat: new PgAntiCheatReportRepository(pool),
  };
}

/** Options for the Postgres bootstrap. */
export interface PgBootstrapOptions {
  /** An existing pool; when omitted one is created from `connectionString`/`DATABASE_URL`. */
  readonly pool?: Pool;
  readonly connectionString?: string;
  readonly config?: ApiConfigInput;
  readonly hasher?: PasswordHasher;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly rateLimiter?: RateLimiter;
  readonly server?: ApiServerOptions;
  readonly tournamentRepo?: TournamentsRepository;
  readonly gameLauncher?: GameLauncher;
  readonly liveView?: TournamentLiveView;
  readonly emailSender?: EmailSender;
  readonly analysisProvider?: AnalysisProvider;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

/** Resolve the log level from `LOG_LEVEL`, defaulting to `info`. */
function resolveLogLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/** Build the {@link ApiDependencies} bundle backed by Postgres. */
export function createPgDependencies(options: PgBootstrapOptions = {}): {
  deps: ApiDependencies;
  pool: Pool;
} {
  const pool =
    options.pool ??
    createPool(options.connectionString ? { connectionString: options.connectionString } : {});
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidv7Generator;
  const config = resolveConfig(options.config);
  const hasher = options.hasher ?? new ScryptPasswordHasher();
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const rateLimiter = options.rateLimiter ?? new PgRateLimiter(pool);
  const tournamentRepo = options.tournamentRepo ?? new PgTournamentsRepository(pool);
  const eventStore = new PostgresEventStore(pool);
  const gameLauncher = options.gameLauncher ?? new DurableGameLauncher(eventStore, clock);
  const repos = createPgRepositories(pool, ids);
  const antiCheatAnalysis = options.analysisProvider
    ? new AntiCheatAnalysisService(
        new EventStoreGameSource(eventStore),
        (variant) => new EngineBackedEvaluator(options.analysisProvider!, variant),
        repos.antiCheat,
      )
    : undefined;
  const deps: ApiDependencies = {
    repos,
    hasher,
    tokens,
    clock,
    ids,
    config,
    rateLimiter,
    tournamentRepo,
    gameLauncher,
    liveView: options.liveView ?? new DurableTournamentLiveView(tournamentRepo, eventStore),
    emailSender: options.emailSender ?? new ConsoleEmailSender(),
    ...(antiCheatAnalysis ? { antiCheatAnalysis } : {}),
    // Production observability (M13): structured logs to stdout + a scrape
    // registry backing GET /v1/metrics.
    logger: options.logger ?? new JsonLogger({ service: 'api' }, { level: resolveLogLevel() }),
    metrics: options.metrics ?? new InMemoryMetrics(),
    readiness: async () => {
      await pool.query('SELECT 1');
    },
  };
  return { deps, pool };
}

/**
 * One-call production wiring: build Postgres dependencies and the API server.
 * Returns the server plus the pool so the caller can close it on shutdown.
 */
export function createPgApiServer(options: PgBootstrapOptions = {}): {
  server: ApiServer;
  pool: Pool;
} {
  const { deps, pool } = createPgDependencies(options);
  const server = createApiServer(deps, options.server);
  return { server, pool };
}

export { uuidv7 };
