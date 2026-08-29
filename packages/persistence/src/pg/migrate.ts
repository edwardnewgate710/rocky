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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
export function canonicalizeMigrationSql(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

/** Read a migration file in its canonical form. */
export function readMigrationSql(dir: string, file: string): string {
  return canonicalizeMigrationSql(readFileSync(join(dir, file), 'utf8'));
}

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

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = await pool.query<AppliedRow>(
    'SELECT version, name, checksum, state FROM schema_migrations',
  );
  const byVersion = new Map<number, AppliedRow>(applied.rows.map((r) => [r.version, r]));

  let count = 0;
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) throw new MigrationError(`invalid migration filename: ${file}`);
    const version = parseInt(match[1]!, 10);
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
