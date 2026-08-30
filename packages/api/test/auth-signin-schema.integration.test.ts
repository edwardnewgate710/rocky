/**
 * Sign-in against a database that has not been migrated, and the probe that is supposed to say so.
 *
 * This file exists because of a reproduced failure, not a hypothesis. `POST /v1/auth/login` returned
 * HTTP 500 against a local PostgreSQL, and the exception was `relation "rate_limit_buckets" does not
 * exist`: the route rate-limits before it authenticates, that table arrives in migration 0004, and a
 * database that never got there fails in the limiter before a credential is ever read. The same 500
 * appears on a database migrated to 3 of 27 — `users` exists from 0001, so the schema looks
 * plausible right up until the first request.
 *
 * The 500 itself is correct. A database that cannot answer is a server-side fault, the client is
 * told nothing but `internal`, and the cause is logged privately. What was wrong is that nothing
 * *said so*: `GET /v1/ready` answered 200 in both states, because readiness was `SELECT 1` — a proof
 * of connectivity, not of usability. That answer is what admits traffic to a Kubernetes pod and what
 * releases the gateway's and search indexer's `wait-for-api` init containers, and the chart's
 * migrate init container is behind a toggle, so nothing else stood between a skipped migration and a
 * fleet serving 500s.
 *
 * Each test owns a PostgreSQL database of its own and migrates it to whatever version the case
 * needs, through the canonical runner and the canonical SQL — never inventing DDL, which is the
 * thing the migration ledger exists to prevent.
 *
 * A database rather than a schema, and the reason is worth recording: `search_path` isolation looks
 * cheaper and fails here. `CREATE EXTENSION IF NOT EXISTS citext` in migration 0001 is a no-op once
 * any other suite has installed the extension into `public`, so a schema-scoped run finds `citext`
 * unresolvable and 0001 fails; adding `public` to the path fixes that and breaks the other half,
 * because then the un-migrated case reads the shared `schema_migrations` and reports itself ready.
 * Only a separate database gives both an empty ledger and a resolvable extension.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPool,
  migrate,
  migrationFiles,
  missingMigrations,
  migrationsDir,
} from '@chess-platform/persistence/pg';
import type { Pool } from 'pg';
import { createPgApiServer } from '../src/bootstrap';
import { JsonLogger } from '../src/ports/logger';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/** Long enough for `resolveConfig`, and not a secret — it signs nothing that outlives the test. */
const TEST_SECRET = 'test-access-token-secret-0123456789abcdef';

/**
 * WHATWG `fetch` refuses several legacy-service ports even on loopback, and Windows hands them out
 * of a low ephemeral range. Copied from `helpers.ts`, which learned it the hard way.
 */
const FETCH_BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

/**
 * Wait for the listener to actually stop, rather than only asking it to.
 *
 * `Server.close` is callback-shaped and reports its failure there; returning before it settles would
 * leave the port held while the next case tries to bind, which is the kind of flake that only shows
 * up under `--test-concurrency`.
 */
const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

/**
 * A directory holding the first `count` migrations, copied byte-for-byte from the real ones.
 *
 * Copied rather than written out, because a second hand-maintained copy of migration SQL is exactly
 * what the checksum ledger exists to make impossible: these have to be the same bytes the runner
 * would apply in production, or the "partially migrated" case under test is not the one that
 * happens.
 */
function migrationsThrough(count: number): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'signin-migrations-'));
  for (const { file } of migrationFiles(migrationsDir()).slice(0, count)) {
    copyFileSync(join(migrationsDir(), file), join(dir, file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Fixture {
  readonly baseUrl: string;
  /** The pool the API is running on, connected to this test's own database. */
  readonly pool: Pool;
  /** Bring the database up using the canonical runner. */
  migrateTo(dir: string): Promise<number>;
}

/** The same server, same credentials, a different database name. */
function databaseUrlFor(name: string): string {
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Run one case against an API server whose entire world is a private PostgreSQL database, created
 * for the test and dropped after it.
 */
async function withSchema(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  // Both pools are capped well below `pg`'s default of ten. This file runs inside a suite that
  // already holds a great many connections against one server, and a test that quietly opened twenty
  // more would push the next file over `max_connections` — which surfaces as that file failing, not
  // this one. Two is the floor rather than one: `migrate` holds the advisory lock on a dedicated
  // client and runs its statements on another, so a single-connection pool deadlocks against itself.
  const admin = createPool({ connectionString: DATABASE_URL, max: 2 });
  const database = `signin_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  await admin.query(`CREATE DATABASE "${database}"`);

  const pool = createPool({ connectionString: databaseUrlFor(database), max: 4 });
  // Errors only: a deliberately broken database is about to be exercised, and the point of these
  // tests is the status codes, not a wall of expected failure logging.
  const logger = new JsonLogger({}, { level: 'error', sink: () => {} });

  const savedEnv = { NODE_ENV: process.env['NODE_ENV'], EMAIL_PROVIDER: process.env['EMAIL_PROVIDER'] };
  process.env['NODE_ENV'] = 'test';
  process.env['EMAIL_PROVIDER'] = 'console';

  let http: Server | undefined;
  let shutdownAnalysis: (() => Promise<void>) | undefined;
  try {
    const composed = createPgApiServer({ pool, logger, config: { accessTokenSecret: TEST_SECRET } });
    shutdownAnalysis = composed.shutdownAnalysis;

    let port: number;
    do {
      http = await composed.server.listen(0, '127.0.0.1');
      ({ port } = http.address() as AddressInfo);
      if (FETCH_BLOCKED_PORTS.has(port)) {
        await closeServer(http);
        http = undefined;
      }
    } while (http === undefined);

    await run({ baseUrl: `http://127.0.0.1:${port}`, pool, migrateTo: (dir) => migrate(pool, dir) });
  } finally {
    if (http) await closeServer(http);
    if (shutdownAnalysis) await shutdownAnalysis();
    // Every connection to the database has to be gone before it can be dropped, and the admin pool
    // is deliberately connected to a different one.
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The sign-in request exactly as the web client sends it — `POST /v1/auth/login`, JSON body.
 *
 * `body` is deliberately `unknown`: several cases here send something the route should reject, and
 * typing it as a valid request would make the malformed cases unwritable.
 */
const login = (baseUrl: string, body: unknown): Promise<Response> =>
  fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The reproduction, pinned.
 *
 * Not an aspiration — this is what the failure looked like, asserted so that a future change which
 * quietly turns it into a 200 (or into a 401, which would be worse: a broken database reported as a
 * bad password) has to argue with a test.
 */
test('an un-migrated database: sign-in is a server fault, and readiness admits it', { skip }, async () => {
  await withSchema(async ({ baseUrl, pool }) => {
    assert.equal(
      (await missingMigrations(pool)).length,
      migrationFiles(migrationsDir()).length,
      'nothing is applied yet, so every shipped migration is missing',
    );

    assert.equal(
      (await fetch(`${baseUrl}/v1/ready`)).status,
      503,
      'an un-migrated database is not something to send traffic at',
    );

    // Liveness is a different question and keeps its own answer: the process is running, and
    // restarting it would not migrate anything.
    assert.equal((await fetch(`${baseUrl}/v1/health`)).status, 200);

    const response = await login(baseUrl, { handle: 'anyone', password: 'CorrectHorseBattery1' });
    assert.equal(response.status, 500, 'the reproduced failure');

    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, 'internal server error');
    assert.ok(
      !JSON.stringify(body).includes('rate_limit_buckets'),
      'the client is never told which relation is missing',
    );
  });
});

/**
 * The variant that actually bites people: a database migrated once and then left behind.
 *
 * `users` exists, so nothing about the schema looks obviously empty, and the failure still lands in
 * the rate limiter. Migration 4 is the first one missing, which is exactly the table the reproduced
 * exception named.
 */
test('a partially migrated database is not ready either', { skip }, async () => {
  const { dir, cleanup } = migrationsThrough(3);
  try {
    await withSchema(async ({ baseUrl, pool, migrateTo }) => {
      assert.equal(await migrateTo(dir), 3);

      const missing = await missingMigrations(pool);
      assert.equal(missing[0], 4, 'the first gap is the migration that creates rate_limit_buckets');

      assert.equal((await fetch(`${baseUrl}/v1/ready`)).status, 503);
      assert.equal(
        (await login(baseUrl, { handle: 'anyone', password: 'CorrectHorseBattery1' })).status,
        500,
      );
    });
  } finally {
    cleanup();
  }
});

/**
 * An online index still being built must not take the fleet out.
 *
 * `migrate` reserves an online-index migration as `pending`, runs `CREATE INDEX CONCURRENTLY`, and
 * only then marks it `applied`. On a large table that build can run for the better part of an hour,
 * and it runs concurrently precisely so that nothing has to stop for it. A probe that required
 * `applied` would spend that hour reporting 503 and would turn the non-blocking option into the
 * blocking one — so presence in the ledger is the test, in whatever state, and the table the index
 * belongs to already exists by then.
 */
test('a migration still building its index concurrently does not make the API unready', { skip }, async () => {
  await withSchema(async ({ baseUrl, pool, migrateTo }) => {
    await migrateTo(migrationsDir());
    const latest = migrationFiles(migrationsDir()).at(-1)?.version;
    assert.ok(latest !== undefined);

    await pool.query("UPDATE schema_migrations SET state = 'pending' WHERE version = $1", [latest]);

    assert.deepEqual(await missingMigrations(pool), [], 'a reserved migration is present, not absent');
    assert.equal((await fetch(`${baseUrl}/v1/ready`)).status, 200);
  });
});

/**
 * The other half of the claim: the stricter probe must not refuse a database that is actually fine,
 * and sign-in must still behave exactly as it did.
 */
test('a fully migrated database is ready, and signs in', { skip }, async () => {
  await withSchema(async ({ baseUrl, pool, migrateTo }) => {
    await migrateTo(migrationsDir());
    assert.deepEqual(await missingMigrations(pool), []);

    assert.equal((await fetch(`${baseUrl}/v1/ready`)).status, 200);

    const handle = `signin_${Date.now().toString(36)}`;
    const password = 'CorrectHorseBattery1';

    const registered = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password }),
    });
    assert.equal(registered.status, 201);

    assert.equal((await login(baseUrl, { handle, password })).status, 200);

    // The failures that must never become 500s, because that is the class of defect this file was
    // opened to rule out.
    assert.equal((await login(baseUrl, { handle, password: 'WrongPassword123' })).status, 401);
    assert.equal(
      (await login(baseUrl, { handle: 'nobody_at_all_here', password })).status,
      401,
      'an unknown handle is a rejection, not a fault, and reads identically to a wrong password',
    );
    assert.equal((await login(baseUrl, { handle })).status, 422, 'a malformed request is the caller’s');
  });
});
