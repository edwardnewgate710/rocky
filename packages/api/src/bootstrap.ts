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
import {
  createPool,
  PgGamesRepository,
  PgRatingsRepository,
  PgSeeksRepository,
  PgSessionsRepository,
  PgUsersRepository,
} from '@chess-platform/persistence/pg';
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
import { createApiServer } from './server';
import type { ApiServer, ApiServerOptions } from './server';

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
  readonly server?: ApiServerOptions;
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
  const deps: ApiDependencies = {
    repos: createPgRepositories(pool, ids),
    hasher,
    tokens,
    clock,
    ids,
    config,
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
