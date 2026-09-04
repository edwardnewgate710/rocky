/**
 * @packageDocumentation
 * Owning your own rows in a database you share.
 *
 * {@link ../test-support/database!withTestDatabase} answers the other half of the same question:
 * a suite that needs an empty or exclusive database gets a disposable one. This file is for the
 * suites that legitimately share the database `DATABASE_URL` points at — they need a migrated
 * schema, not a private one — and whose only obligation is to leave it as they found it.
 *
 * The contract those suites must meet is narrow and was not being met:
 *
 * - remove every row the suite created that a later run could collide with;
 * - never remove a row the suite did not create.
 *
 * Both halves matter. A suite that skips the first leaves its fixed primary keys behind and the
 * next run fails on `users_pkey` or `tournaments_pkey`. A suite that ignores the second reaches
 * for an unqualified `DELETE FROM users`, which destroys other suites' fixtures and, once any
 * `games` row exists, cannot even succeed — `games.white_id` and `games.black_id` are the only
 * references to `users` without `ON DELETE CASCADE`, so the wipe aborts with SQLSTATE 23503.
 *
 * Test-only, like its sibling: nothing under `src/pg` imports it and no production entry point
 * re-exports it.
 */

import type { Pool } from 'pg';
import { createPool } from '../pg/pool';

export interface SharedDatabaseOptions {
  /** Server and database to connect to. Defaults to `DATABASE_URL`, like {@link createPool}. */
  readonly connectionString?: string;
  /**
   * Pool size. These suites share a server with every other integration file, so the driver
   * default of ten connections per suite is pressure none of them needs.
   */
  readonly max?: number;
  /**
   * Removes exactly the rows the body created, and nothing else.
   *
   * It runs whether the body passed or failed, so it must tolerate rows that were never created —
   * a body that failed halfway leaves a partial fixture, and a `DELETE` that matches nothing is
   * the correct outcome, not an error.
   */
  readonly cleanup: (pool: Pool) => Promise<unknown>;
}

/**
 * Run `body` against the shared database, then remove the rows it owns.
 *
 * Failure precedence is the point of this helper, and it is the part that a plain `try/finally`
 * gets wrong. A `finally` that awaits cleanup lets a cleanup rejection *replace* the assertion
 * that actually failed, so the run reports a `DELETE` that could not run instead of the defect
 * that made it necessary. Here the body's failure always wins — the value the body rejected with
 * is the value rethrown, unchanged — and cleanup failing on its own is reported rather than
 * swallowed, because silence there would let a suite quietly stop cleaning up and reintroduce
 * exactly this defect.
 *
 * When both fail, the teardown error rides along on the body error's `cause` chain, at the first
 * free link rather than only the first: an error that already carries a `cause` used to drop the
 * teardown failure entirely. A body that rejects with a primitive has nowhere to hang a property,
 * and wrapping the value or throwing an `AggregateError` to make room would change what the caller
 * catches — the one thing this helper exists to keep stable. That value is rethrown exactly as it
 * was, and the teardown failure goes out as a process warning instead, so the one case that cannot
 * carry a cause is still not a silent one.
 */
export async function withSharedDatabase<T>(
  options: SharedDatabaseOptions,
  body: (pool: Pool) => Promise<T>,
): Promise<T> {
  // Both are safe to pass through undefined: `createPool` falls back to `DATABASE_URL`, and `pg`
  // applies its own default pool size.
  const pool = createPool({ connectionString: options.connectionString, max: options.max });

  // `undefined` is a legal rejection value, so the flags carry whether something failed and the
  // paired variable carries only what it failed with.
  let bodyFailed = false;
  let bodyError: unknown;
  let teardownFailed = false;
  let teardownError: unknown;
  let result!: T;

  try {
    result = await body(pool);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  try {
    await options.cleanup(pool);
  } catch (error) {
    teardownFailed = true;
    teardownError = error;
  }

  try {
    await pool.end();
  } catch (error) {
    if (!teardownFailed) {
      teardownFailed = true;
      teardownError = error;
    }
  }

  if (bodyFailed) {
    if (teardownFailed && !tryAttachCause(bodyError, teardownError)) {
      reportUnattachableTeardownFailure(teardownError);
    }
    throw bodyError;
  }
  if (teardownFailed) {
    throw teardownError;
  }
  return result;
}

/** The `type` on the warning emitted when a teardown failure has nowhere to be attached. */
export const UNATTACHABLE_TEARDOWN_WARNING = 'PersistenceTestTeardownFailure';

/**
 * Hang `addition` off the first free `cause` link under `error`. Reports whether it found one.
 *
 * Setting only `error.cause` drops the addition whenever the primary error already has one, which
 * is common: repositories wrap driver errors and keep the original as the cause. Walking to the
 * end keeps both. The `seen` set is not theoretical tidiness — an error whose cause chain loops
 * back on itself would otherwise spin here forever, inside teardown, with no test to blame.
 */
function tryAttachCause(error: unknown, addition: unknown): boolean {
  const seen = new Set<unknown>();
  let link = error;
  while (link instanceof Error && !seen.has(link)) {
    if (link.cause === undefined) {
      link.cause = addition;
      return true;
    }
    seen.add(link);
    link = link.cause;
  }
  return false;
}

/**
 * Say out loud that a cleanup failed, when the failure it happened alongside cannot carry it.
 *
 * A warning rather than a throw, because the body's failure is the one the run must report. It
 * leaves the thrown value untouched and still puts the cleanup failure — and its stack — in front
 * of whoever reads the output, which is the whole difference between a documented limitation and
 * a swallowed error.
 */
function reportUnattachableTeardownFailure(teardownError: unknown): void {
  const detail =
    teardownError instanceof Error
      ? (teardownError.stack ?? `${teardownError.name}: ${teardownError.message}`)
      : `cleanup rejected with a non-Error value: ${String(teardownError)}`;
  process.emitWarning(detail, {
    type: UNATTACHABLE_TEARDOWN_WARNING,
    detail: 'the body rejected with a value that cannot carry a cause, so this could not ride along',
  });
}

/**
 * Delete these users and the rows that depend on them.
 *
 * Almost everything referencing `users` cascades, so deleting the user is enough — but `games`
 * does not cascade, and a fixture that gave its users a game cannot be removed until the game is.
 * Callers that never create games get the same answer from the second statement alone; doing both
 * unconditionally means a caller does not have to know which of the two it is.
 */
export async function deleteFixtureUsers(pool: Pool, userIds: readonly string[]): Promise<void> {
  const ids = [...userIds];
  await pool.query('DELETE FROM games WHERE white_id = ANY($1::uuid[]) OR black_id = ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
}
