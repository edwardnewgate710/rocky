/**
 * The contract that makes the persistence integration suite runnable twice.
 *
 * Every suite here shares one database. That is deliberate — they need a migrated schema, not a
 * private one — and it only works while each suite obeys two rules:
 *
 *   1. remove every row it created that a later run could collide with;
 *   2. never remove a row it did not create.
 *
 * Both were being broken, and the second run of the suite failed nine tests as a result. The
 * acceptance proof for that is the whole suite run three times against one database; what this
 * file pins is the *mechanism*, so the contract cannot be quietly dropped again without a test
 * saying so.
 *
 * Each test runs inside its own disposable database, so this file can make claims about what a
 * database contains — counts, absences, seed rows — that would be meaningless against a database
 * shared with twenty other suites.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from '../src/pg/migrate';
import { PgUsersRepository } from '../src/pg/repositories';
import { uuidv7 } from '../src/ids';
import { withTestDatabase } from '../src/test-support/database';
import {
  deleteFixtureUsers,
  UNATTACHABLE_TEARDOWN_WARNING,
  withSharedDatabase,
} from '../src/test-support/fixtures';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

const isolated = { connectionString: DATABASE_URL, max: 4 } as const;

/** A fixed id, like the ones the real suites use — the whole point is that reuse must be safe. */
const FIXED_USER_ID = '01918300-0000-0000-0000-0000000000ff';
const FIXED_HANDLE = 'reuse-fixture';

/** The bot accounts migration 0021 seeds. They belong to the schema, not to any suite. */
const SEEDED_BOT_HANDLES = ['gambit-novice', 'gambit-club', 'gambit-master'];

/**
 * Bring a disposable database up to the same schema the shared one has.
 *
 * The same call every real suite makes on its way in, so what these tests exercise is the schema
 * as shipped — constraints, triggers and seed rows included — rather than a convenient subset.
 */
async function migrated(pool: Pool): Promise<void> {
  await migrate(pool, join(process.cwd(), 'migrations'));
}

/**
 * How many rows carry this id — 0 or 1, since it is the primary key.
 *
 * Counted rather than selected so an absent row is `0` instead of something falsy that an
 * assertion could confuse with a row that exists. `-1` is unreachable: `count(*)` always returns a
 * row, and seeing it would mean the query itself was wrong rather than the database empty.
 */
async function countUsers(pool: Pool, id: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM users WHERE id = $1',
    [id],
  );
  return Number(rows[0]?.n ?? '-1');
}

/** Insert a game between two users, the one child of `users` that does not cascade. */
async function insertGame(pool: Pool, whiteId: string, blackId: string): Promise<string> {
  const gameId = uuidv7();
  await pool.query(
    `INSERT INTO games (id, variant, rated, speed, white_id, black_id, started_at)
     VALUES ($1, 'standard', false, 'blitz', $2, $3, now())`,
    [gameId, whiteId, blackId],
  );
  return gameId;
}

test('a suite that cleans up hands the next run the preconditions it needs', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrated(pool);
    const users = new PgUsersRepository(pool);

    // Twice, with no reset in between. The second pass is the one that used to fail: the first
    // left a row on a fixed primary key and nothing removed it, so `users.create` hit
    // `users_pkey` (SQLSTATE 23505) before any assertion ran.
    for (const pass of [1, 2]) {
      await users.create({ id: FIXED_USER_ID, handle: FIXED_HANDLE });
      assert.equal(await countUsers(pool, FIXED_USER_ID), 1, `pass ${pass} created its fixture`);
      await deleteFixtureUsers(pool, [FIXED_USER_ID]);
      assert.equal(await countUsers(pool, FIXED_USER_ID), 0, `pass ${pass} removed its fixture`);
    }
  }, isolated);
});

test('cleanup removes a fixture that owns a game, which does not cascade', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrated(pool);
    const users = new PgUsersRepository(pool);
    const white = await users.create({ id: uuidv7(), handle: `fk-white-${uuidv7().slice(0, 8)}` });
    const black = await users.create({ id: uuidv7(), handle: `fk-black-${uuidv7().slice(0, 8)}` });
    await insertGame(pool, white.id, black.id);

    // The unqualified form fails here, and this is exactly the failure the achievements suite hit
    // on every reused database: `games.white_id` references `users` with no ON DELETE clause.
    await assert.rejects(
      pool.query('DELETE FROM users WHERE id = $1', [white.id]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23503');
        assert.equal((error as { constraint?: string }).constraint, 'games_white_id_fkey');
        return true;
      },
      'a plain user delete must still be refused while a game references it',
    );

    // Ordering the delete is the whole job: the game goes first, then the users.
    await deleteFixtureUsers(pool, [white.id, black.id]);
    assert.equal(await countUsers(pool, white.id), 0);
    assert.equal(await countUsers(pool, black.id), 0);
  }, isolated);
});

test('cleanup takes only its own rows, and leaves the schema seed alone', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrated(pool);
    const users = new PgUsersRepository(pool);
    const mine = await users.create({ id: uuidv7(), handle: `mine-${uuidv7().slice(0, 8)}` });
    const theirs = await users.create({ id: uuidv7(), handle: `theirs-${uuidv7().slice(0, 8)}` });
    const otherGame = await insertGame(pool, theirs.id, theirs.id);

    await deleteFixtureUsers(pool, [mine.id]);

    assert.equal(await countUsers(pool, mine.id), 0, 'its own row is gone');
    assert.equal(await countUsers(pool, theirs.id), 1, "another suite's user is untouched");
    const survivingGame = await pool.query('SELECT id FROM games WHERE id = $1', [otherGame]);
    assert.equal(survivingGame.rowCount, 1, "another suite's game is untouched");

    // The unqualified `DELETE FROM users` this replaced did not only destroy other suites' rows.
    // It destroyed the bot accounts migration 0021 seeds, and nothing puts them back: `migrate`
    // has already recorded 0021 as applied, so the database stayed missing them for good.
    const seeded = await pool.query<{ handle: string }>(
      'SELECT handle FROM users WHERE handle = ANY($1::citext[]) ORDER BY handle',
      [SEEDED_BOT_HANDLES],
    );
    assert.equal(seeded.rowCount, SEEDED_BOT_HANDLES.length, 'migration seed rows survive a suite');
  }, isolated);
});

test('a fixed handle from an earlier run cannot poison the next one', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    await migrated(pool);
    const users = new PgUsersRepository(pool);

    // A different id but the same handle is the other half of the collision: `users.handle` is
    // UNIQUE, so cleanup that removed the row by id only would still leave the handle taken.
    await users.create({ id: FIXED_USER_ID, handle: FIXED_HANDLE });
    await deleteFixtureUsers(pool, [FIXED_USER_ID]);
    const reused = await users.create({ id: uuidv7(), handle: FIXED_HANDLE });
    assert.equal(reused.handle, FIXED_HANDLE, 'the handle is free again');
  }, isolated);
});

test('cleanup runs even when the body threw, and does not replace its error', { skip }, async () => {
  await withTestDatabase(async ({ pool: owned, connectionString }) => {
    await migrated(owned);
    const shared = { connectionString, max: 2 };
    const userId = FIXED_USER_ID;
    let cleaned = 0;

    const boom = new Error('the assertion that actually failed');
    await assert.rejects(
      withSharedDatabase({
        ...shared,
        cleanup: async (pool) => {
          cleaned += 1;
          await deleteFixtureUsers(pool, [userId]);
        },
      }, async (pool) => {
        await new PgUsersRepository(pool).create({ id: userId, handle: FIXED_HANDLE });
        throw boom;
      }),
      (error: unknown) => {
        assert.equal(error, boom, 'the body error is what surfaces, not a teardown error');
        return true;
      },
    );
    assert.equal(cleaned, 1, 'cleanup ran despite the failure');

    // And the half-built fixture really is gone, so the next run starts where this one did.
    assert.equal(await countUsers(owned, userId), 0, 'the failed run kept no residue');
  }, isolated);
});

test('when the body and the cleanup both fail, the body error still wins', { skip }, async () => {
  await withTestDatabase(async ({ connectionString }) => {
    // The test above only ever had cleanup succeed, so it could not tell the precedence rule from
    // its absence — swapping the two throws left it passing. This is the case that separates them.
    const boom = new Error('the assertion that actually failed');
    const cleanupFailure = new Error('and cleanup could not run either');

    await assert.rejects(
      withSharedDatabase({
        connectionString,
        max: 2,
        cleanup: () => Promise.reject(cleanupFailure),
      }, () => Promise.reject(boom)),
      (error: unknown) => {
        assert.equal(error, boom, 'losing the real failure to a teardown error is the worse trade');
        assert.equal((error as Error).cause, cleanupFailure, 'the teardown failure is kept as cause');
        return true;
      },
    );
  }, isolated);
});

test('a body error that already has a cause still carries the teardown failure', { skip }, async () => {
  await withTestDatabase(async ({ connectionString }) => {
    // Repositories wrap driver errors and keep the original as `cause`, so a body failing inside
    // one arrives here with that link already taken. Writing only to `error.cause` dropped the
    // teardown failure in exactly that case — the common one, not an edge.
    const original = new Error('the driver error underneath');
    const boom = new Error('the assertion that actually failed', { cause: original });
    const cleanupFailure = new Error('and cleanup could not run either');

    await assert.rejects(
      withSharedDatabase({
        connectionString,
        max: 2,
        cleanup: () => Promise.reject(cleanupFailure),
      }, () => Promise.reject(boom)),
      (error: unknown) => {
        assert.equal(error, boom, 'the body error is still what surfaces');
        assert.equal((error as Error).cause, original, 'and keeps the cause it arrived with');
        assert.equal(original.cause, cleanupFailure, 'the teardown failure took the next free link');
        return true;
      },
    );
  }, isolated);
});

test('a teardown failure with nowhere to attach is warned about, not dropped', { skip }, async () => {
  await withTestDatabase(async ({ connectionString }) => {
    // A primitive has nowhere to hang a cause, so the teardown failure cannot ride along. What
    // must not change is the value the caller catches: wrapping it to make room would break every
    // `assert.rejects` predicate that compares identity. So it goes out as a warning instead —
    // the difference between a limitation and a swallowed error.
    const warnings: Error[] = [];
    const collect = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', collect);
    try {
      await assert.rejects(
        withSharedDatabase({
          connectionString,
          max: 2,
          cleanup: () => Promise.reject(new Error('cleanup could not run')),
        }, () => Promise.reject('a bare string')),
        (error: unknown) => {
          assert.equal(error, 'a bare string', 'the rejected value is rethrown untouched');
          return true;
        },
      );
      // `emitWarning` defers to `process.nextTick`, which runs before any `setImmediate` — so this
      // is an ordering guarantee rather than a wait, and the assertion below cannot race it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', collect);
    }

    const reported = warnings.filter((w) => w.name === UNATTACHABLE_TEARDOWN_WARNING);
    assert.equal(reported.length, 1, 'the cleanup failure was reported exactly once');
    assert.match(reported[0]?.message ?? '', /cleanup could not run/);
  }, isolated);
});

test('a frozen body error is rethrown, not replaced by the attempt to annotate it', { skip }, async () => {
  await withTestDatabase(async ({ connectionString }) => {
    // Writing `cause` on a frozen error throws a TypeError in strict mode. Escaping, that TypeError
    // would replace the body failure with a complaint about a property assignment — the exact loss
    // this helper exists to prevent, introduced by the code that was meant to preserve more.
    const boom = Object.freeze(new Error('the assertion that actually failed'));
    const cleanupFailure = new Error('and cleanup could not run either');

    const warnings: Error[] = [];
    const collect = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', collect);
    try {
      await assert.rejects(
        withSharedDatabase({
          connectionString,
          max: 2,
          cleanup: () => Promise.reject(cleanupFailure),
        }, () => Promise.reject(boom)),
        (error: unknown) => {
          assert.equal(error, boom, 'the body error survives an error that cannot be annotated');
          return true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', collect);
    }

    // And the teardown failure is not lost just because it had nowhere to go.
    const reported = warnings.filter((w) => w.name === UNATTACHABLE_TEARDOWN_WARNING);
    assert.equal(reported.length, 1, 'the cleanup failure fell through to the warning path');
  }, isolated);
});

test('a body error whose cause getter throws is still the error that surfaces', { skip }, async () => {
  await withTestDatabase(async ({ connectionString }) => {
    // Walking the chain reads `cause` on an object this helper did not create, so the read itself
    // can run someone else's getter. Frozen errors were the write half of the same problem; this
    // is the read half, and it escaped the guard that only wrapped the assignment.
    const boom = new Error('the assertion that actually failed');
    Object.defineProperty(boom, 'cause', {
      configurable: true,
      get() {
        throw new Error('reading the cause blew up');
      },
    });
    const cleanupFailure = new Error('and cleanup could not run either');

    const warnings: Error[] = [];
    const collect = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', collect);
    try {
      await assert.rejects(
        withSharedDatabase({
          connectionString,
          max: 2,
          cleanup: () => Promise.reject(cleanupFailure),
        }, () => Promise.reject(boom)),
        (error: unknown) => {
          assert.equal(error, boom, 'annotating must never replace the failure being annotated');
          return true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', collect);
    }

    const reported = warnings.filter((w) => w.name === UNATTACHABLE_TEARDOWN_WARNING);
    assert.equal(reported.length, 1, 'the cleanup failure fell through to the warning path');
  }, isolated);
});

test('a teardown failure that cannot even be described still loses to the body error', { skip }, async () => {
  await withTestDatabase(async ({ connectionString }) => {
    // The last place an exception could still be raised while recording a secondary failure:
    // describing it. Reading `stack` runs a getter on someone else's object, and this one throws.
    const cleanupFailure = new Error('cleanup could not run');
    Object.defineProperty(cleanupFailure, 'stack', {
      configurable: true,
      get() {
        throw new Error('and reading its stack blew up too');
      },
    });

    const warnings: Error[] = [];
    const collect = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', collect);
    try {
      await assert.rejects(
        withSharedDatabase({
          connectionString,
          max: 2,
          cleanup: () => Promise.reject(cleanupFailure),
          // A primitive, so the failure has to go down the describe-and-warn path.
        }, () => Promise.reject('a bare string')),
        (error: unknown) => {
          assert.equal(error, 'a bare string', 'the body failure survives all of this');
          return true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', collect);
    }

    // It still says something, rather than emitting nothing because the description failed.
    const reported = warnings.filter((w) => w.name === UNATTACHABLE_TEARDOWN_WARNING);
    assert.equal(reported.length, 1, 'the cleanup failure was still reported');
    assert.match(reported[0]?.message ?? '', /describing the failure threw/);
  }, isolated);
});

test('a cleanup that fails is reported rather than swallowed', { skip }, async () => {
  await withTestDatabase(async ({ pool, connectionString }) => {
    await migrated(pool);
    const failure = new Error('cleanup could not run');
    await assert.rejects(
      withSharedDatabase({
        connectionString,
        max: 2,
        cleanup: () => Promise.reject(failure),
      }, async () => undefined),
      (error: unknown) => {
        assert.equal(error, failure, 'a passing body must not hide a broken cleanup');
        return true;
      },
    );
  }, isolated);
});

test('re-migrating a used database leaves the ledger byte-for-byte alone', { skip }, async () => {
  await withTestDatabase(async ({ pool }) => {
    const dir = join(process.cwd(), 'migrations');
    const ledger = async (): Promise<string> => {
      const { rows } = await pool.query<{ row: string }>(
        `SELECT version || ':' || checksum || ':' || state AS row
           FROM schema_migrations ORDER BY version`,
      );
      return rows.map((r) => r.row).join('\n');
    };

    assert.ok((await migrate(pool, dir)) > 0, 'the first run applies the ledger');
    const afterFirst = await ledger();
    assert.ok(afterFirst.length > 0, 'the ledger recorded something to compare against');

    // Nearly every suite calls `migrate()` on the way in, so on a reused database it runs many
    // times over. `pg.integration.test.ts` already pins that it applies nothing; what matters
    // here is that it also *rewrites* nothing — a re-run that restamped checksums or flipped a
    // state would corrupt the ledger for every suite that migrated after it.
    assert.equal(await migrate(pool, dir), 0, 're-running applies nothing');
    assert.equal(await ledger(), afterFirst, 'and records nothing new');
    assert.equal(await migrate(pool, dir), 0, 'still nothing the third time');
    assert.equal(await ledger(), afterFirst, 'the ledger is unchanged after repeated runs');
  }, isolated);
});
