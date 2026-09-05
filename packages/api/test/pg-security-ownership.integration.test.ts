import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { uuidv7 } from '@chess-platform/persistence';
import { migrate } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import { withSharedDatabase } from '@chess-platform/persistence/test-support/fixtures';
import type { Pool } from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/** `packages/api`, which is the working directory the suite under test resolves migrations from. */
const API_ROOT = join(__dirname, '..', '..');
const SUITE = join(__dirname, 'pg-security.integration.test.js');
const MIGRATIONS = join(API_ROOT, '../persistence/migrations');

const run = promisify(execFile);

/**
 * Every row in the tables `pg-security.integration.test.ts` writes to, by identity rather than by
 * count.
 *
 * Counts alone would let a cleanup that deleted one row and created another compare equal, and
 * they cannot show *which* row went missing when a delete is too broad. Ordered so two readings
 * compare directly with `deepEqual`.
 */
interface OwnedState {
  readonly users: string[];
  readonly credentials: string[];
  readonly roles: string[];
  readonly sessions: string[];
  readonly buckets: string[];
}

/**
 * Take that reading from `pool`.
 *
 * The ordering is done in SQL rather than in JavaScript so that both readings are ordered by the
 * same rule the database applies, instead of by whatever order rows happened to come back in.
 */
async function readOwnedState(pool: Pool): Promise<OwnedState> {
  const column = async (sql: string): Promise<string[]> =>
    (await pool.query<{ value: string }>(sql)).rows.map((row) => row.value);
  return {
    users: await column('SELECT id::text AS value FROM users ORDER BY id'),
    credentials: await column(
      "SELECT user_id::text || ':' || kind AS value FROM credentials ORDER BY user_id, kind",
    ),
    roles: await column(
      "SELECT user_id::text || ':' || role AS value FROM roles ORDER BY user_id, role",
    ),
    sessions: await column('SELECT id::text AS value FROM sessions ORDER BY id'),
    buckets: await column('SELECT bucket_key AS value FROM rate_limit_buckets ORDER BY bucket_key'),
  };
}

/**
 * Rows standing in for a different suite's fixtures, so that "cleanup removed its own rows" and
 * "cleanup removed everything" cannot both pass.
 *
 * The bucket key carries the same `integration:` prefix the suite under test uses for its own
 * keys. That is the point: it is the row a prefix-matching cleanup would take, and it belongs to
 * someone else.
 */
async function insertSentinels(pool: Pool): Promise<void> {
  const userId = uuidv7();
  await pool.query('INSERT INTO users (id, handle) VALUES ($1, $2)', [userId, `sentinel${uuidv7().replaceAll('-', '').slice(0, 12)}`]);
  await pool.query('INSERT INTO credentials (user_id, kind, secret_hash) VALUES ($1, $2, $3)', [userId, 'password', 'sentinel-hash']);
  await pool.query('INSERT INTO roles (user_id, role) VALUES ($1, $2)', [userId, 'user']);
  await pool.query(
    'INSERT INTO sessions (id, user_id, refresh_hash, expires_at) VALUES ($1, $2, $3, now() + $4::interval)',
    [uuidv7(), userId, `sentinel-${uuidv7()}`, '1 day'],
  );
  await pool.query(
    'INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at) VALUES ($1, 1, now(), now() + $2::interval)',
    [`integration:sentinel:${uuidv7()}`, '1 day'],
  );
}

/**
 * The environment the suite under test runs in, as a fresh test-runner process.
 *
 * `NODE_TEST_CONTEXT` has to go. Node sets it inside a test process, and a child that inherits it
 * believes it is a nested runner: it declines to execute the file at all, warns that `run()` was
 * called recursively, and exits 0 having produced nothing. Inheriting it would make this test pass
 * for the worst possible reason — a suite that never ran leaves no residue either.
 *
 * The reporter is pinned for the same class of reason. Node chooses `spec` or `tap` by whether
 * stdout is a TTY, and only `tap` prints the `# fail` line this test reads, so leaving the choice
 * to the environment would make the check depend on how the outer suite happened to be invoked.
 */
function childEnv(connectionString: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: connectionString };
  delete env['NODE_TEST_CONTEXT'];
  return env;
}

/**
 * The suite under test must hand the database back exactly as it received it.
 *
 * This runs the real compiled suite as a child process against a database of its own, because the
 * defect is not something the suite can observe about itself: every identifier it creates is a
 * fresh `uuidv7()`, so nothing it leaves behind ever collides and every one of its assertions
 * passes just as well on the hundredth run as on the first. Only a reading taken from outside,
 * before and after, can tell a suite that cleaned up from one that merely did not collide.
 *
 * Against the code this replaced, one pass left 25 rows behind: 4 users, 4 credentials, 4 roles,
 * 4 sessions and 9 rate-limit buckets.
 */
test('the pg-security suite leaves the database exactly as it found it', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);
    await insertSentinels(pool);

    const before = await readOwnedState(pool);

    const child = await run(
      process.execPath,
      ['--test', '--test-concurrency=1', '--test-reporter=tap', SUITE],
      { cwd: API_ROOT, env: childEnv(connectionString) },
    ).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      assert.fail(`the suite under test must pass before its residue can be judged:\n${detail}`);
    });
    assert.match(child.stdout, /# fail 0/, 'the suite under test reported a failure');

    const after = await readOwnedState(pool);
    assert.deepEqual(after, before, 'the suite must remove every row it created, and only those');
  }, { connectionString: DATABASE_URL, max: 4 });
});

/**
 * Cleanup runs on the failure path too, and the failure the developer sees is still their own.
 *
 * A suite that only cleans up when it passes leaks precisely on the runs that matter — a failing
 * assertion is when someone reruns most often, and each rerun would add another set of rows. The
 * body here creates a row and then throws, which is also the ordering hazard the cleanup design
 * turns on: the identifier is recorded before the insert, so it is still owned when the throw
 * skips everything after it.
 */
test('a failing test still surrenders the rows it created, and still reports its own error', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);
    const before = await readOwnedState(pool);

    const keys: string[] = [];
    const boom = new Error('the assertion the developer needs to see');
    await assert.rejects(
      () =>
        withSharedDatabase(
          {
            connectionString,
            cleanup: async (cleanupPool) => {
              await cleanupPool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [[...keys]]);
            },
          },
          async (bodyPool) => {
            const key = `integration:failing:${uuidv7()}`;
            keys.push(key);
            await bodyPool.query(
              'INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at) VALUES ($1, 1, now(), now() + $2::interval)',
              [key, '1 day'],
            );
            throw boom;
          },
        ),
      (error: unknown) => {
        assert.equal(error, boom, 'the body error must reach the caller unchanged');
        return true;
      },
    );

    assert.deepEqual(await readOwnedState(pool), before, 'a failing body must not leave its rows behind');
  }, { connectionString: DATABASE_URL, max: 4 });
});

/**
 * Cleanup takes the keys it was given and not the ones that merely look like them.
 *
 * `integration:` is a naming convention shared by several suites, so a cleanup written as
 * `LIKE 'integration:%'` would pass every test in the suite under test while deleting a
 * concurrent suite's buckets. Nothing else in this file would notice: the suite's own rows would
 * still be gone, which is all its assertions ask about.
 */
test('bucket cleanup removes the keys it owns and leaves same-prefix strangers alone', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrate(pool, MIGRATIONS);

    const stranger = `integration:stranger:${uuidv7()}`;
    await pool.query(
      'INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at) VALUES ($1, 1, now(), now() + $2::interval)',
      [stranger, '1 day'],
    );
    const before = await readOwnedState(pool);

    const keys: string[] = [];
    await withSharedDatabase(
      {
        connectionString,
        cleanup: async (cleanupPool) => {
          await cleanupPool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [[...keys]]);
        },
      },
      async (bodyPool) => {
        const key = `integration:owned:${uuidv7()}`;
        keys.push(key);
        await bodyPool.query(
          'INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at) VALUES ($1, 1, now(), now() + $2::interval)',
          [key, '1 day'],
        );
      },
    );

    assert.deepEqual(await readOwnedState(pool), before, 'only the owned key may be removed');
    const survivor = await pool.query('SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1', [stranger]);
    assert.equal(survivor.rowCount, 1, "another suite's bucket must survive");
  }, { connectionString: DATABASE_URL, max: 4 });
});
