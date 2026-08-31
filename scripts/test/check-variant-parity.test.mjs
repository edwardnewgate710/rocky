/**
 * Tests for the variant parity guard.
 *
 * A guard is only worth its green tick while it still catches what it claims to. These drive the
 * guard's own parsing against synthetic sources and a synthetic migration directory, so the cases
 * that matter — a commented-out entry, a forward migration, a constraint replaced rather than
 * edited — are pinned without touching the real tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  stripComments,
  splitStatements,
  extractRegion,
  migrationFiles,
  effectiveLookupVariants,
  effectiveStudyVariantConstraint,
  effectiveStudyVariantForeignKey,
  collectMirrors,
  disagreements,
  ROOT,
  TS_MIRRORS,
  MIGRATIONS_DIR,
} from '../check-variant-parity.mjs';

/** A throwaway migration directory. Files are named so the runner's ordering applies. */
function migrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'variant-parity-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, 'utf8');
  return dir;
}

test('a commented-out variant does not count as present', () => {
  // The defect this replaced: quoted tokens were matched in raw source, so commenting an entry out
  // left the guard green while the executable array no longer held it. Raised in the Qodo review of
  // PR #141.
  const region = (body) =>
    extractRegion({
      label: 'test',
      file: 'test.ts',
      open: /export const VARIANTS: readonly Variant\[\] = \[/,
      close: /\]/,
      text: `export const VARIANTS: readonly Variant[] = [\n${body}\n];`,
    }).variants;

  assert.deepEqual(region("  'standard',\n  'atomic',"), ['standard', 'atomic']);
  assert.deepEqual(region("  'standard',\n  // 'atomic',"), ['standard'], 'line comment');
  assert.deepEqual(region("  'standard',\n  /* 'atomic', */"), ['standard'], 'block comment');
  assert.deepEqual(
    region("  'standard',\n  'atomic', // keep this one"),
    ['standard', 'atomic'],
    'a trailing comment does not remove the entry beside it',
  );
});

test('a comment marker inside a string literal is not a comment', () => {
  assert.equal(stripComments(`const a = 'http://x'; // gone`, 'ts').trim(), `const a = 'http://x';`);
  assert.equal(stripComments(`SELECT '--x'; -- gone`, 'sql').trim(), `SELECT '--x';`);
});

test('the lookup table is the sum of every migration, not the contents of 0001', () => {
  // Applied migrations are checksummed and immutable (`pg/migrate.ts`), so a ninth variant arrives
  // in a NEW file. A guard that read 0001 directly would fail forever on the correct change and
  // could only be satisfied by editing an applied migration. Raised in the Qodo review of PR #141.
  const dir = migrations({
    '0001_init.sql': `CREATE TABLE variants (code TEXT PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO variants (code, name) VALUES
  ('standard', 'Standard'),
  ('atomic',   'Atomic');`,
    '0023_add_antichess.sql': `INSERT INTO variants (code, name) VALUES ('antichess', 'Antichess');`,
  });
  try {
    assert.deepEqual(effectiveLookupVariants(dir), ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations replay in the order the runner applies them, which is lexicographic', () => {
  // `pg/migrate.ts` sorts with a plain `.sort()`, so that is the order the database ends up in and
  // the order this must model. Zero-padded names make lexicographic and numeric order coincide, so
  // the filenames here are deliberately *not* padded: `10_` sorts before `9_`, and a guard that
  // sorted numerically instead would replay a database that never existed. The earlier version of
  // this test used `0009_`/`0010_`, which sort the same either way and so proved nothing about the
  // ordering it claimed to pin. Raised in the CodeRabbit review of PR #141.
  const dir = migrations({
    '9_late.sql': `INSERT INTO variants (code, name) VALUES ('nine', 'Nine');`,
    '10_early.sql': `INSERT INTO variants (code, name) VALUES ('ten', 'Ten');`,
  });
  try {
    assert.deepEqual(migrationFiles(dir), ['10_early.sql', '9_late.sql'], 'the runner order');
    assert.deepEqual(effectiveLookupVariants(dir), ['ten', 'nine']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The guard replays migrations in exactly the order the runner does.
 *
 * Pinned against the runner's own source rather than restated, so the two cannot drift apart
 * silently: a change to `migrate.ts`'s sort has to be made here too, or this fails. The whole guard
 * is worthless if it reads the migrations in a different order from the code it is guarding, and
 * nothing else would notice.
 *
 * The expression lives in `migrationFiles` now, which the runner and the readiness probe share, so
 * the chained `.map` that attaches each file's version is allowed after it. What is still pinned is
 * the property that matters: `.sort()` with no comparator, ordering by filename exactly as this
 * guard does.
 */
test('the guard replays migrations in exactly the order the runner does', () => {
  const runner = readFileSync('packages/persistence/src/pg/migrate.ts', 'utf8');
  assert.match(
    runner,
    /readdirSync\(dir\)\s*\.filter\(\(f\) => f\.endsWith\('\.sql'\)\)\s*\.sort\(\)\s*(?:;|\.map\()/,
    'migrate.ts still sorts migration files with a plain lexicographic .sort()',
  );
});

test('only statements that target `studies` decide its constraint', () => {
  // The file was previously tested as a whole, so any other table in it could move the answer — a
  // `variant` CHECK elsewhere would overwrite the studies one, and a `REFERENCES variants(code)`
  // elsewhere would clear it, silently dropping the mirror. Raised in the CodeRabbit review of
  // PR #141.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_other_table.sql': `CREATE TABLE puzzle_sets (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL REFERENCES variants(code)
);
ALTER TABLE studies ADD COLUMN tag TEXT;
CREATE TABLE bot_profiles (
  id UUID PRIMARY KEY,
  variant TEXT NOT NULL CHECK (variant IN ('standard'))
);`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.notEqual(found, null, 'the studies constraint must survive an unrelated table');
    assert.equal(found.file, '0022_study_variant.sql');
    assert.deepEqual(found.variants, ['standard', 'atomic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a semicolon inside a string literal does not split a statement', () => {
  assert.deepEqual(
    splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`).map((s) => s.trim()),
    [`INSERT INTO t VALUES ('a;b')`, `SELECT 1`],
  );
});

test('a statement the guard cannot model fails loudly rather than reporting a stale schema', () => {
  const dir = migrations({
    '0001_init.sql': `INSERT INTO variants (code, name) VALUES ('standard', 'Standard');`,
    '0024_retire.sql': `DELETE FROM variants WHERE code = 'standard';`,
  });
  try {
    assert.throws(() => effectiveLookupVariants(dir), /does not model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the study constraint is the last one defined, so it can be replaced not edited', () => {
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_add_antichess.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE studies ADD CONSTRAINT studies_variant_check
  CHECK (variant IN ('standard', 'atomic', 'antichess'));`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.equal(found.file, '0023_add_antichess.sql');
    assert.deepEqual(found.variants, ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`ALTER TABLE IF EXISTS studies` is recognised, not skipped', () => {
  // Valid PostgreSQL, and a migration is exactly where the defensive form gets written. Skipping it
  // left the guard comparing against the constraint that statement had just replaced. Raised in the
  // CodeRabbit review of PR #141.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_defensive.sql': `ALTER TABLE IF EXISTS studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE IF EXISTS ONLY studies ADD CONSTRAINT studies_variant_check
  CHECK (variant IN ('standard', 'atomic', 'antichess'));`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.equal(found.file, '0023_defensive.sql');
    assert.deepEqual(found.variants, ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a constraint is dropped by its exact name, whatever that name is', () => {
  // `DROP CONSTRAINT allowed_codes` is a perfectly ordinary way to remove a CHECK on
  // `studies.variant`. Matching names that merely contain "variant" missed it and left the guard
  // comparing against a constraint the schema no longer has. Raised in the CodeRabbit review of
  // PR #141.
  const named = `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CONSTRAINT allowed_codes CHECK (variant IN ('standard', 'atomic'));`;

  // Dropped and not replaced, so nothing downstream can paper over a missed clear: if the drop is
  // not recognised the constraint is still reported as live.
  const droppedOnly = migrations({
    '0022_study_variant.sql': named,
    '0023_drop.sql': `ALTER TABLE studies DROP CONSTRAINT allowed_codes;`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(droppedOnly), null);
  } finally {
    rmSync(droppedOnly, { recursive: true, force: true });
  }

  const replaced = migrations({
    '0022_study_variant.sql': named,
    '0023_drop.sql': `ALTER TABLE studies DROP CONSTRAINT allowed_codes;
ALTER TABLE studies ADD CONSTRAINT variant_codes
  CHECK (variant IN ('standard', 'atomic', 'antichess'));`,
  });
  try {
    const found = effectiveStudyVariantConstraint(replaced);
    assert.equal(found.name, 'variant_codes');
    assert.deepEqual(found.variants, ['standard', 'atomic', 'antichess']);
  } finally {
    rmSync(replaced, { recursive: true, force: true });
  }
});

test('dropping an unrelated constraint does not clear the tracked one', () => {
  // The other half of exact-name matching: a constraint whose name happens to contain "variant"
  // must not be mistaken for the one governing the column.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_unrelated.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_label_length;`,
  });
  try {
    const found = effectiveStudyVariantConstraint(dir);
    assert.notEqual(found, null, 'the governing constraint must survive an unrelated drop');
    assert.deepEqual(found.variants, ['standard', 'atomic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unnamed CHECK is tracked under the name PostgreSQL gives it', () => {
  // Written without a name, the server calls it `studies_variant_check` — so that is the name a
  // later migration has to drop, and the name the guard has to be tracking.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir).name, 'studies_variant_check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renaming the governing constraint fails loudly rather than tracking a dead name', () => {
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0023_rename.sql': `ALTER TABLE studies
  RENAME CONSTRAINT studies_variant_check TO allowed_codes;`,
  });
  try {
    assert.throws(() => effectiveStudyVariantConstraint(dir), /RENAME CONSTRAINT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('converting the study column to a foreign key leaves no list to compare', () => {
  // The conversion recorded as a candidate in PROJECT_STATE. Once `studies.variant` derives from
  // `variants(code)` there is no second list, and the guard must not go on demanding one.
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0025_study_variant_fk.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;
ALTER TABLE studies ADD CONSTRAINT studies_variant_fk
  FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed migrations directory leaves studies.variant derived from foreign key with no CHECK', () => {
  assert.equal(effectiveStudyVariantConstraint(MIGRATIONS_DIR), null);
  assert.equal(effectiveStudyVariantForeignKey(MIGRATIONS_DIR), true);
});

test('dropping the CHECK without adding a foreign key leaves effectiveStudyVariantForeignKey false', () => {
  const dir = migrations({
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0025_drop_only.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
  });
  try {
    assert.equal(effectiveStudyVariantConstraint(dir), null);
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks named foreign keys through drop and rename', () => {
  const dir = migrations({
    '0001_fk.sql': `ALTER TABLE studies ADD CONSTRAINT custom_fk FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0002_rename.sql': `ALTER TABLE studies RENAME CONSTRAINT custom_fk TO renamed_fk;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping under the old name does nothing because it was renamed
    writeFileSync(join(dir, '0003_drop_old.sql'), `ALTER TABLE studies DROP CONSTRAINT custom_fk;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping under the new name clears active FK
    writeFileSync(join(dir, '0004_drop_new.sql'), `ALTER TABLE studies DROP CONSTRAINT renamed_fk;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks multiple foreign keys independently when one is dropped', () => {
  const dir = migrations({
    '0001_fk1.sql': `ALTER TABLE studies ADD CONSTRAINT fk_one FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0002_fk2.sql': `ALTER TABLE studies ADD CONSTRAINT fk_two FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping fk_one leaves fk_two active
    writeFileSync(join(dir, '0003_drop_one.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_one;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    // Dropping fk_two clears all
    writeFileSync(join(dir, '0004_drop_two.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_two;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks multiple foreign keys added in a single comma-separated statement', () => {
  const dir = migrations({
    '0001_multi_add.sql': `ALTER TABLE studies
      ADD CONSTRAINT fk_alpha FOREIGN KEY (variant) REFERENCES variants(code),
      ADD CONSTRAINT fk_beta FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    writeFileSync(join(dir, '0002_drop_alpha.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_alpha;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    writeFileSync(join(dir, '0003_drop_beta.sql'), `ALTER TABLE studies DROP CONSTRAINT fk_beta;`, 'utf8');
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey clears active foreign keys when variant column is renamed', () => {
  const dir = migrations({
    '0001_inline.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_col.sql': `ALTER TABLE studies RENAME COLUMN variant TO old_variant;`,
    '0003_readd_unconstrained.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey and effectiveStudyVariantConstraint clear state when studies table is dropped or renamed', () => {
  const dropDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_drop_table.sql': `DROP TABLE studies;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dropDir), false);
    assert.equal(effectiveStudyVariantConstraint(dropDir), null);
  } finally {
    rmSync(dropDir, { recursive: true, force: true });
  }

  const renameDir = migrations({
    '0001_initial.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
    '0002_rename_table.sql': `ALTER TABLE studies RENAME TO old_studies;`,
    '0003_recreate_unconstrained.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(renameDir), false);
    assert.equal(effectiveStudyVariantConstraint(renameDir), null);
  } finally {
    rmSync(renameDir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey recognizes inline column references on studies', () => {
  const dir = migrations({
    '0001_inline.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey tracks explicit inline constraint names and clears on drop', () => {
  const dir = migrations({
    '0001_inline_named.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL CONSTRAINT custom_inline_fk REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
    writeFileSync(
      join(dir, '0002_drop_inline.sql'),
      `ALTER TABLE studies DROP CONSTRAINT custom_inline_fk;`,
      'utf8',
    );
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey handles multiple DROP CONSTRAINT clauses in a single statement', () => {
  const dir = migrations({
    '0001_fk.sql': `ALTER TABLE studies ADD CONSTRAINT custom_fk FOREIGN KEY (variant) REFERENCES variants(code);`,
    '0002_multi_drop.sql': `ALTER TABLE studies DROP CONSTRAINT unrelated_constraint, DROP CONSTRAINT custom_fk;`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantForeignKey does not match subsequent column referencing variants', () => {
  const dir = migrations({
    '0001_distinct_columns.sql': `CREATE TABLE studies (
      id UUID PRIMARY KEY,
      variant TEXT NOT NULL,
      source TEXT REFERENCES variants(code)
    );`,
  });
  try {
    assert.equal(effectiveStudyVariantForeignKey(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effectiveStudyVariantConstraint preserves active CHECK constraint when FK is added without dropping CHECK', () => {
  const dir = migrations({
    '0001_check.sql': `ALTER TABLE studies ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard' CHECK (variant IN ('standard', 'atomic'));`,
    '0002_fk.sql': `ALTER TABLE studies ADD CONSTRAINT studies_variant_fk FOREIGN KEY (variant) REFERENCES variants(code);`,
  });
  try {
    const check = effectiveStudyVariantConstraint(dir);
    assert.notEqual(check, null);
    assert.deepEqual(check.variants, ['standard', 'atomic']);
    assert.equal(effectiveStudyVariantForeignKey(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectMirrors exposes whether effective studies.variant foreign key is present', () => {
  const committed = collectMirrors(MIGRATIONS_DIR);
  assert.equal(committed.studyConstraint, null);
  assert.equal(committed.hasStudyVariantFk, true);

  const dropOnlyDir = migrations({
    '0001_variants.sql': `INSERT INTO variants (code) VALUES ('standard');`,
    '0022_study_variant.sql': `ALTER TABLE studies
  ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard'
  CHECK (variant IN ('standard', 'atomic'));`,
    '0025_drop_only.sql': `ALTER TABLE studies DROP CONSTRAINT studies_variant_check;`,
  });
  try {
    const dropOnly = collectMirrors(dropOnlyDir);
    assert.equal(dropOnly.studyConstraint, null);
    assert.equal(dropOnly.hasStudyVariantFk, false);
  } finally {
    rmSync(dropOnlyDir, { recursive: true, force: true });
  }
});

test('a renamed declaration fails loudly instead of checking nothing', () => {
  // The failure mode that makes a guard worse than no guard: it keeps passing having stopped
  // looking at anything.
  assert.throws(
    () => extractRegion({ ...ROOT, text: 'export type RuleSet =\n  | "standard";' }),
    /could not find its declaration/,
  );
});

test('disagreements name what is wrong, in both directions', () => {
  assert.deepEqual(disagreements(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(disagreements(['a', 'b'], ['a']), ['missing `b`']);
  assert.deepEqual(disagreements(['a'], ['a', 'z']), ['unknown `z`']);
  assert.deepEqual(disagreements(['a'], ['a', 'a']), ['duplicated `a`']);
});

test('every mirror the guard claims to read is really there', () => {
  // Pins the specs against the real tree, so a file move breaks this rather than the CI job.
  for (const spec of [ROOT, ...TS_MIRRORS]) {
    const found = extractRegion(spec);
    assert.ok(found.variants.length > 0, `${spec.label} yielded no variants`);
    assert.ok(found.variants.includes('standard'), `${spec.label} is missing 'standard'`);
  }
});
