/**
 * The teardown contract for a disposable PostgreSQL database.
 *
 * This file exists because of a reproduced CI failure, not a hypothesis. `withDatabase` in
 * `variant-migrations.integration.test.ts` ended its pool and then immediately ran
 * `DROP DATABASE ... WITH (FORCE)`. Measured against pg 8.22.0: `pool.end()` resolves in the same
 * synchronous turn that `_remove` filters the last client out of `_clients`, while `client.end()`
 * has only queued the Terminate byte — zero of four `remove` events had fired at the moment `end()`
 * resolved. A drop issued straight afterwards could still find a backend attached, `FORCE`
 * terminated it, and the FATAL arrived on a socket whose pool still had `idleListener` attached.
 * `pg` re-emitted it as `pool.emit('error')`, which with no listener is an uncaught exception —
 * attributed by `node:test` to whichever test was running, never to the teardown that caused it.
 *
 * Measured against PostgreSQL 16.14, the two drops differ in exactly the way that matters: with a
 * backend still attached, plain `DROP DATABASE` fails with 55006 and leaves that connection
 * untouched, where `WITH (FORCE)` succeeds by killing it. The fix is therefore to wait for the
 * database to be unused and drop it ordinarily — a loud, harmless failure instead of a quiet,
 * harmful success.
 *
 * Nothing here asserts on elapsed wall-clock time. A test that waits 250ms and checks the clock is
 * measuring the machine; these observe the quiescence checks themselves, which is the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import type { Pool } from 'pg';
import {
  DatabaseTeardownTimeoutError,
  withTestDatabase,
  type LingeringBackend,
} from '../src/test-support/database';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/** Opens an admin connection to the configured server, never to a disposable database. */
async function admin(): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/** Whether the server still has a database of this name. */
async function databaseExists(name: string): Promise<boolean> {
  const client = await admin();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return rowCount === 1;
  } finally {
    await client.end();
  }
}

/** How many disposable databases the helper currently has on the server. */
async function countTestDatabases(): Promise<number> {
  const client = await admin();
  try {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_database WHERE datname LIKE 'test\\_db\\_%'",
    );
    return Number(rows[0]?.n ?? '0');
  } finally {
    await client.end();
  }
}

test('test database: a successful callback leaves no database behind', { skip }, async () => {
  let name = '';
  let poolRef: Pool | undefined;
  await withTestDatabase(async ({ pool, database }) => {
    name = database;
    poolRef = pool;
    await pool.query('SELECT 1');
    assert.equal(await databaseExists(database), true, 'the database exists while the callback runs');
  });

  assert.notEqual(name, '');
  assert.equal(await databaseExists(name), false, 'and is gone once the callback returns');

  // Teardown must end the pool *before* it decides the database is unused, not merely reach the
  // same state eventually. Without this, a teardown that never ended the pool still passes: `pg`
  // closes idle clients after `idleTimeoutMillis` (10s by default), so the quiescence wait drains
  // on its own and the only visible symptom is every test taking fifty times longer. `pool.end()`
  // rejecting on a second call is pg's own documented contract, which makes this a fact about the
  // pool rather than a measurement of the clock.
  await assert.rejects(
    poolRef!.end(),
    /more than once/,
    'teardown had already ended the pool it was handed',
  );
});

test('test database: a throwing callback still loses its database, and its own error', { skip }, async () => {
  let name = '';
  const thrown = new Error('the assertion this test actually cares about');

  await assert.rejects(
    withTestDatabase(async ({ pool, database }) => {
      name = database;
      await pool.query('SELECT 1');
      throw thrown;
    }),
    (error: unknown) => {
      // The callback's failure is the one worth reading. Teardown must not replace it.
      assert.equal(error, thrown, 'the callback error is rethrown unchanged, not a cleanup error');
      return true;
    },
  );

  assert.equal(await databaseExists(name), false, 'cleanup runs on the failure path too');
});

test('test database: teardown waits for a lingering backend instead of terminating it', { skip }, async () => {
  // A backend that is deterministically still attached when teardown begins: not a race to win, a
  // connection this test holds open on purpose. Teardown must observe it, wait, and only drop once
  // it has gone — rather than killing it, which is what FORCE did.
  const checks: Array<readonly LingeringBackend[]> = [];
  let lingering: Client | undefined;
  let lingeringErrored: unknown;
  let name = '';

  await withTestDatabase(
    async ({ pool, connectionString, database }) => {
      name = database;
      await pool.query('SELECT 1');

      lingering = new Client({ connectionString, application_name: 'lingering-on-purpose' });
      await lingering.connect();
      // If teardown terminated this connection, `pg` would deliver the FATAL here. Recording it
      // rather than letting it go unhandled is what makes the assertion below meaningful — and
      // keeps this test from becoming the uncaught-exception source it is testing for.
      lingering.on('error', (error) => {
        lingeringErrored = error;
      });
    },
    {
      onQuiescenceCheck: (backends) => {
        checks.push(backends);
        // Release the connection the first time teardown reports seeing it. This is a latch, not a
        // sleep: teardown cannot proceed until the backend is gone, and it only goes because a
        // check observed it.
        if (backends.length > 0 && lingering !== undefined) {
          const closing = lingering;
          lingering = undefined;
          void closing.end();
        }
      },
    },
  );

  const sawIt = checks.some((backends) =>
    backends.some((backend) => backend.applicationName === 'lingering-on-purpose'),
  );
  assert.equal(sawIt, true, 'teardown observed the lingering backend rather than dropping through it');
  assert.deepEqual(checks.at(-1), [], 'and only stopped waiting once nothing was attached');
  assert.equal(
    lingeringErrored,
    undefined,
    'the lingering connection was never terminated — no FORCE, so no 57P01 to absorb',
  );
  assert.equal(await databaseExists(name), false, 'and the database was dropped');
});

test('test database: a backend that never leaves is bounded, named, and not leaked', { skip }, async () => {
  // The failure path: something holds a connection it does not own and never lets go. Teardown must
  // give up on a bound rather than hang the suite, say what was holding the database, and still not
  // leave the database behind.
  let held: Client | undefined;
  let name = '';

  try {
    await assert.rejects(
      withTestDatabase(
        async ({ pool, connectionString, database }) => {
          name = database;
          await pool.query('SELECT 1');
          held = new Client({ connectionString, application_name: 'never-leaves' });
          await held.connect();
          held.on('error', () => {
            // Emergency cleanup drops this database WITH (FORCE) precisely because this connection
            // refused to go, so this client is expected to be terminated. Swallowing it here is
            // this test tidying up after itself, not the helper hiding a failure.
          });
        },
        { teardownTimeoutMs: 400, pollIntervalMs: 25 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseTeardownTimeoutError, 'teardown fails loudly on the bound');
        assert.equal(error.database, name);
        assert.ok(error.lingering.length > 0, 'and reports what was still attached');
        assert.ok(
          error.lingering.some((backend) => backend.applicationName === 'never-leaves'),
          'naming the culprit by application_name, so the owner is findable',
        );
        return true;
      },
    );
  } finally {
    if (held) await held.end().catch(() => undefined);
  }

  assert.equal(
    await databaseExists(name),
    false,
    'a database is never leaked, even when teardown could not do it the safe way',
  );
});

test('test database: when both the callback and teardown fail, the callback error wins', { skip }, async () => {
  // The case the naive try/finally gets wrong. A teardown failure thrown from `finally` would
  // replace the assertion that actually failed, leaving the author reading a cleanup error instead
  // of their own test. Both halves fail here on purpose: a throwing callback that also leaves a
  // connection behind, so teardown times out too.
  const thrown = new Error('the assertion that must survive teardown');
  let held: Client | undefined;
  let name = '';

  try {
    await assert.rejects(
      withTestDatabase(
        async ({ pool, connectionString, database }) => {
          name = database;
          await pool.query('SELECT 1');
          held = new Client({ connectionString, application_name: 'held-through-failure' });
          await held.connect();
          held.on('error', () => {
            // Expected: emergency cleanup terminates this one.
          });
          throw thrown;
        },
        { teardownTimeoutMs: 300, pollIntervalMs: 25 },
      ),
      (error: unknown) => {
        assert.equal(error, thrown, 'the callback error is what surfaces');
        assert.ok(
          (error as Error).cause instanceof DatabaseTeardownTimeoutError,
          'and the teardown failure rides along as its cause rather than replacing it',
        );
        return true;
      },
    );
  } finally {
    if (held) await held.end().catch(() => undefined);
  }

  assert.equal(await databaseExists(name), false, 'and the database still went away');
});

test('test database: a concurrent run is not blocked by another database’s backends', { skip }, async () => {
  // The quiescence predicate filters on `datname`, so one run's busy backends must be invisible to
  // the other's teardown. Asserting that no check ever saw *anything* would be flaky for the very
  // reason this helper exists — a run's own pool can still be closing when its first check runs —
  // and would prove nothing about isolation anyway, since the query already filters by database and
  // a `LingeringBackend` does not carry the one it came from.
  //
  // What does prove it: the short run finishes while the long one is still holding a backend open.
  // If teardown waited on anything outside its own database, that could not happen.
  const names: string[] = [];
  const checksLong: Array<readonly LingeringBackend[]> = [];
  const checksShort: Array<readonly LingeringBackend[]> = [];
  let longFinished = false;

  // The long run is held open by an explicit release rather than a sleep. A fixed `pg_sleep` would
  // make this assertion a bet that the short run finishes first, which a loaded server can lose —
  // failing a correct implementation. Held this way, the ordering is a fact of the test.
  let releaseLong = (): void => undefined;
  const heldOpen = new Promise<void>((resolve) => {
    releaseLong = resolve;
  });

  const long = withTestDatabase(
    async ({ pool, database }) => {
      names.push(database);
      // A leased client, not `pool.query`. `pool.query` returns its client to the pool as soon as it
      // answers, and an idle client can be closed before the short run finishes — which would leave
      // this run holding no backend at all, and the isolation this test claims to prove unproven.
      const leased = await pool.connect();
      try {
        await leased.query('SELECT 1');
        await heldOpen;
      } finally {
        leased.release();
      }
    },
    { onQuiescenceCheck: (backends) => checksLong.push(backends) },
  ).then(() => {
    longFinished = true;
  });

  const short = withTestDatabase(
    async ({ pool, database }) => {
      names.push(database);
      await pool.query('SELECT 1');
    },
    { onQuiescenceCheck: (backends) => checksShort.push(backends) },
  );

  // The gate has to open on every path. If the short run rejects or the ordering assertion fails,
  // an unreleased latch leaves the long callback suspended forever: its teardown never runs, its
  // database and pool stay alive, and the runner may not exit. A test that leaks the thing it is
  // policing is the failure this whole file exists to prevent.
  //
  // Not a `finally`, though — throwing from one replaces whatever was already propagating, so a
  // long run that also failed would bury the short-run failure that started all this. The same rule
  // the helper follows for callback-versus-teardown errors: the first failure is the one worth
  // reading, and the second rides along.
  let primaryFailure: unknown;
  let primaryFailed = false;
  try {
    await short;
    assert.equal(longFinished, false, 'the short run completed while the long one still held its database');
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }

  releaseLong();
  const longFailure = await long.then(
    () => undefined,
    (error: unknown) => error ?? new Error('the long run rejected with a falsy value'),
  );

  if (primaryFailed) {
    if (longFailure !== undefined && primaryFailure instanceof Error && primaryFailure.cause === undefined) {
      primaryFailure.cause = longFailure;
    }
    throw primaryFailure;
  }
  if (longFailure !== undefined) throw longFailure;

  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1], 'each run gets its own database');
  for (const name of names) assert.equal(await databaseExists(name), false, `${name} was dropped`);
  assert.deepEqual(checksShort.at(-1), [], 'the short run reached quiescence before dropping');
  assert.deepEqual(checksLong.at(-1), [], 'and so did the long one');
});

test('test database: giving up on teardown still leaves no database behind', { skip }, async () => {
  // The bounded path force-drops before it reports, and the outer net must not wrongly assume it
  // did. A leaked database is invisible to every other assertion here and is the one outcome
  // teardown must never produce, so it gets counted directly.
  const before = await countTestDatabases();
  let held: Client | undefined;

  try {
    await assert.rejects(
      withTestDatabase(
        async ({ pool, connectionString }) => {
          await pool.query('SELECT 1');
          held = new Client({ connectionString, application_name: 'leak-check' });
          await held.connect();
          held.on('error', () => {
            // Expected: this is the connection teardown gives up on and then terminates.
          });
        },
        { teardownTimeoutMs: 300, pollIntervalMs: 25 },
      ),
      (error: unknown) => error instanceof DatabaseTeardownTimeoutError,
    );
  } finally {
    if (held) await held.end().catch(() => undefined);
  }

  assert.equal(await countTestDatabases(), before, 'the disposable database did not survive teardown');
});

test('test database: a leaked pool client does not become an uncaught error', { skip }, async () => {
  // The emergency path is the one place FORCE survives, and the connection it terminates can belong
  // to the callback's own pool — a client checked out and never released, which is exactly what
  // makes `pool.end()` time out and send teardown down that path. That pool has no `error` listener
  // during the run, so without one installed before the forced drop, `pg` re-emits the FATAL as an
  // uncaught exception: the failure this whole helper exists to remove, reintroduced by its own
  // cleanup. Unlike the other leak tests, nothing here attaches a listener of its own — the helper
  // has to own the termination it causes.
  const before = await countTestDatabases();

  await assert.rejects(
    withTestDatabase(
      async ({ pool }) => {
        const leased = await pool.connect();
        await leased.query('SELECT 1');
        // Deliberately never released.
      },
      { teardownTimeoutMs: 400, pollIntervalMs: 25 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseTeardownTimeoutError, 'the bound is what reports, not a crash');
      return true;
    },
  );

  // If the FATAL had escaped, node:test would have failed this run with an uncaught exception rather
  // than reaching here.
  assert.equal(await countTestDatabases(), before, 'and the database still went away');
});

test('test database: a callback that rejects with undefined is still a failure', { skip }, async () => {
  // `undefined` is a legal rejection value, so it must not double as the helper's own no-error
  // sentinel — that would turn this call into a success returning an uninitialised result.
  let name = '';
  let resolved = false;

  await assert.rejects(
    withTestDatabase(async ({ pool, database }) => {
      name = database;
      await pool.query('SELECT 1');
      throw undefined;
    }).then(() => {
      resolved = true;
    }),
    (error: unknown) => {
      assert.equal(error, undefined, 'the rejection value is preserved exactly as thrown');
      return true;
    },
  );

  assert.equal(resolved, false, 'a rejection with undefined never becomes a successful return');
  assert.equal(await databaseExists(name), false, 'and its database is still cleaned up');
});

test('test database: a real query failure is not swallowed by teardown', { skip }, async () => {
  // The helper absorbs exactly one thing — 55006 while retrying its own drop. A genuine SQL error
  // from the callback has to arrive unchanged, or these tests stop being able to fail.
  await assert.rejects(
    withTestDatabase(async ({ pool }: { pool: Pool }) => {
      await pool.query('SELECT * FROM a_table_that_does_not_exist');
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, '42P01', 'undefined_table reaches the caller');
      return true;
    },
  );
});
