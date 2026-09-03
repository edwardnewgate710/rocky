/**
 * @packageDocumentation
 * `@chess-platform/persistence/test-support` — a disposable PostgreSQL database per test.
 *
 * Test-only. Nothing under `src/pg` imports this and no production entry point re-exports it; it is
 * a separate subpath so the driver-facing surface does not grow a test harness.
 */

import type { Pool, PoolClient } from 'pg';
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

  constructor(database: string, timeoutMs: number, lingering: readonly LingeringBackend[]) {
    const who =
      lingering.length > 0
        ? lingering
            .map((b) => `pid ${b.pid} (${b.applicationName ?? 'unnamed'}, ${b.state ?? 'unknown state'})`)
            .join(', ')
        : 'nothing was visible on the server, so the pool itself never finished closing';
    super(
      `database "${database}" was still in use ${timeoutMs}ms after its pool was closed: ${who}. ` +
        'It has been dropped so nothing leaks, but something held a connection it did not own.',
    );
    this.name = 'DatabaseTeardownTimeoutError';
    this.database = database;
    this.lingering = lingering;
  }
}

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
 * Whether an error is a connection dying because something terminated its backend.
 *
 * Two shapes, because the client sees whichever arrives first: the `FATAL` message, which carries
 * SQLSTATE 57P01, or the socket simply closing underneath it, which `pg` reports with no code at
 * all. Both were observed against PostgreSQL 16.14 while measuring a forced drop.
 */
function isForcedTermination(error: unknown): boolean {
  if (sqlState(error) === ADMIN_SHUTDOWN) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('Connection terminated');
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

/**
 * Run `work`, but stop waiting for it after `timeoutMs`.
 *
 * Checking `Date.now()` between awaits does not bound the awaits themselves: an established
 * connection that stops answering would sit past the deadline with nothing to interrupt it, which
 * would make the budget advisory rather than real. Every teardown step therefore goes through here.
 *
 * A step that times out is abandoned rather than cancelled — PostgreSQL is still holding whatever it
 * was given — so the caller goes on to end the admin pool, which is what actually drops the sockets
 * those queries are waiting on.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`withTestDatabase: ${what} exceeded its ${timeoutMs}ms budget`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  pollIntervalMs: number,
  onCheck: ((backends: readonly LingeringBackend[]) => void) | undefined,
): Promise<readonly LingeringBackend[]> {
  for (;;) {
    const { rows } = await admin.query<{
      pid: number;
      state: string | null;
      application_name: string | null;
    }>(
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
): Promise<void> {
  const absorbOwnTermination = (error: Error): void => {
    if (isForcedTermination(error)) return;
    throw error;
  };
  pool.on('error', absorbOwnTermination);
  for (const client of clients) client.on('error', absorbOwnTermination);

  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
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
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      return;
    } catch (error) {
      if (sqlState(error) !== OBJECT_IN_USE || Date.now() >= deadline) throw error;
      const lingering = await waitForQuiescence(admin, database, deadline, pollIntervalMs, onCheck);
      if (lingering.length > 0 && Date.now() >= deadline) {
        // Giving up here still has to leave the server clean: reporting the timeout without dropping
        // would leave the database behind, which is the outcome teardown works hardest to avoid.
        await forceDropAbandoned(admin, pool, clients, database);
        throw new DatabaseTeardownTimeoutError(database, teardownTimeoutMs, lingering);
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

  const lingering = await waitForQuiescence(admin, database, deadline, pollIntervalMs, onCheck);
  if (lingering.length > 0) {
    // Something outlived its owner. Drop the database anyway so the server is not littered with
    // abandoned test databases, then say precisely what was holding it.
    await forceDropAbandoned(admin, pool, clients, database);
    throw new DatabaseTeardownTimeoutError(database, teardownTimeoutMs, lingering);
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
  const admin = createPool({ connectionString, max: 2, connectionTimeoutMillis: teardownTimeoutMs });
  let dropped = false;
  let bodyFailed = false;
  let teardownFailed = false;
  let bodyError: unknown;
  let teardownError: unknown;
  let result!: T;

  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const databaseUrl = urlForDatabase(connectionString, database);
    const pool = createPool({ connectionString: databaseUrl, max: options.max ?? 4 });
    const clients = trackClients(pool);
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
        // Both teardown paths that throw a timeout have already force-dropped the database, so only
        // those are known-clean. Any other failure leaves the drop to the net below.
        dropped = error instanceof DatabaseTeardownTimeoutError;
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
        await withDeadline(
          admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
          teardownBackstopMs,
          'last-resort drop',
        );
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
