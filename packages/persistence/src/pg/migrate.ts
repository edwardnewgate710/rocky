/**
 * @packageDocumentation
 * Forward-only SQL migration runner. Applies `NNNN_*.sql` files in order, each in
 * its own transaction, and records them in `schema_migrations` with a checksum so
 * history is immutable (a changed, already-applied file is a hard error).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { MigrationError } from '../errors';

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/** Apply all pending migrations in `dir`. Returns the number newly applied. */
export async function migrate(pool: Pool, dir: string): Promise<number> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       checksum   TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = await pool.query<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations',
  );
  const byVersion = new Map<number, AppliedRow>(applied.rows.map((r) => [r.version, r]));

  let count = 0;
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) throw new MigrationError(`invalid migration filename: ${file}`);
    const version = parseInt(match[1]!, 10);
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    const existing = byVersion.get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new MigrationError(
          `migration ${file} (version ${version}) changed after being applied; history is immutable`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
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
