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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  stripComments,
  extractRegion,
  effectiveLookupVariants,
  effectiveStudyVariantConstraint,
  disagreements,
  ROOT,
  TS_MIRRORS,
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

test('migrations are summed in applied order, not lexicographic order', () => {
  const dir = migrations({
    '0009_a.sql': `INSERT INTO variants (code, name) VALUES ('nine', 'Nine');`,
    '0010_b.sql': `INSERT INTO variants (code, name) VALUES ('ten', 'Ten');`,
  });
  try {
    assert.deepEqual(effectiveLookupVariants(dir), ['nine', 'ten']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
