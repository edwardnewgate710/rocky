import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMigration } from '../src/pg/migrate';

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
  const sql = readFileSync(
    join(process.cwd(), 'migrations', '0023_community_pending_join_requests_index.sql'),
    'utf8',
  );

  assert.deepEqual(parseMigration(sql), {
    kind: 'online-index',
    indexName: 'community_join_requests_pending_by_player_idx',
    sql: `CREATE INDEX CONCURRENTLY community_join_requests_pending_by_player_idx
    ON community_join_requests (player_id, created_at DESC, id ASC)
    WHERE status = 'pending';`,
  });
});
