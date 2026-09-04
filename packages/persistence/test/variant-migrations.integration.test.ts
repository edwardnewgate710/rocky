import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate, migrationFiles, migrationsDir } from '../src/pg/migrate';
import { withTestDatabase } from '../src/test-support/database';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';
const MIGRATIONS_DIR = migrationsDir();
const CANONICAL_VARIANTS = [
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
] as const;

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
}

interface ConstraintRow {
  readonly conname: string;
  readonly convalidated: boolean;
  readonly definition: string;
}

/** Returns whether an unknown thrown value is the expected PostgreSQL constraint violation. */
function isConstraintViolation(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgError = error as PgErrorShape;
  return pgError.code === code && pgError.constraint === constraint;
}

/** Copies migrations through the requested version into a disposable directory. */
function migrationsThrough(version: number): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `variant-migrations-${version}-`));
  for (const migration of migrationFiles(MIGRATIONS_DIR)) {
    if (migration.version > version) continue;
    copyFileSync(join(MIGRATIONS_DIR, migration.file), join(dir, migration.file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Runs a callback in an isolated database and always releases its pools and database.
 *
 * The teardown protocol itself lives in {@link withTestDatabase}. This file used to end its pool and
 * then immediately `DROP DATABASE ... WITH (FORCE)`, which terminated backends the pool had not yet
 * finished closing and delivered the resulting FATAL to a live socket — surfacing as an uncaught
 * error that `node:test` attributed to whichever test happened to run next.
 */
async function withDatabase(run: (pool: Pool) => Promise<void>): Promise<void> {
  await withTestDatabase(async ({ pool }) => run(pool), { connectionString: DATABASE_URL, max: 4 });
}

/** Reads one named constraint from PostgreSQL's catalog. */
async function constraint(
  pool: Pool,
  table: 'variants' | 'studies',
  name: string,
): Promise<ConstraintRow | undefined> {
  const found = await pool.query<ConstraintRow>(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [table, name],
  );
  return found.rows[0];
}

/** Inserts the minimum user row needed to own a study and returns its id. */
async function insertUser(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, handle, email_hash) VALUES ($1, $2, $3)`,
    [id, `variant_${id.replaceAll('-', '')}`, Buffer.from(id)],
  );
  return id;
}

/** Inserts a study with the requested variant and returns its id. */
async function insertStudy(pool: Pool, ownerId: string, variant: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO studies
       (id, owner_id, name, description, visibility, variant, created_at, updated_at)
     VALUES ($1, $2, $3, '', 'public', $4, NOW(), NOW())`,
    [id, ownerId, `Study ${variant}`, variant],
  );
  return id;
}

test('fresh install enforces the closed variants domain and validated studies FK', { skip }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool, MIGRATIONS_DIR);

    const variants = await pool.query<{ code: string }>('SELECT code FROM variants ORDER BY code');
    assert.deepEqual(
      variants.rows.map((row) => row.code),
      [...CANONICAL_VARIANTS].sort(),
    );

    await assert.rejects(
      pool.query(`INSERT INTO variants (code, name) VALUES ('unsupported', 'Unsupported')`),
      (error: unknown) => isConstraintViolation(error, '23514', 'variants_code_check'),
    );

    const domain = await constraint(pool, 'variants', 'variants_code_check');
    assert.equal(domain?.convalidated, true);
    assert.match(domain?.definition ?? '', /^CHECK \(\(code = ANY \(ARRAY\[/);
    assert.equal(await constraint(pool, 'studies', 'studies_variant_check'), undefined);

    const foreignKey = await constraint(pool, 'studies', 'studies_variant_fk');
    assert.equal(foreignKey?.convalidated, true);
    assert.equal(foreignKey?.definition, 'FOREIGN KEY (variant) REFERENCES variants(code)');

    const ownerId = await insertUser(pool);
    for (const variant of CANONICAL_VARIANTS) await insertStudy(pool, ownerId, variant);

    await assert.rejects(
      insertStudy(pool, ownerId, 'unsupported'),
      (error: unknown) => isConstraintViolation(error, '23503', 'studies_variant_fk'),
    );
    await assert.rejects(
      pool.query(`DELETE FROM variants WHERE code = 'racingkings'`),
      (error: unknown) => isConstraintViolation(error, '23503', 'studies_variant_fk'),
    );
  });
});

test('upgrade restores missing canonical rows before replacing the studies CHECK', { skip }, async () => {
  const through27 = migrationsThrough(27);
  const through28 = migrationsThrough(28);
  const through29 = migrationsThrough(29);
  const through30 = migrationsThrough(30);
  try {
    await withDatabase(async (pool) => {
      await migrate(pool, through27.dir);
      const ownerId = await insertUser(pool);
      const atomicStudy = await insertStudy(pool, ownerId, 'atomic');
      const hordeStudy = await insertStudy(pool, ownerId, 'horde');
      await pool.query(`DELETE FROM variants WHERE code IN ('atomic', 'horde')`);
      await pool.query(
        `UPDATE variants SET name = 'Operator Standard', enabled = false WHERE code = 'standard'`,
      );

      await migrate(pool, through28.dir);
      assert.equal((await constraint(pool, 'variants', 'variants_code_check'))?.convalidated, false);
      assert.notEqual(await constraint(pool, 'studies', 'studies_variant_check'), undefined);
      assert.equal(await constraint(pool, 'studies', 'studies_variant_fk'), undefined);
      await assert.rejects(
        pool.query(`INSERT INTO variants (code, name) VALUES ('new_rogue', 'New Rogue')`),
        (error: unknown) => isConstraintViolation(error, '23514', 'variants_code_check'),
      );

      await migrate(pool, through29.dir);
      assert.equal((await constraint(pool, 'variants', 'variants_code_check'))?.convalidated, true);
      assert.notEqual(await constraint(pool, 'studies', 'studies_variant_check'), undefined);

      await migrate(pool, through30.dir);
      assert.equal(await constraint(pool, 'studies', 'studies_variant_check'), undefined);
      assert.equal((await constraint(pool, 'studies', 'studies_variant_fk'))?.convalidated, false);
      await assert.rejects(
        insertStudy(pool, ownerId, 'new_rogue'),
        (error: unknown) => isConstraintViolation(error, '23503', 'studies_variant_fk'),
      );

      await migrate(pool, MIGRATIONS_DIR);
      assert.equal((await constraint(pool, 'studies', 'studies_variant_fk'))?.convalidated, true);
      const studies = await pool.query<{ id: string; variant: string }>(
        'SELECT id, variant FROM studies WHERE id = ANY($1) ORDER BY variant',
        [[atomicStudy, hordeStudy]],
      );
      assert.deepEqual(studies.rows.map((row) => row.variant), ['atomic', 'horde']);
      const standard = await pool.query<{ name: string; enabled: boolean }>(
        `SELECT name, enabled FROM variants WHERE code = 'standard'`,
      );
      assert.deepEqual(standard.rows[0], { name: 'Operator Standard', enabled: false });
    });
  } finally {
    through27.cleanup();
    through28.cleanup();
    through29.cleanup();
    through30.cleanup();
  }
});

test('unsupported legacy catalog data fails loudly, survives rollback, and retries deterministically', { skip }, async () => {
  const through27 = migrationsThrough(27);
  const through28 = migrationsThrough(28);
  const through29 = migrationsThrough(29);
  try {
    await withDatabase(async (pool) => {
      await migrate(pool, through27.dir);
      const ownerId = await insertUser(pool);
      await pool.query(
        `INSERT INTO variants (code, name, enabled) VALUES ('legacy_rogue', 'Legacy Rogue', false)`,
      );
      await pool.query(
        `INSERT INTO ratings (user_id, variant, rating, rd, vol)
         VALUES ($1, 'legacy_rogue', 1400, 100, 0.06)`,
        [ownerId],
      );
      await pool.query(
        `INSERT INTO seeks (id, creator_id, variant, time_control, rated)
         VALUES ($1, $2, 'legacy_rogue', '{}', false)`,
        [randomUUID(), ownerId],
      );
      await pool.query(
        `INSERT INTO games (id, variant, rated, speed, result, ply_count, last_seq, started_at)
         VALUES ($1, 'legacy_rogue', false, 'rapid', '*', 0, 0, NOW())`,
        [randomUUID()],
      );

      await migrate(pool, through28.dir);
      assert.equal((await constraint(pool, 'variants', 'variants_code_check'))?.convalidated, false);

      await assert.rejects(migrate(pool, through29.dir), /variants_code_check/);
      await assert.rejects(migrate(pool, through29.dir), /variants_code_check/);
      const preserved = await pool.query<{ source: string }>(`
        SELECT 'variant' AS source FROM variants WHERE code = 'legacy_rogue'
        UNION ALL SELECT 'rating' FROM ratings WHERE variant = 'legacy_rogue'
        UNION ALL SELECT 'seek' FROM seeks WHERE variant = 'legacy_rogue'
        UNION ALL SELECT 'game' FROM games WHERE variant = 'legacy_rogue'
        ORDER BY source
      `);
      assert.deepEqual(preserved.rows.map((row) => row.source), ['game', 'rating', 'seek', 'variant']);
      assert.notEqual(await constraint(pool, 'studies', 'studies_variant_check'), undefined);
      assert.equal(await constraint(pool, 'studies', 'studies_variant_fk'), undefined);

      await pool.query(`DELETE FROM games WHERE variant = 'legacy_rogue'`);
      await pool.query(`DELETE FROM seeks WHERE variant = 'legacy_rogue'`);
      await pool.query(`DELETE FROM ratings WHERE variant = 'legacy_rogue'`);
      await pool.query(`DELETE FROM variants WHERE code = 'legacy_rogue'`);
      await migrate(pool, MIGRATIONS_DIR);
      assert.equal((await constraint(pool, 'variants', 'variants_code_check'))?.convalidated, true);
      assert.equal((await constraint(pool, 'studies', 'studies_variant_fk'))?.convalidated, true);
    });
  } finally {
    through27.cleanup();
    through28.cleanup();
    through29.cleanup();
  }
});
