/**
 * Test-only: wait until PostgreSQL itself says a backend is blocked.
 *
 * A concurrency test that forces a race has to know the race happened. The usual shortcut is to
 * start the losing statement, sleep, and assume — which cannot fail loudly. If the sleep is too
 * short the loser has not blocked yet, the winner commits first, and the test passes having
 * exercised nothing. The final values are identical either way, so the assertions cannot tell the
 * difference. That is the failure this helper exists to remove: a green test that proved nothing.
 *
 * The state is asked of the server rather than inferred from elapsed time. Measured against
 * PostgreSQL 16.14, a blocked backend becomes visible 2-3 ms after its statement is issued, on the
 * first poll; the timeout here is a failure ceiling, not an expected duration.
 *
 * Deliberately two functions. A general-purpose database test framework is not wanted — this
 * answers one question, and callers own their own connections and cleanup.
 */
import type { Pool, PoolClient } from 'pg';

/**
 * Evidence that the expected block was observed, returned so the caller can assert on it.
 *
 * The point of returning it rather than resolving `void` is that the assertion becomes
 * load-bearing: a test that stops observing the block stops being able to make these claims.
 */
export interface BlockedBackend {
  readonly pid: number;
  readonly waitEventType: string;
  readonly waitEvent: string;
  /** Every backend PostgreSQL reports as blocking this one. */
  readonly blockingPids: readonly number[];
  /** `pg_locks.locktype` of the ungranted lock. */
  readonly lockType: string;
  /**
   * The transaction id being waited on, which names the resource rather than merely the waiter.
   *
   * Non-nullable on purpose: `pg_stat_activity`, `pg_blocking_pids()` and `pg_locks` are three
   * separate reads of server state within one statement and are not atomic with respect to each
   * other, so the lock row can in principle lag the activity row. Returning evidence without it
   * would hand callers a `null` to assert against and make their test flaky exactly when it was
   * meant to be deterministic. The wait simply polls again instead. Raised in the Qodo review of
   * PR #138.
   */
  readonly waitingOnTransactionId: string;
  readonly elapsedMs: number;
  readonly polls: number;
}

export interface WaitForBackendBlockedOptions {
  /** The backend expected to become blocked. */
  readonly pid: number;
  /** The backend expected to hold the conflicting lock. */
  readonly blockedBy: number;
  /**
   * Expected `pg_stat_activity.wait_event`.
   *
   * Defaults to `transactionid`, which is what a conflict on an uncommitted unique key actually
   * produces: the waiter blocks on the *transaction* that inserted the tuple, because until that
   * transaction ends nobody can say whether the key is taken. There is no literal "row lock" to
   * observe, so a test looking for one would wait forever.
   */
  readonly waitEvent?: string;
  /** Failure ceiling, not an expected duration. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface ActivityRow {
  readonly wait_event_type: string | null;
  readonly wait_event: string | null;
  readonly blocking_pids: readonly number[] | null;
  readonly locktype: string | null;
  readonly waiting_on_transaction_id: string | null;
}

/**
 * One backend's wait state, with the ungranted transaction-id lock it is parked on.
 *
 * `LEFT JOIN` because the lock row and the activity row do not appear atomically: a backend can be
 * reported as waiting a moment before its ungranted lock is visible. Requiring both in an inner
 * join would turn that ordinary skew into a missed observation.
 */
const OBSERVE = `
  SELECT a.wait_event_type,
         a.wait_event,
         pg_blocking_pids(a.pid) AS blocking_pids,
         l.locktype,
         l.transactionid::text AS waiting_on_transaction_id
    FROM pg_stat_activity a
    LEFT JOIN pg_locks l
      ON l.pid = a.pid AND NOT l.granted AND l.locktype = 'transactionid'
   WHERE a.pid = $1`;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 5;
const DEFAULT_WAIT_EVENT = 'transactionid';

/**
 * Resolve once `pid` is observed blocked on a `waitEvent` lock held by `blockedBy`; reject with a
 * diagnostic if that is not observed within the timeout.
 *
 * All three conditions must hold together. `wait_event_type = 'Lock'` alone is not enough — a
 * backend can be waiting on any lock in the database, including one no part of the test created —
 * so the blocking backend is checked by identity. That is what makes the observation proof of
 * *this* race rather than proof that something, somewhere, was contended.
 *
 * `observer` must be a connection distinct from `pid`'s, and must authenticate as the same role:
 * PostgreSQL shows a session's wait state in full to its own role without `pg_read_all_stats`.
 */
export async function waitForBackendBlocked(
  observer: Pool | PoolClient,
  options: WaitForBackendBlockedOptions,
): Promise<BlockedBackend> {
  const waitEvent = options.waitEvent ?? DEFAULT_WAIT_EVENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const startedAt = process.hrtime.bigint();
  const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

  let polls = 0;
  let last: ActivityRow | undefined;
  let expired = false;

  const expiry = (): Error =>
    new Error(timeoutDiagnostic(options, waitEvent, timeoutMs, elapsedMs(), polls, last));

  // The ceiling has to sit outside the polling loop rather than being checked between iterations.
  // A clock read that happens only after `await observer.query(...)` bounds nothing if that query
  // never comes back: an exhausted pool or a stalled server would hang the run instead of failing
  // it, which is the one guarantee this helper exists to make. Raised in the Qodo review of
  // PR #138.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(expiry());
    }, timeoutMs);
  });

  const poll = async (): Promise<BlockedBackend> => {
    while (!expired) {
      polls += 1;
      const result = await observer.query<ActivityRow>(OBSERVE, [options.pid]);
      if (expired) break;
      last = result.rows[0];

      if (last !== undefined) {
        const blockingPids = last.blocking_pids ?? [];
        if (
          last.wait_event_type === 'Lock' &&
          last.wait_event === waitEvent &&
          blockingPids.includes(options.blockedBy) &&
          last.locktype !== null &&
          last.waiting_on_transaction_id !== null
        ) {
          return {
            pid: options.pid,
            waitEventType: last.wait_event_type,
            waitEvent: last.wait_event,
            blockingPids: [...blockingPids],
            lockType: last.locktype,
            waitingOnTransactionId: last.waiting_on_transaction_id,
            elapsedMs: elapsedMs(),
            polls,
          };
        }
      }
      await delay(pollIntervalMs);
    }
    throw expiry();
  };

  const polling = poll();
  // When the ceiling wins the race nothing else is watching this promise, and a loop that throws
  // after being cancelled would surface as an unhandled rejection rather than as the diagnostic.
  polling.catch(() => undefined);
  try {
    return await Promise.race([polling, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

/** The backend PID serving `executor`. Meaningful for a pool only when it is pinned to `max: 1`. */
export async function backendPid(executor: Pool | PoolClient): Promise<number> {
  const result = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('backendPid: pg_backend_pid() returned no row');
  }
  return row.pid;
}

/**
 * Enough to tell whether the backend never blocked, blocked on something else, or vanished.
 *
 * Deliberately excludes `pg_stat_activity.query` and every other backend's activity: a test
 * failure should not print statements, credentials, or unrelated sessions into CI logs.
 */
function timeoutDiagnostic(
  options: WaitForBackendBlockedOptions,
  waitEvent: string,
  timeoutMs: number,
  elapsed: number,
  polls: number,
  last: ActivityRow | undefined,
): string {
  const observed =
    last === undefined
      ? 'backend not present in pg_stat_activity'
      : `wait_event_type=${format(last.wait_event_type)} wait_event=${format(last.wait_event)} ` +
        `blocking_pids=[${(last.blocking_pids ?? []).join(', ')}] ` +
        `locktype=${format(last.locktype)}`;
  return (
    `waitForBackendBlocked: backend ${options.pid} was never observed blocked on a ` +
    `'${waitEvent}' lock held by backend ${options.blockedBy}. ` +
    `Last observed: ${observed}. ` +
    `Gave up after ${elapsed.toFixed(0)}ms (timeout ${timeoutMs}ms) across ${polls} polls.`
  );
}

function format(value: string | null): string {
  return value === null ? 'null' : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
