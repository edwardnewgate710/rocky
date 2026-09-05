/**
 * `UsersRepository.findByIds` against a real Postgres.
 *
 * The in-memory adapter answers this with a `Map` lookup, which cannot fail the way the query can:
 * `= ANY($1::uuid[])` casts the whole array, so a single element that is not a UUID aborts the read
 * with SQLSTATE 22P02 and takes every other id in the batch with it. The GraphQL loader batches
 * caller-supplied ids, so that case is reachable from the wire — which is why it is pinned here and
 * not left to the fake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { migrate } from '../src/pg/migrate';
import { PgUsersRepository } from '../src/pg/repositories';
import { uuidv7 } from '../src/ids';
import { deleteFixtureUsers, withSharedDatabase } from '../src/test-support/fixtures';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('users pg repository: findByIds batches, drops unknown ids, and survives malformed ones', { skip }, async () => {
  // Filled as rows are created, so cleanup removes exactly what this test made — including the
  // partial fixture a failure halfway through would otherwise leave in the shared database.
  const createdUserIds: string[] = [];
  await withSharedDatabase({
    cleanup: (pool) => deleteFixtureUsers(pool, createdUserIds),
  }, async (pool) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgUsersRepository(pool);

    const suffix = uuidv7().slice(0, 8);
    const alice = await repo.create({ id: uuidv7(), handle: `batch-alice-${suffix}` });
    createdUserIds.push(alice.id);
    const bob = await repo.create({ id: uuidv7(), handle: `batch-bob-${suffix}` });
    createdUserIds.push(bob.id);

    const both = await repo.findByIds([alice.id, bob.id]);
    assert.equal(both.length, 2);
    assert.deepEqual(
      [...both].map((u) => u.id).sort(),
      [alice.id, bob.id].sort(),
      'both rows come back, keyed by id rather than by position',
    );

    // A well-formed id belonging to nobody is simply absent — the same answer findById gives.
    const withMissing = await repo.findByIds([alice.id, uuidv7()]);
    assert.equal(withMissing.length, 1);
    assert.equal(withMissing[0]?.id, alice.id);

    // The case the fake cannot reproduce: one unparseable id must not fail the whole batch.
    const withMalformed = await repo.findByIds(['not-a-uuid', alice.id, '']);
    assert.equal(withMalformed.length, 1);
    assert.equal(withMalformed[0]?.id, alice.id);

    assert.deepEqual(await repo.findByIds([]), []);
    assert.deepEqual(await repo.findByIds(['not-a-uuid']), []);

    // The batched read agrees with the single-key read it replaces.
    const single = await repo.findById(alice.id);
    assert.deepEqual(withMissing[0], single);
  });

  // Checked from outside, after cleanup has run and its pool is closed.
  //
  // These ids are freshly minted, so leaving them behind never made a later run *fail* — the table
  // just grew every time anyone ran the suite against a database they reuse. Nothing inside the
  // run can notice that, which is precisely why the check has to be an explicit one.
  await withSharedDatabase({ cleanup: async () => undefined }, async (pool) => {
    const remaining = await pool.query(
      'SELECT count(*)::text AS n FROM users WHERE id = ANY($1::uuid[])',
      [createdUserIds],
    );
    assert.equal(remaining.rows[0]?.n, '0', 'the suite removed the users it created');
  });
});
