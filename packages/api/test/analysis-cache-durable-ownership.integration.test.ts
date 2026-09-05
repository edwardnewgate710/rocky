/**
 * What `analysis-cache-durable.integration.test.ts` owes the database it runs against.
 *
 * That suite drives the production cache composition against a real PostgreSQL server, and it made
 * two assumptions about the database that nothing enforced: that `engine_analysis_cache` already
 * existed, and that the rows it wrote were somebody else's problem. Both held only by accident of
 * ordering — the persistence package's suites migrate `DATABASE_URL` and run first in both the root
 * `test` script and the `postgres-integration` CI job — and neither is visible from inside the
 * suite itself, which is why this file sits beside it rather than in it.
 *
 * Measured against the code this replaced: on a genuinely fresh database the suite failed 6 of its
 * 10 tests, three of them by throwing SQLSTATE 42P01 from its own statements and three by asserting
 * on a durable row that was never written — because the cache absorbs a missing table as a fault
 * and degrades to computing, so a suite about durability went on running with no durability at all.
 * On a migrated database it passed, and left 5 rows behind every time it did.
 *
 * Both readings have to be taken from outside the suite. Its identities are minted per run, so no
 * residue it leaves ever collides with anything it later asks for, and every assertion it makes
 * passes on the hundredth run exactly as on the first.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { migrate, migrationsDir } from '@chess-platform/persistence/pg';
import { withTestDatabase } from '@chess-platform/persistence/test-support';
import type { Pool } from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

const SUITE = join(__dirname, 'analysis-cache-durable.integration.test.js');
/** Resolved by the package that ships them, so it is right whatever the working directory is. */
const MIGRATIONS = migrationsDir();
/** Deliberately not `packages/api` — see `runSuiteAgainst`. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const run = promisify(execFile);

/**
 * The environment the suite under test runs in, as a fresh test-runner process.
 *
 * `NODE_TEST_CONTEXT` has to go. Node sets it inside a test process, and a child that inherits it
 * believes it is a nested runner: it declines to execute the file at all, warns that `run()` was
 * called recursively, and exits 0 having produced nothing. Inheriting it would make both tests here
 * pass for the worst possible reason — a suite that never ran neither fails nor leaves residue.
 *
 * The reporter is pinned for the same class of reason. Node chooses `spec` or `tap` by whether
 * stdout is a TTY, and only `tap` prints the counts read below, so leaving the choice to the
 * environment would make these checks depend on how the outer suite happened to be invoked.
 */
function childEnv(connectionString: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: connectionString };
  delete env['NODE_TEST_CONTEXT'];
  return env;
}

/**
 * One `# key N` line of a TAP summary, or `undefined` when the run produced no such line.
 *
 * `\r?` because this runs on Windows too, where a carriage return sits between the digits and the
 * line end that `$` matches — without it every count reads as absent and every assertion below
 * fails for a reason that has nothing to do with the database.
 */
function tally(stdout: string, key: string): number | undefined {
  const match = new RegExp(`^# ${key} (\\d+)\\r?$`, 'm').exec(stdout);
  return match ? Number(match[1]) : undefined;
}

/**
 * Run the suite under test against `connectionString`, and insist it really ran.
 *
 * `# fail 0` alone is not evidence: a run that executed nothing prints it, and so does a run whose
 * every test self-skipped because `DATABASE_URL` never reached the child. The other counts are what
 * separate "passed" from "did not happen" — every test that ran passed, none were skipped, and at
 * least one ran. Not `# pass 10`: the count is a property of the other file, and pinning it here
 * would make adding a test there a failure in this one, which is not a fact about the database.
 *
 * The child runs from the repository root, not from `packages/api`. That is the point: the suite
 * has to find the migrations it applies from its own location, so a working directory it does not
 * control cannot decide whether its schema gets built.
 */
async function runSuiteAgainst(connectionString: string, ...extraArgs: string[]): Promise<void> {
  const child = await run(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap', ...extraArgs, SUITE],
    { cwd: REPO_ROOT, env: childEnv(connectionString) },
  ).catch((error: unknown) => {
    // The child's own report, not just "command failed": a non-zero exit is where the interesting
    // detail lives, and `execFile` puts it on the rejection rather than in the message.
    const output = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`the suite under test must pass against this database:\n${detail}\n${output}`);
  });

  assert.equal(tally(child.stdout, 'fail'), 0, 'the suite under test reported a failure');
  assert.equal(tally(child.stdout, 'skipped'), 0, 'a skipped suite proves nothing about the database');
  assert.ok((tally(child.stdout, 'pass') ?? 0) > 0, 'the suite under test ran no tests at all');
  assert.equal(
    tally(child.stdout, 'pass'),
    tally(child.stdout, 'tests'),
    'every test the child started must also have finished',
  );
}

/**
 * Every row of `engine_analysis_cache` by identity, ordered in SQL so two readings compare directly.
 *
 * Identity rather than count: a count would let a cleanup that removed one row and left another
 * compare equal, and could not show *which* row a too-broad delete took.
 */
async function readCacheRows(pool: Pool): Promise<string[]> {
  const rows = await pool.query<{ value: string }>(
    `SELECT fingerprint || ':' || variant || ':' || multi_pv::text || ':' || fen AS value
       FROM engine_analysis_cache ORDER BY fingerprint, variant, multi_pv, fen`,
  );
  return rows.rows.map((row) => row.value);
}

/**
 * The suite has to work on a database no other test has prepared for it.
 *
 * `withTestDatabase` hands back a database that has been created and nothing else — no migrations,
 * no rows — which is exactly the condition the defect needed: the fresh server a developer starts
 * for one file, and the state a CI job would be in if it ever ran this suite without the
 * persistence package ahead of it. Nothing here tells the child what schema to build; that the
 * child arrives at a working one is the whole assertion.
 */
test('the durable cache suite passes against a database nothing else has prepared', { skip }, async () => {
  await withTestDatabase(
    async ({ pool, connectionString }) => {
      await runSuiteAgainst(connectionString);

      // Nothing but the child ever touched this database, so anything in the table is its residue —
      // and the table exists to be read only because the child built it, which is the other half of
      // the claim. The check below is worth making here as well as on a migrated database: cleanup
      // and schema establishment are different code, and the fresh path is the one nothing else
      // covers.
      assert.deepEqual(await readCacheRows(pool), [], 'the suite must leave a fresh database empty');
    },
    { connectionString: DATABASE_URL, max: 2 },
  );
});

/**
 * And any one of its tests can be the only one that runs.
 *
 * Establishing the schema in the first test would satisfy the check above while leaving every other
 * test dependent on that one having gone first — the same defect at a smaller scale, and the shape
 * a developer meets first, because `--test-name-pattern` is how you rerun the one test that failed.
 * The last test in the file is the subject here: it is the furthest from any setup the first test
 * might have done, and it both reads and writes the table.
 */
test('any single test of the durable cache suite can run alone on a fresh database', { skip }, async () => {
  await withTestDatabase(
    async ({ connectionString }) => {
      await runSuiteAgainst(
        connectionString,
        '--test-name-pattern',
        'the retention sweep runs against the composed cache',
      );
    },
    { connectionString: DATABASE_URL, max: 2 },
  );
});

/**
 * And it hands the table back exactly as it found it.
 *
 * The stranger row is the half a residue check on its own would miss. "The suite removed its own
 * rows" and "the suite emptied the table" are the same reading unless something it does not own is
 * sitting there to tell them apart — and an unqualified `DELETE FROM engine_analysis_cache` would
 * satisfy every assertion the suite makes about itself while destroying a concurrent suite's
 * fixture.
 */
test('the durable cache suite leaves engine_analysis_cache exactly as it found it', { skip }, async () => {
  await withTestDatabase(
    async ({ pool, connectionString }) => {
      await migrate(pool, MIGRATIONS);
      // `achieved_depth` is not decoration: 0026 refuses a row whose three achieved_* columns are
      // all NULL, because such a row could never answer any request.
      await pool.query(
        `INSERT INTO engine_analysis_cache
           (fingerprint, variant, multi_pv, fen, achieved_depth, payload_version, results,
            created_at, updated_at)
         VALUES ('stranger-fingerprint', 'standard', 1, $1, 10, 1, '[]'::jsonb, now(), now())`,
        ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
      );

      const before = await readCacheRows(pool);
      await runSuiteAgainst(connectionString);

      assert.deepEqual(
        await readCacheRows(pool),
        before,
        'the suite must remove every row it wrote, and only those',
      );
    },
    { connectionString: DATABASE_URL, max: 2 },
  );
});
