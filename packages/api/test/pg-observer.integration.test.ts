/**
 * Focused tests for the deterministic block observer.
 *
 * The helper stands in for a sleep, so it has to be shown to do the thing the sleep could not:
 * resolve only on a real, correctly-attributed block, and fail loudly otherwise. A helper that
 * resolved eagerly would silently restore exactly the weakness it was written to remove, and every
 * test built on it would go on passing.
 *
 * These run against a real server because there is nothing to test otherwise — the subject is
 * PostgreSQL's own lock reporting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '@chess-platform/persistence';
import { createPool } from '@chess-platform/persistence/pg';
import type { Pool } from 'pg';
import { backendPid, waitForBackendBlocked } from './pg-observer';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

/**
 * A scratch table per test, named from a uuid.
 *
 * A fixed name lets one test's cleanup drop the table another test is still using, and makes the
 * unconditional `DROP` capable of destroying a pre-existing table that merely shares the name.
 * Raised in the Qodo review of PR #138.
 *
 * An identifier cannot be a bind parameter, so this name is interpolated — which is why it is
 * generated here and checked against a strict pattern before it can reach SQL, rather than coming
 * from anywhere a caller could influence.
 */
function probeTableName(): string {
  const name = `pg_observer_probe_${uuidv7().replaceAll('-', '')}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error('refusing to build SQL with an unexpected table identifier');
  }
  return name;
}

async function createProbeTable(pool: Pool, table: string): Promise<void> {
  await pool.query(`CREATE TABLE ${table} (probe_key text PRIMARY KEY, n int NOT NULL)`);
}

/** Contends for `probe_key`, so it must wait on whichever transaction inserted it uncommitted. */
function conflictingUpsert(table: string): string {
  return `
    INSERT INTO ${table} AS p (probe_key, n) VALUES ($1, 1)
    ON CONFLICT (probe_key) DO UPDATE SET n = p.n + 1
    WHERE p.n < 1
    RETURNING 1`;
}

test('the observer resolves only on a real block, and names the backend that caused it', { skip }, async () => {
  const admin = createPool();
  // Pinned to one connection so the backend running the blocked statement is known by identity
  // rather than guessed from whichever client the pool happened to hand out.
  const loserPool = createPool({ max: 1 });
  const observerPool = createPool({ max: 1 });
  const table = probeTableName();
  try {
    await createProbeTable(admin, table);
    const key = `observer:blocked:${uuidv7()}`;
    const loserPid = await backendPid(loserPool);
    const holder = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const holderPid = await backendPid(holder);
      await holder.query('BEGIN');
      await holder.query(`INSERT INTO ${table} (probe_key, n) VALUES ($1, 1)`, [key]);
      const holderXid = (
        await holder.query<{ xid: string }>('SELECT pg_current_xact_id()::xid::text AS xid')
      ).rows[0]!.xid;

      // Not awaited: this statement is expected to block until the holder commits.
      pending = loserPool.query(conflictingUpsert(table), [key]);

      const evidence = await waitForBackendBlocked(observerPool, {
        pid: loserPid,
        blockedBy: holderPid,
      });

      assert.equal(evidence.waitEventType, 'Lock');
      assert.equal(
        evidence.waitEvent,
        'transactionid',
        'a conflict on an uncommitted unique key waits on the inserting transaction, not on a row',
      );
      assert.ok(
        evidence.blockingPids.includes(holderPid),
        `expected backend ${holderPid} among the blockers, got [${evidence.blockingPids.join(', ')}]`,
      );
      assert.equal(
        evidence.waitingOnTransactionId,
        holderXid,
        'the lock must name the holder transaction, which is what proves this is the intended race',
      );
      assert.ok(evidence.polls >= 1);

      // The holder still has not committed, so a correct observation is still true when re-checked
      // independently. A helper that resolved without observing anything would not survive this.
      const recheck = await observerPool.query<{ blocking: readonly number[] | null }>(
        'SELECT pg_blocking_pids(pid) AS blocking FROM pg_stat_activity WHERE pid = $1',
        [loserPid],
      );
      assert.ok(
        (recheck.rows[0]?.blocking ?? []).includes(holderPid),
        'the backend was not actually blocked at the moment the observer returned',
      );

      await holder.query('COMMIT');
    } finally {
      // An assertion failing between BEGIN and COMMIT leaves this transaction open with the
      // conflicting statement still blocked on it. Rolling back before release keeps a failing
      // test from handing a poisoned client back to the pool, and unblocks the pending statement
      // so its rejection is awaited here rather than surfacing as an unhandled one later.
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
  } finally {
    await admin.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await Promise.all([admin.end(), loserPool.end(), observerPool.end()]);
  }
});

test('the observer fails with diagnostics, and no credentials, when the backend never blocks', { skip }, async () => {
  const idlePool = createPool({ max: 1 });
  const observerPool = createPool({ max: 1 });
  try {
    const idlePid = await backendPid(idlePool);
    const observerPid = await backendPid(observerPool);

    const failure = await waitForBackendBlocked(observerPool, {
      pid: idlePid,
      blockedBy: observerPid,
      timeoutMs: 400,
      pollIntervalMs: 5,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(failure instanceof Error, 'an unblocked backend must fail the wait, not satisfy it');
    assert.match(failure.message, new RegExp(`backend ${idlePid}\\b`));
    assert.match(failure.message, /timeout 400ms/);
    assert.match(failure.message, /polls/);
    assert.ok(
      !failure.message.includes('postgres://'),
      'a test failure must not print connection strings into CI logs',
    );
  } finally {
    await Promise.all([idlePool.end(), observerPool.end()]);
  }
});

test('the observer does not accept a block caused by a different backend', { skip }, async () => {
  const admin = createPool();
  const loserPool = createPool({ max: 1 });
  const observerPool = createPool({ max: 1 });
  const table = probeTableName();
  try {
    await createProbeTable(admin, table);
    const key = `observer:wrong-blocker:${uuidv7()}`;
    const loserPid = await backendPid(loserPool);
    const observerPid = await backendPid(observerPool);
    const holder = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`INSERT INTO ${table} (probe_key, n) VALUES ($1, 1)`, [key]);
      pending = loserPool.query(conflictingUpsert(table), [key]);

      // The backend really is blocked — but by the holder, not by the observer. Naming the wrong
      // blocker must fail, or "something is locked somewhere" would pass for proof of this race.
      const failure = await waitForBackendBlocked(observerPool, {
        pid: loserPid,
        blockedBy: observerPid,
        timeoutMs: 500,
        pollIntervalMs: 5,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      assert.ok(failure instanceof Error, 'a block by an unrelated backend is not the expected block');
      assert.match(failure.message, new RegExp(`held by backend ${observerPid}\\b`));

      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
  } finally {
    await admin.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await Promise.all([admin.end(), loserPool.end(), observerPool.end()]);
  }
});

/**
 * The ceiling must bound the wait even when the observer's own query cannot return.
 *
 * The first version read the clock only between polls, after `await observer.query(...)`. That
 * bounds nothing if the query never comes back: an exhausted pool or a stalled server would hang
 * the run rather than fail it, which is the opposite of what a bounded helper promises. Reproduced
 * here by occupying the observer pool's only connection, which is the exhaustion case exactly.
 * Raised in the Qodo review of PR #138.
 */
test('the wait is bounded even when the observer cannot get a connection', { skip }, async () => {
  const observerPool = createPool({ max: 1 });
  const idlePool = createPool({ max: 1 });
  let hog: Promise<unknown> | undefined;
  try {
    const idlePid = await backendPid(idlePool);
    // Occupy the observer pool's only client, so every poll queues instead of running.
    hog = observerPool.query('SELECT pg_sleep(3)');

    const startedAt = Date.now();
    const failure = await waitForBackendBlocked(observerPool, {
      pid: idlePid,
      blockedBy: idlePid,
      timeoutMs: 400,
      pollIntervalMs: 5,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(failure instanceof Error, 'a blocked observer must still fail, not hang');
    assert.match(failure.message, /timeout 400ms/);
    assert.ok(
      elapsed < 1_500,
      `the ceiling must fire without waiting for the query, took ${elapsed}ms`,
    );
  } finally {
    await Promise.all([observerPool.end(), idlePool.end()]);
    if (hog) await hog.catch(() => undefined);
  }
});

test('a pool pinned to one connection keeps one backend, so its pid is an identity', { skip }, async () => {
  const pool = createPool({ max: 1 });
  try {
    const pids = [
      await backendPid(pool),
      await backendPid(pool),
      await backendPid(pool),
      await backendPid(pool),
    ];
    assert.equal(
      new Set(pids).size,
      1,
      `a max:1 pool must not move between backends, got [${pids.join(', ')}]`,
    );
  } finally {
    await pool.end();
  }
});
