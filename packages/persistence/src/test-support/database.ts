/**
 * @packageDocumentation
 * `@chess-platform/persistence/test-support` — a disposable PostgreSQL database per test.
 *
 * Test-only. Nothing under `src/pg` imports this and no production entry point re-exports it; it is
 * a separate subpath so the driver-facing surface does not grow a test harness.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createPool } from '../pg/pool';

/** A backend still attached to the disposable database when teardown wanted to drop it. */
export interface LingeringBackend {
  readonly pid: number;
  readonly state: string | null;
  readonly applicationName: string | null;
}

/** What the callback is handed: an isolated database and a pool bound to it. */
export interface TestDatabase {
  readonly pool: Pool;
  readonly database: string;
  readonly connectionString: string;
}

export interface TestDatabaseOptions {
  /** Server to create the disposable database on. Defaults to `DATABASE_URL`. */
  readonly connectionString?: string;
  /**
   * Pool size handed to the callback.
   *
   * Two is the floor rather than one: `migrate` holds its advisory lock on a dedicated client and
   * runs its statements on another, so a single-connection pool deadlocks against itself.
   */
  readonly max?: number;
  /**
   * Budget for teardown, measured from the moment the callback returns.
   *
   * It bounds each teardown step rather than their sum: the wait for quiescence, the drop, and the
   * last-resort drop are separately capped, so a server that stops answering costs a small multiple
   * of this rather than the unbounded wait a between-await deadline check would allow. It is not
   * applied as a `statement_timeout` on the admin pool, because that pool also runs the
   * `CREATE DATABASE` this budget has nothing to do with.
   */
  readonly teardownTimeoutMs?: number;
  /** Gap between quiescence checks. */
  readonly pollIntervalMs?: number;
  /**
   * Called once per quiescence check with whatever is still attached.
   *
   * This exists so a regression test can prove teardown *waited* by observing a check that saw a
   * backend, rather than asserting on elapsed wall-clock time — which measures the machine rather
   * than the contract.
   */
  readonly onQuiescenceCheck?: (backends: readonly LingeringBackend[]) => void;
}

/** Teardown could not reach a state where the database was safe to drop within its budget. */
export class DatabaseTeardownTimeoutError extends Error {
  readonly database: string;
  readonly lingering: readonly LingeringBackend[];
  /**
   * Whether the emergency drop actually removed the database.
   *
   * The caller uses this rather than assuming a timeout implies a clean server: the forced drop is
   * itself a query, and it can fail or overrun like any other. When it does, the database is still
   * there and the last-resort drop still has work to do.
   */
  readonly droppedDatabase: boolean;

  constructor(
    database: string,
    timeoutMs: number,
    lingering: readonly LingeringBackend[],
    droppedDatabase: boolean,
  ) {
    const who =
      lingering.length > 0
        ? lingering
            .map((b) => `pid ${b.pid} (${b.applicationName ?? 'unnamed'}, ${b.state ?? 'unknown state'})`)
            .join(', ')
        : 'nothing was visible on the server, so the pool itself never finished closing';
    super(
      `database "${database}" was still in use ${timeoutMs}ms after its pool was closed: ${who}. ` +
        (droppedDatabase
          ? 'It has been dropped, but something held a connection it did not own.'
          : 'Dropping it then failed too, so it may still be on the server — see this error’s cause.'),
    );
    this.name = 'DatabaseTeardownTimeoutError';
    this.database = database;
    this.lingering = lingering;
    this.droppedDatabase = droppedDatabase;
  }
}

/**
 * Force-drop for a teardown that has already failed, and report the timeout either way.
 *
 * The forced drop is a query like any other: it can fail, or overrun its own budget. Letting that
 * escape would replace the typed timeout — and with it the list of backends that actually held the
 * database, which is the only part of this a reader can act on. So the drop's failure becomes the
 * timeout's `cause`, and whether it succeeded is recorded rather than assumed.
 */
async function reportTimeoutAfterForcedDrop(
  admin: Pool,
  pool: Pool,
  clients: ReadonlySet<PoolClient>,
  database: string,
  timeoutMs: number,
  lingering: readonly LingeringBackend[],
): Promise<never> {
  let dropFailure: unknown;
  try {
    await forceDropAbandoned(admin, pool, clients, database, timeoutMs);
  } catch (error) {
    dropFailure = error;
  }
  const timeout = new DatabaseTeardownTimeoutError(
    database,
    timeoutMs,
    lingering,
    dropFailure === undefined,
  );
  if (dropFailure !== undefined) timeout.cause = dropFailure;
  throw timeout;
}

/**
 * Bound on creating the disposable database, covering both its connection and its statement.
 *
 * Deliberately generous, and deliberately *not* `teardownTimeoutMs`: creation happens before the
 * callback runs and before there is any cleanup to start, so it has nothing to do with how long
 * teardown may wait. Tests here set the teardown budget as low as 300ms to exercise the timeout
 * path, and creation held to that would fail on a loaded server rather than on a real fault.
 */
const CREATE_TIMEOUT_MS = 30_000;

/** SQLSTATE 55006 — `DROP DATABASE` refusing because a backend is still attached. */
const OBJECT_IN_USE = '55006';

/** SQLSTATE 57P01 — `admin_shutdown`: the backend was terminated by `pg_terminate_backend`. */
const ADMIN_SHUTDOWN = '57P01';

/** Reads the SQLSTATE off an unknown thrown value, or null when it carries none. */
function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Whether an error is the backend termination this helper itself just asked for.
 *
 * SQLSTATE only. `pg` also reports a bare "Connection terminated unexpectedly" when the socket
 * closes before the `FATAL` is read, and matching that string would absorb every unrelated
 * disconnect too — a server restart, a dropped network — precisely while the emergency listeners are
 * installed. 57P01 is the server saying it terminated the backend on command, which is the only
 * thing this code has grounds to treat as its own doing.
 */
function isForcedTermination(error: unknown): boolean {
  return sqlState(error) === ADMIN_SHUTDOWN;
}

/** Replaces the database in a connection URL, leaving credentials and host alone. */
function urlForDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Sleeps, as the gap between two quiescence checks. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A teardown step that ran out of budget, as opposed to one that failed on its own terms. */
class TeardownDeadlineError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`withTestDatabase: ${what} exceeded its ${timeoutMs}ms budget`);
    this.name = 'TeardownDeadlineError';
  }
}

/**
 * Run `work`, but stop waiting for it after `timeoutMs`.
 *
 * Checking `Date.now()` between awaits does not bound the awaits themselves: an established
 * connection that stops answering would sit past the deadline with nothing to interrupt it, which
 * would make the budget advisory rather than real. Every teardown step therefore goes through here.
 *
 * Losing the race abandons the wait, not the work — so callers that raced a *query* must also
 * destroy the connection it was running on. {@link boundedQuery} is how they do that.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TeardownDeadlineError(what, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run one admin statement under the budget, and take its connection away if it overruns.
 *
 * Racing `pool.query()` alone is not enough to bound anything. The abandoned query keeps its client
 * checked out, and `pool.end()` never closes a checked-out client — so the bounded end gives up too
 * and the helper returns with live sockets and a query still running, which is the opposite of the
 * guarantee. Leasing the client here makes it reachable: `release(true)` destroys it rather than
 * returning it to the pool, which drops the socket the statement is waiting on.
 *
 * Only a deadline overrun destroys the connection. A statement that fails on its own terms — 55006
 * from a drop, say — has finished with its client, and that client is still perfectly good.
 */
async function boundedQuery<R extends QueryResultRow>(
  admin: Pool,
  timeoutMs: number,
  what: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  const lease = admin.connect();
  let client: PoolClient;
  try {
    client = await withDeadline(lease, timeoutMs, `${what} (connect)`);
  } catch (error) {
    // The deadline stops this waiting; it does not cancel the connect. A lease that lands afterwards
    // would be checked out with nobody left to release it — and `pool.end()` waits for checked-out
    // clients, so the pool this was meant to bound would never close. Destroy the late arrival
    // instead, and tolerate the lease rejecting on its own.
    void lease.then(
      (late) => {
        late.release(true);
      },
      () => undefined,
    );
    throw error;
  }

  let overran = false;
  try {
    return await withDeadline(client.query<R>(text, [...values]), timeoutMs, what);
  } catch (error) {
    overran = error instanceof TeardownDeadlineError;
    throw error;
  } finally {
    client.release(overran);
  }
}

/**
 * Resolve once no backend is attached to `database`, or return what is still there at the deadline.
 *
 * The admin pool is deliberately attached to a different database, so it never counts itself; the
 * `pid <> pg_backend_pid()` guard covers a caller who points the admin connection at the target
 * anyway. Filtering on `datname` is what keeps two concurrent isolated databases from ever seeing
 * each other.
 */
async function waitForQuiescence(
  admin: Pool,
  database: string,
  deadline: number,
  stepTimeoutMs: number,
  pollIntervalMs: number,
  onCheck: ((backends: readonly LingeringBackend[]) => void) | undefined,
): Promise<readonly LingeringBackend[]> {
  for (;;) {
    const { rows } = await boundedQuery<{
      pid: number;
      state: string | null;
      application_name: string | null;
    }>(
      admin,
      stepTimeoutMs,
      'quiescence check',
      `SELECT pid, state, application_name
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    const lingering: LingeringBackend[] = rows.map((row) => ({
      pid: row.pid,
      state: row.state,
      applicationName: row.application_name,
    }));
    onCheck?.(lingering);
    if (lingering.length === 0 || Date.now() >= deadline) return lingering;
    await delay(pollIntervalMs);
  }
}

/**
 * End a pool, but never wait forever for it.
 *
 * `pool.end()` closes only *idle* clients: one checked out and never released leaves it pending
 * indefinitely — measured against pg 8.22.0, where a leased client kept `end()` unresolved past a
 * three-second bound. Teardown has to fail with a diagnostic rather than hang the suite, so the wait
 * is bounded and a leaked lease falls through to the quiescence check, which can name the culprit.
 */
async function endPoolWithin(pool: Pool, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // A rejecting end() still leaves the quiescence check as the authority on whether the database
    // can be dropped, and that check reports the situation far better than this error would.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Every connection the pool has open, tracked through public events only.
 *
 * The emergency drop below can terminate a client that is *checked out* — a lease the callback never
 * returned, which is the very thing that made `pool.end()` time out. A leased client is not idle, so
 * `pg` has removed `idleListener` from it and the pool never sees its errors: attaching to the pool
 * alone leaves that FATAL with no listener at all, and Node raises it as an uncaught exception. So
 * the clients have to be reachable individually, and `connect`/`remove` are the documented events
 * that bracket their lifetime.
 */
function trackClients(pool: Pool): ReadonlySet<PoolClient> {
  const live = new Set<PoolClient>();
  pool.on('connect', (client: PoolClient) => { live.add(client); });
  pool.on('remove', (client: PoolClient) => { live.delete(client); });
  return live;
}

/**
 * Take the database away from connections that would not let go, and own the consequence.
 *
 * This is the only place `WITH (FORCE)` survives, and it is reached only once teardown has already
 * failed — the caller is about to throw either way. It is still a deliberate termination, so the
 * connections it is about to kill get a listener *first*, on the pool and on every live client.
 *
 * That listener is not the absorber this change deleted from the API test. That one sat on every
 * run and hid a race in the normal path. This one is installed only where this code itself issues
 * the termination, one statement later, on connections already being abandoned — and it re-throws
 * anything it did not cause, so a genuine connection failure stays exactly as loud as it was.
 */
async function forceDropAbandoned(
  admin: Pool,
  pool: Pool,
  clients: ReadonlySet<PoolClient>,
  database: string,
  timeoutMs: number,
): Promise<void> {
  // Two shapes reach these connections, and both are this call's own doing. The server's `FATAL`
  // carries SQLSTATE 57P01. When the backend dies before that message can be read, `pg` reports a
  // bare "Connection terminated unexpectedly" with no code at all — measured here, that is what a
  // *leased* client sees, because its socket goes down under an in-flight lease.
  //
  // Matching that string is defensible only because of where it sits: on connections belonging to a
  // pool already being abandoned, after this function has itself issued the termination, on a path
  // whose caller always throws. It is deliberately not part of {@link isForcedTermination}, which
  // stays SQLSTATE-only — as a general predicate the string would absorb an unrelated server restart
  // or dropped network too, which is the observability loss the deleted 57P01 absorber caused.
  const absorbOwnTermination = (error: Error): void => {
    if (isForcedTermination(error) || error.message.includes('Connection terminated')) return;
    throw error;
  };
  pool.on('error', absorbOwnTermination);
  for (const client of clients) client.on('error', absorbOwnTermination);

  await boundedQuery(admin, timeoutMs, 'forced drop', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}

/**
 * Drop the database, tolerating one specific lost race and nothing else.
 *
 * Quiescence is established with a query, and a backend can attach between that answer and the drop
 * — autovacuum being the realistic case. PostgreSQL reports exactly that as 55006, so the drop is
 * retried inside the deadline the caller already granted. Every other SQLSTATE propagates untouched:
 * this absorbs a *scheduling* outcome, never a database error.
 */
async function dropWhenFree(
  admin: Pool,
  pool: Pool,
  clients: ReadonlySet<PoolClient>,
  database: string,
  deadline: number,
  teardownTimeoutMs: number,
  pollIntervalMs: number,
  onCheck: ((backends: readonly LingeringBackend[]) => void) | undefined,
): Promise<void> {
  for (;;) {
    try {
      await boundedQuery(
        admin,
        teardownTimeoutMs,
        'drop',
        `DROP DATABASE IF EXISTS "${database}"`,
      );
      return;
    } catch (error) {
      // Anything but "still in use" is a real database error and belongs to the caller untouched.
      if (sqlState(error) !== OBJECT_IN_USE) throw error;

      const lingering = await waitForQuiescence(
        admin,
        database,
        deadline,
        teardownTimeoutMs,
        pollIntervalMs,
        onCheck,
      );
      if (Date.now() >= deadline) {
        // 55006 arriving at or past the deadline is still a teardown timeout, not a raw SQL fault:
        // rethrowing the PostgreSQL error would skip the snapshot that names what was holding the
        // database and leave only the outer best-effort drop.
        await reportTimeoutAfterForcedDrop(admin, pool, clients, database, teardownTimeoutMs, lingering);
      }
    }
  }
}

/**
 * Make the database safe to drop, then drop it.
 *
 * Split out so the lifecycle above reads as create/run/tear-down rather than as one long block: the
 * ordering here is the contract, and it is easier to check when it is not interleaved with the
 * bookkeeping that decides which error to throw.
 *
 * Returns nothing and throws on failure, so the caller can record the failure without having to
 * distinguish "cleaned up" from "reported".
 */
async function tearDown(
  admin: Pool,
  pool: Pool,
  clients: ReadonlySet<PoolClient>,
  database: string,
  teardownTimeoutMs: number,
  pollIntervalMs: number,
  onCheck: ((backends: readonly LingeringBackend[]) => void) | undefined,
): Promise<void> {
  const deadline = Date.now() + teardownTimeoutMs;
  await endPoolWithin(pool, Math.max(0, deadline - Date.now()));

  const lingering = await waitForQuiescence(
    admin,
    database,
    deadline,
    teardownTimeoutMs,
    pollIntervalMs,
    onCheck,
  );
  if (lingering.length > 0) {
    // Something outlived its owner. Drop the database anyway so the server is not littered with
    // abandoned test databases, then say precisely what was holding it.
    await reportTimeoutAfterForcedDrop(admin, pool, clients, database, teardownTimeoutMs, lingering);
  }
  await dropWhenFree(admin, pool, clients, database, deadline, teardownTimeoutMs, pollIntervalMs, onCheck);
}

/**
 * Run `body` against a database created for it alone, and take that database away afterwards.
 *
 * **Why this is not simply `DROP DATABASE ... WITH (FORCE)`.** `pool.end()` resolves before its
 * clients have closed. In pg 8.22.0, `_pulseQueue` reaches the end callback in the same synchronous
 * turn in which `_remove` filters the last client out of `_clients`, while `client.end()` has only
 * queued the Terminate byte — measured here as zero of four `remove` events having fired at the
 * moment `end()` resolved. A drop issued straight afterwards can therefore still find a backend
 * attached, and `FORCE` then does exactly what it promises: it terminates that backend, and the
 * resulting `FATAL` arrives on a socket whose pool still has `idleListener` attached, because
 * `_remove` never detaches it. The error re-emits as `pool.emit('error')` — an unhandled
 * EventEmitter error, which `node:test` attributes to whichever test happens to be running rather
 * than to the teardown that caused it. Absorbing SQLSTATE 57P01 hides that; it does not fix it.
 *
 * A plain `DROP DATABASE` cannot do the same damage. Measured against PostgreSQL 16.14: with a
 * backend still attached it fails with 55006 and leaves that connection untouched, where `FORCE`
 * succeeds by killing it. So teardown waits for the database to be genuinely unused and then drops
 * it ordinarily — trading a quiet, harmful success for a loud, harmless failure.
 *
 * Teardown always runs, and drops the disposable database on every path it can reach — including the
 * one where it gives up and reports a timeout. The final fallback drop is best effort: it runs inside
 * a `catch`, because a cleanup failure must not bury the error already being reported, so a server
 * that refuses that drop can still leave a database behind. Teardown never replaces the callback's
 * own error: when both fail, the callback's error is thrown with the teardown failure as its `cause`.
 */
export async function withTestDatabase<T>(
  body: (db: TestDatabase) => Promise<T>,
  options: TestDatabaseOptions = {},
): Promise<T> {
  const connectionString = options.connectionString ?? process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('withTestDatabase: no connectionString was given and DATABASE_URL is not set');
  }

  const teardownTimeoutMs = options.teardownTimeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  // Generated here and never supplied by a caller, which is what makes it safe to interpolate into
  // the DDL below: PostgreSQL has no bound-parameter form for an identifier, so `CREATE DATABASE`
  // and `DROP DATABASE` cannot be parameterised. Both radix strings emit only `[0-9a-z]`, so the
  // result matches `[a-z0-9_]+` and there is nothing to escape. It is also ~25 characters against
  // PostgreSQL's 63-byte identifier limit, so two concurrent databases cannot be truncated to the
  // same name — which would let one run's teardown drop another run's database.
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const database = `test_db_${suffix}`;

  // Every teardown step runs on this pool, so the budget is applied here rather than only around
  // `pool.end()`. Checking `Date.now()` after an awaited query does not bound that query: a stalled
  // but established connection would sit past the deadline with nothing to interrupt it. These
  // options make the server itself give up, so the documented budget is the real one.
  // A backstop, deliberately looser than the budget it guards. The teardown paths run right up to
  // `teardownTimeoutMs` on purpose and then still have cleanup to do — force-dropping the database
  // and building the diagnostic — so a backstop set to the same value would preempt the very error
  // teardown was trying to report. This exists only for a server that has stopped answering, where
  // nothing else would ever return.
  const teardownBackstopMs = teardownTimeoutMs * 2 + 1_000;
  // No pool-level `connectionTimeoutMillis`. It would apply to *every* acquisition on this pool,
  // including the one `boundedQuery` makes for `CREATE DATABASE` — which runs before the callback
  // and has nothing to do with how long teardown may wait. Tests here pass `teardownTimeoutMs: 300`
  // to exercise the timeout path, so binding acquisition to it would cap setup at 300ms and fail
  // creation on a loaded server. It is also redundant: every `admin.connect()` in this file goes
  // through `boundedQuery`, which bounds acquisition with the budget belonging to that operation.
  const admin = createPool({ connectionString, max: 2 });
  // Hoisted so the last-resort drop can route through `forceDropAbandoned`: that drop is a forced
  // one too, and it terminates the same connections, so it owes them the same listener.
  let pool: Pool | undefined;
  let clients: ReadonlySet<PoolClient> = new Set();
  let dropped = false;
  let bodyFailed = false;
  let teardownFailed = false;
  let bodyError: unknown;
  let teardownError: unknown;
  let result!: T;

  try {
    await boundedQuery(admin, CREATE_TIMEOUT_MS, 'create', `CREATE DATABASE "${database}"`);
    const databaseUrl = urlForDatabase(connectionString, database);
    pool = createPool({ connectionString: databaseUrl, max: options.max ?? 4 });
    clients = trackClients(pool);
    try {
      result = await body({ pool, database, connectionString: databaseUrl });
    } catch (error) {
      // A promise may reject with anything, `undefined` included, so the flag is what records that
      // the callback failed. Using the captured value as its own sentinel would turn
      // `Promise.reject(undefined)` into a success and return an uninitialised result.
      bodyFailed = true;
      bodyError = error;
    } finally {
      try {
        await withDeadline(
          tearDown(admin, pool, clients, database, teardownTimeoutMs, pollIntervalMs, options.onQuiescenceCheck),
          teardownBackstopMs,
          'teardown',
        );
        dropped = true;
      } catch (error) {
        teardownFailed = true;
        teardownError = error;
        // A timeout reports whether its own forced drop succeeded, because that drop is a query and
        // can fail too. Trusting the error type alone would skip the net below exactly when the
        // database is still there.
        dropped = error instanceof DatabaseTeardownTimeoutError && error.droppedDatabase;
      }
    }
  } catch (error) {
    // `CREATE DATABASE` failed, or the URL rewrite or pool construction after it did. The last of
    // those can happen with the database already created, so the drop below has to stay reachable —
    // it is `IF EXISTS`, which makes it harmless when there is nothing there.
    if (!teardownFailed) {
      teardownFailed = true;
      teardownError = error;
    }
  } finally {
    try {
      if (!dropped) {
        // The same forced drop, so the same duty of care: if a pool exists it may still own
        // connections this is about to terminate, and they need a listener before it happens.
        if (pool !== undefined) {
          await forceDropAbandoned(admin, pool, clients, database, teardownBackstopMs);
        } else {
          await boundedQuery(
            admin,
            teardownBackstopMs,
            'last-resort drop',
            `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
          );
        }
      }
    } catch {
      // A last-resort drop that fails leaves the error already in flight, which describes the real
      // problem better than this one would.
    } finally {
      await endPoolWithin(admin, teardownTimeoutMs);
    }
  }

  if (bodyFailed) {
    // The test's own failure is the one worth reading. A teardown failure rides along as its cause
    // rather than replacing it: losing the assertion that actually failed would be the worse trade.
    if (teardownFailed && bodyError instanceof Error && bodyError.cause === undefined) {
      bodyError.cause = teardownError;
    }
    throw bodyError;
  }
  if (teardownFailed) throw teardownError;
  return result;
}
