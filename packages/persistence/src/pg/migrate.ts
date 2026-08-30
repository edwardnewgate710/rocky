/**
 * @packageDocumentation
 * Forward-only SQL migration runner. Applies `NNNN_*.sql` files in order and
 * records them in `schema_migrations` with a checksum so history is immutable (a
 * changed, already-applied file is a hard error). Migrations are transactional by
 * default; a narrowly validated directive supports online index creation.
 *
 * Migration files are read through a single canonical representation — UTF-8
 * text with LF newlines, matching the committed Git blob. The repository has no
 * `.gitattributes`, so the bytes on disk depend on each machine's
 * `core.autocrlf`: one commit checks out with LF on Linux and CRLF on Windows.
 * Hashing or executing those bytes directly would make both the ledger checksum
 * and the SQL sent to PostgreSQL a property of the checkout rather than of the
 * migration, so canonicalization happens once, at read time.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { MigrationError } from '../errors';

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  state: 'pending' | 'applied';
}

export type ParsedMigration =
  | { kind: 'transactional'; sql: string }
  | { kind: 'online-index'; indexName: string; sql: string };

interface RelationRow {
  relkind: string;
  indisvalid: boolean | null;
}

interface OnlineIndexApplication {
  version: number;
  file: string;
  checksum: string;
  migration: Extract<ParsedMigration, { kind: 'online-index' }>;
  existing?: AppliedRow;
}

/** Advisory-lock key that namespaces the migration runner (arbitrary constant). */
const MIGRATION_ADVISORY_LOCK_KEY = 4915219603172;

/**
 * Reduce a migration to its canonical form: the committed LF text.
 *
 * Only the CRLF pair is rewritten, because that is the only difference a Git
 * checkout can introduce. Every other byte — indentation, blank lines, a lone
 * CR, a missing trailing newline — is migration content and stays untouched, so
 * canonicalization cannot mask an edit to an applied migration.
 *
 * This exactly inverts Git's LF-to-CRLF checkout conversion over the inputs a
 * checkout can produce. Git does not double-convert — a blob that already holds
 * CRLF is checked out unchanged rather than as `\r\r\n` — so one pass is enough.
 */
/**
 * The migrations this package ships, ordered, with the version each filename declares.
 *
 * The `NNNN_` prefix is the only thing that orders a migration and the only thing that identifies
 * it in the ledger, so it is parsed in exactly one place. {@link runMigrations} and
 * {@link missingMigrations} both read the directory, and a second copy of this rule is how the
 * runner and the readiness check would come to disagree about what "migration 4" means.
 */
export function migrationFiles(dir: string): readonly { readonly file: string; readonly version: number }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = /^(\d+)_/.exec(file);
      if (!match) throw new MigrationError(`invalid migration filename: ${file}`);
      return { file, version: parseInt(match[1]!, 10) };
    });
}

let resolvedMigrationsDir: string | undefined;

/**
 * The `migrations/` directory shipped alongside this package.
 *
 * Found by walking up from this module rather than from `process.cwd()`, because the callers do not
 * agree on a working directory: the API image runs `node packages/api/dist/scripts/serve.js` from
 * `/app`, `npm run migrate` runs from `packages/persistence`, and the test build sits one level
 * deeper again under `dist-test/`. Anchoring on the compiled file's own location is the one thing
 * true in all three.
 *
 * **A function, and not a module-level constant.** Resolving this at import time would throw inside
 * the `pg` barrel, and the barrel is imported by things that never migrate anything: the gateway
 * loads it for `createPool` and `PostgresEventStore`, and its image copies this package's `dist`
 * without its `migrations`. A constant would therefore have turned a missing directory the gateway
 * has no use for into a crash before its server ever started. Resolution is memoized on success
 * only, so the repeated calls a readiness probe makes cost one `existsSync` walk in total, while a
 * failure stays a failure rather than being cached as one.
 *
 * Raised by Qodo on this PR.
 *
 * `from` exists so the walk can be exercised against a tree that has no migrations, and only the
 * default resolution is memoized — a cache that answered for an explicitly supplied root would make
 * the argument a lie, and did, until this test caught it.
 */
export function migrationsDir(from?: string): string {
  if (from === undefined && resolvedMigrationsDir !== undefined) return resolvedMigrationsDir;
  let dir = from ?? __dirname;
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '0001_init.sql'))) {
      if (from === undefined) resolvedMigrationsDir = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MigrationError('cannot locate the migrations directory shipped with this package');
}

/**
 * Which shipped migrations the database has no record of.
 *
 * This is the question a readiness probe needs answered and `SELECT 1` cannot answer: the server can
 * be reachable, authenticated and completely empty. A database missing migration 4 has no
 * `rate_limit_buckets`, so every rate-limited route — sign-in first among them — fails with
 * `undefined_table` the moment it is asked for.
 *
 * **Presence, not state, and not checksums.** A row in `pending` counts as present: that state
 * belongs to an online index whose table already exists and whose `CREATE INDEX CONCURRENTLY` may
 * legitimately run for an hour, and refusing traffic for that hour would defeat the point of
 * building it concurrently. Checksums are deliberately not compared either — {@link migrate} already
 * owns immutability, and it rewrites legacy checksums in place, so a probe that compared them would
 * refuse a database that is correct but has not been re-migrated since that fix.
 *
 * A missing `schema_migrations` table means nothing has been applied, which is reported as every
 * version missing rather than as an error, because "not migrated" is exactly what it is.
 */
export async function missingMigrations(
  pool: Pool,
  dir: string = migrationsDir(),
): Promise<readonly number[]> {
  const shipped = migrationFiles(dir).map((m) => m.version);
  const ledger = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (ledger.rows[0]?.present !== true) return shipped;

  const applied = await pool.query<{ version: number }>('SELECT version FROM schema_migrations');
  const recorded = new Set(applied.rows.map((row) => row.version));
  return shipped.filter((version) => !recorded.has(version));
}

export function canonicalizeMigrationSql(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

/**
 * Read a migration file in its canonical form.
 *
 * Decoding is verified to round-trip. Node's UTF-8 decoder silently replaces a
 * malformed byte with U+FFFD, so `0xFF` and the valid encoding of U+FFFD would
 * otherwise reduce to the same text and the same checksum — letting one stand in
 * for the other in an applied migration. Only CRLF may be normalized away.
 */
export function readMigrationSql(dir: string, file: string): string {
  const bytes = readFileSync(join(dir, file));
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new MigrationError(`migration ${file} is not valid UTF-8`);
  }
  return canonicalizeMigrationSql(text);
}

/**
 * Hex SHA-256 of `text`, encoded as UTF-8.
 *
 * The encoding is named rather than left to the default so a ledger checksum
 * depends only on the characters hashed — the whole point of canonicalizing the
 * migration first. Callers pass canonical text, or the CRLF rendering of it when
 * checking a checksum an older runner wrote.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Ledger checksum of a migration, derived from its canonical form. */
export function migrationChecksum(canonicalSql: string): string {
  return sha256(canonicalSql);
}

/**
 * True when a stored checksum was written by the pre-canonicalization runner,
 * which hashed the checked-out bytes and so recorded the CRLF rendering on
 * Windows. The content is proven identical apart from newline encoding, so this
 * is the same migration under the old scheme rather than a history violation.
 * A real content edit matches neither rendering and still fails.
 */
function isLegacyCrlfChecksum(stored: string, canonicalSql: string): boolean {
  return stored === sha256(canonicalSql.replace(/\n/g, '\r\n'));
}

/**
 * Parse the optional online-index directive and reject any broader escape from
 * transactional migration execution.
 */
export function parseMigration(sql: string): ParsedMigration {
  if (!/^\s*--\s*migrate:online-index\b/i.test(sql)) {
    return { kind: 'transactional', sql };
  }
  return parseOnlineIndex(sql);
}

function parseOnlineIndex(sql: string): ParsedMigration {
  const directive = /^\s*--\s*migrate:online-index\s+([a-z_][a-z0-9_]*)\s*\r?\n([\s\S]*)$/i.exec(
    sql,
  );
  if (!directive) {
    throw new MigrationError('invalid migrate:online-index directive');
  }

  const indexName = directive[1]!.toLowerCase();
  const statement = directive[2]!.trim();
  const statementIndexName = concurrentIndexName(statement);
  if (statementIndexName !== indexName) {
    throw new MigrationError(`online-index statement must match declared index ${indexName}`);
  }
  return { kind: 'online-index', indexName, sql: statement };
}

function concurrentIndexName(statement: string): string {
  const create = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+([a-z_][a-z0-9_]*)\b[\s\S]*;$/i.exec(
    statement,
  );
  if (!create || (statement.match(/;/g) ?? []).length !== 1) {
    throw new MigrationError(
      'an online-index migration must contain exactly one CREATE INDEX CONCURRENTLY statement',
    );
  }
  return create[1]!.toLowerCase();
}

/**
 * Apply all pending migrations in `dir`. Returns the number newly applied.
 *
 * The whole run holds a database-wide advisory lock (on a dedicated connection)
 * so parallel callers — concurrent test files, or multiple app instances booting
 * at once — serialize instead of racing to apply the same migration.
 */
export async function migrate(pool: Pool, dir: string): Promise<number> {
  const lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    return await runMigrations(pool, dir);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    lockClient.release();
  }
}

/**
 * The walk itself: ensure the ledger exists, then apply every file the database has no record of.
 *
 * Separated from {@link migrate} because the advisory lock is that function's whole job — this one
 * assumes it is already held and may therefore read `schema_migrations`, decide what is outstanding,
 * and write to it without racing another booting instance. The ledger is created here rather than in
 * a migration because it is the thing that records migrations, and the `ADD COLUMN IF NOT EXISTS`
 * below is how a ledger written before online indexes existed acquires the `state` column.
 */
async function runMigrations(pool: Pool, dir: string): Promise<number> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       checksum   TEXT NOT NULL,
       state      TEXT NOT NULL DEFAULT 'applied',
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(
    `ALTER TABLE schema_migrations
       ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'applied'`,
  );

  const files = migrationFiles(dir);

  const applied = await pool.query<AppliedRow>(
    'SELECT version, name, checksum, state FROM schema_migrations',
  );
  const byVersion = new Map<number, AppliedRow>(applied.rows.map((r) => [r.version, r]));

  let count = 0;
  for (const { file, version } of files) {
    const sql = readMigrationSql(dir, file);
    const checksum = migrationChecksum(sql);
    const migration = parseMigration(sql);

    const existing = byVersion.get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        if (!isLegacyCrlfChecksum(existing.checksum, sql)) {
          throw new MigrationError(
            `migration ${file} (version ${version}) changed after being applied; history is immutable`,
          );
        }
        await adoptCanonicalChecksum(pool, version, checksum);
      }
      if (existing.state === 'applied') continue;
      if (migration.kind !== 'online-index') {
        throw new MigrationError(`migration ${file} has an unsupported pending state`);
      }
    }

    if (migration.kind === 'online-index') {
      try {
        await applyOnlineIndex(pool, { version, file, checksum, migration, existing });
        count += 1;
      } catch (err) {
        throw new MigrationError(`migration ${file} failed: ${(err as Error).message}`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, state)
           VALUES ($1, $2, $3, 'applied')`,
        [version, file, checksum],
      );
      await client.query('COMMIT');
      count += 1;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw new MigrationError(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return count;
}

/**
 * Rewrite a legacy CRLF checksum to the canonical one, so a ledger written by a
 * Windows checkout converges instead of re-deriving the legacy form on every
 * run. Runs under the migration advisory lock and touches only the checksum.
 */
async function adoptCanonicalChecksum(
  pool: Pool,
  version: number,
  checksum: string,
): Promise<void> {
  await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
    version,
    checksum,
  ]);
}

async function applyOnlineIndex(
  pool: Pool,
  application: OnlineIndexApplication,
): Promise<void> {
  const client = await pool.connect();
  try {
    const relation = await findRelation(client, application.migration.indexName);
    await reserveOnlineIndex(client, application, relation);
    await ensureValidOnlineIndex(client, application.migration, relation);
    await completeOnlineIndex(client, application.version);
  } finally {
    client.release();
  }
}

async function reserveOnlineIndex(
  client: PoolClient,
  application: OnlineIndexApplication,
  relation: RelationRow | undefined,
): Promise<void> {
  if (application.existing) return;
  if (relation) throw new Error(`relation ${application.migration.indexName} already exists`);
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum, state)
       VALUES ($1, $2, $3, 'pending')`,
    [application.version, application.file, application.checksum],
  );
}

async function ensureValidOnlineIndex(
  client: PoolClient,
  migration: Extract<ParsedMigration, { kind: 'online-index' }>,
  relation: RelationRow | undefined,
): Promise<void> {
  if (relation && relation.relkind !== 'i') {
    throw new Error(`relation ${migration.indexName} exists but is not an index`);
  }
  if (relation && relation.indisvalid !== true) {
    await client.query(`DROP INDEX CONCURRENTLY "${migration.indexName}"`);
  }
  if (!relation || relation.indisvalid !== true) await client.query(migration.sql);

  const created = await findRelation(client, migration.indexName);
  if (!created || created.relkind !== 'i' || created.indisvalid !== true) {
    throw new Error(`online index ${migration.indexName} was not created as a valid index`);
  }
}

async function completeOnlineIndex(client: PoolClient, version: number): Promise<void> {
  const completion = await client.query(
    `UPDATE schema_migrations
        SET state = 'applied', applied_at = now()
      WHERE version = $1 AND state = 'pending'`,
    [version],
  );
  if (completion.rowCount !== 1) throw new Error(`pending migration ${version} was not completed`);
}

async function findRelation(
  client: PoolClient,
  name: string,
): Promise<RelationRow | undefined> {
  const result = await client.query<RelationRow>(
    `SELECT c.relkind, i.indisvalid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = current_schema()
        AND c.relname = $1`,
    [name],
  );
  return result.rows[0];
}
