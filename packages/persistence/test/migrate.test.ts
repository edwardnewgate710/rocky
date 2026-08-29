import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeMigrationSql,
  migrationChecksum,
  parseMigration,
  readMigrationSql,
} from '../src/pg/migrate';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const PENDING_JOIN_REQUESTS = '0023_community_pending_join_requests_index.sql';

const LF_MIGRATION = 'CREATE TABLE example (id INTEGER);\nINSERT INTO example VALUES (1);\n';
const asCrlf = (sql: string): string => sql.replace(/\n/g, '\r\n');

/**
 * Write `content` verbatim into a throwaway directory and read it back through
 * the runner's canonical reader. The fixture is written as a Buffer so it has
 * exactly the requested line endings whatever the host OS does — these tests
 * assert cross-platform behaviour and must not depend on the machine they run
 * on, nor on the developer's `core.autocrlf`.
 */
function readAsMigration(content: string, file = '0001_fixture.sql'): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-eol-'));
  try {
    writeFileSync(join(dir, file), Buffer.from(content, 'utf8'));
    return readMigrationSql(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function committedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

test('migrations are transactional by default', () => {
  assert.deepEqual(parseMigration('CREATE TABLE example (id INTEGER);'), {
    kind: 'transactional',
    sql: 'CREATE TABLE example (id INTEGER);',
  });
});

test('online-index migrations require one matching concurrent index statement', () => {
  assert.deepEqual(
    parseMigration(`-- migrate:online-index example_owner_idx
CREATE INDEX CONCURRENTLY example_owner_idx ON example (owner_id);`),
    {
      kind: 'online-index',
      indexName: 'example_owner_idx',
      sql: 'CREATE INDEX CONCURRENTLY example_owner_idx ON example (owner_id);',
    },
  );

  assert.throws(
    () =>
      parseMigration(`-- migrate:online-index declared_idx
CREATE INDEX CONCURRENTLY different_idx ON example (owner_id);`),
    /must match declared index declared_idx/,
  );
  assert.throws(
    () =>
      parseMigration(`-- migrate:online-index example_owner_idx
CREATE INDEX CONCURRENTLY example_owner_idx ON example (owner_id);
SELECT 1;`),
    /exactly one CREATE INDEX CONCURRENTLY statement/,
  );
});

test('pending join-request lookup is installed as an online index', () => {
  assert.deepEqual(parseMigration(readMigrationSql(MIGRATIONS_DIR, PENDING_JOIN_REQUESTS)), {
    kind: 'online-index',
    indexName: 'community_join_requests_pending_by_player_idx',
    sql: `CREATE INDEX CONCURRENTLY community_join_requests_pending_by_player_idx
    ON community_join_requests (player_id, created_at DESC, id ASC)
    WHERE status = 'pending';`,
  });
});

test('canonical migration text carries no CR whatever the checkout did', () => {
  // The assertion above used to fail on a Windows checkout because the working
  // tree holds CRLF; reading canonically is what makes it platform-independent.
  const raw = readFileSync(join(MIGRATIONS_DIR, PENDING_JOIN_REQUESTS), 'utf8');
  const canonical = readMigrationSql(MIGRATIONS_DIR, PENDING_JOIN_REQUESTS);

  assert.equal(canonical.includes('\r'), false);
  assert.equal(canonical, canonicalizeMigrationSql(raw));
});

test('a CRLF checkout yields the same canonical text and checksum as an LF one', () => {
  const lf = readAsMigration(LF_MIGRATION);
  const crlf = readAsMigration(asCrlf(LF_MIGRATION));

  assert.equal(lf, LF_MIGRATION);
  assert.equal(crlf, lf);
  assert.equal(migrationChecksum(crlf), migrationChecksum(lf));
});

test('mixed CRLF/LF line endings collapse to the same canonical text', () => {
  const mixed = 'CREATE TABLE example (id INTEGER);\r\nINSERT INTO example VALUES (1);\n';

  assert.equal(readAsMigration(mixed), LF_MIGRATION);
  assert.equal(migrationChecksum(readAsMigration(mixed)), migrationChecksum(LF_MIGRATION));
});

test('canonicalization rewrites the CRLF pair and nothing else', () => {
  // A lone CR is file content, not a checkout artifact: Git never introduces it.
  assert.equal(canonicalizeMigrationSql('a\rb'), 'a\rb');
  // Indentation, blank lines and trailing spaces are content too.
  assert.equal(canonicalizeMigrationSql('a\r\n\r\n  b  \r\n'), 'a\n\n  b  \n');
  assert.equal(canonicalizeMigrationSql(LF_MIGRATION), LF_MIGRATION);

  const once = canonicalizeMigrationSql(asCrlf(LF_MIGRATION));
  assert.equal(canonicalizeMigrationSql(once), once, 'canonicalization must be idempotent');
});

test('a migration missing its final newline stays distinct from one that has it', () => {
  const withNewline = readAsMigration(LF_MIGRATION);
  const withoutNewline = readAsMigration(LF_MIGRATION.trimEnd());

  assert.notEqual(withoutNewline, withNewline);
  assert.notEqual(migrationChecksum(withoutNewline), migrationChecksum(withNewline));
});

test('real content changes remain integrity violations under either line ending', () => {
  const baseline = migrationChecksum(readAsMigration(LF_MIGRATION));
  const mutations: Record<string, string> = {
    'changed keyword': LF_MIGRATION.replace('CREATE TABLE', 'CREATE UNLOGGED TABLE'),
    'changed column type': LF_MIGRATION.replace('id INTEGER', 'id BIGINT'),
    'added constraint': LF_MIGRATION.replace('id INTEGER', 'id INTEGER NOT NULL'),
    'deleted statement': 'CREATE TABLE example (id INTEGER);\n',
    'inserted statement': `${LF_MIGRATION}DROP TABLE example;\n`,
    'reordered statements':
      'INSERT INTO example VALUES (1);\nCREATE TABLE example (id INTEGER);\n',
    'changed literal': LF_MIGRATION.replace('VALUES (1)', 'VALUES (2)'),
    'whitespace-only edit': LF_MIGRATION.replace('(id INTEGER)', '( id INTEGER )'),
  };

  for (const [label, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, LF_MIGRATION, `${label}: mutation did not change the source`);
    assert.notEqual(
      migrationChecksum(readAsMigration(mutated)),
      baseline,
      `${label} must remain an integrity violation`,
    );
    assert.notEqual(
      migrationChecksum(readAsMigration(asCrlf(mutated))),
      baseline,
      `${label} must remain an integrity violation on a CRLF checkout`,
    );
  }
});

test('non-ASCII migration content is canonicalized deterministically as UTF-8', () => {
  const utf8 = "INSERT INTO example (label) VALUES ('café ♞ 日本');\n";

  assert.equal(readAsMigration(utf8), utf8);
  assert.equal(migrationChecksum(readAsMigration(asCrlf(utf8))), migrationChecksum(utf8));
  assert.notEqual(
    migrationChecksum(readAsMigration(utf8.replace('café', 'cafe'))),
    migrationChecksum(utf8),
  );
});

test('every committed migration hashes identically from either checkout form', () => {
  // Byte-level proof over the real migration history: the ledger checksum a
  // Linux CI run records is the one a Windows run records.
  const files = committedMigrations();
  assert.ok(files.length > 0, 'expected committed migrations');

  for (const file of files) {
    const canonical = readMigrationSql(MIGRATIONS_DIR, file);

    assert.equal(canonical.includes('\r'), false, `${file} still contains CR`);
    assert.equal(
      migrationChecksum(readAsMigration(asCrlf(canonical), file)),
      migrationChecksum(canonical),
      `${file} hashes differently from a CRLF checkout`,
    );
  }
});

test('every committed migration parses from either checkout form', () => {
  for (const file of committedMigrations()) {
    const canonical = readMigrationSql(MIGRATIONS_DIR, file);
    assert.deepEqual(
      parseMigration(readAsMigration(asCrlf(canonical), file)),
      parseMigration(canonical),
      `${file} parses differently from a CRLF checkout`,
    );
  }
});
