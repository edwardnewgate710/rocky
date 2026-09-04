import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { join } from 'node:path';
import { AchievementRuleError } from '@chess-platform/achievements';
import { createPool, migrate, PgAchievementsRepository } from '../src/pg/index.js';

const databaseUrl = process.env.DATABASE_URL;

/**
 * Every user this file creates. Cleanup removes exactly these and nothing else.
 *
 * This suite used to open each test with an unqualified `DELETE FROM achievement_progress` and
 * `DELETE FROM users`, which is a claim to own the whole shared database. It does not own it:
 * those statements destroyed rows belonging to other suites, and against a database that had
 * already been used they failed outright. `games.white_id` and `games.black_id` are the only
 * references to `users` without `ON DELETE CASCADE`, so one game left behind by another file made
 * the wipe abort with SQLSTATE 23503 in `beforeEach`, before any assertion in this file ran.
 *
 * Deleting this suite's own user is what it actually needed: `achievement_progress` cascades from
 * `users`, so the fixture goes with it.
 */
const FIXTURE_USER_IDS = ['018f3a5b-7c9d-7000-8000-000000000001'];

/** The bot accounts migration 0021 seeds. They belong to the schema, not to this suite. */
const SEEDED_BOT_HANDLES = ['gambit-novice', 'gambit-club', 'gambit-master'];

describe('PgAchievementsRepository (integration)', { skip: !databaseUrl }, () => {
  let pool: Pool;
  let repo: PgAchievementsRepository;

  /** Which seeded bot accounts this database actually had before the suite touched anything. */
  let seedBaseline: string[] = [];

  const seededBotsNow = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ handle: string }>(
      'SELECT handle FROM users WHERE handle = ANY($1::citext[]) ORDER BY handle',
      [SEEDED_BOT_HANDLES],
    );
    return rows.map((row) => row.handle);
  };

  /** Remove this suite's own rows. Safe when they are already gone, so it runs before and after. */
  const deleteFixtures = async (): Promise<void> => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [FIXTURE_USER_IDS]);

    // The second half of the contract, checked where it would be broken. The wipe this replaced
    // did not only destroy other suites' fixtures: it took the bot accounts migration 0021 seeds,
    // and nothing restores them — `migrate` has recorded 0021 as applied, so the database simply
    // stays without them. Widening the delete again fails here instead of silently years later.
    //
    // Compared against what this database had at `before`, not against all three. A database that
    // already ran the old suite is *already* missing them, permanently, and demanding three here
    // would fail every run on that database for a reason this suite did not cause and must not try
    // to repair — restoring schema-owned rows is not cleanup's job. Holding the count steady still
    // catches a widened delete, which is the whole point.
    assert.deepEqual(
      await seededBotsNow(),
      seedBaseline,
      'cleanup must leave rows this suite did not create, including the migration seed',
    );
  };

  before(async () => {
    pool = createPool({ connectionString: databaseUrl });
    await migrate(pool, join(process.cwd(), 'migrations'));
    seedBaseline = await seededBotsNow();
    repo = new PgAchievementsRepository(pool);
  });

  after(async () => {
    if (!pool) return;
    // Leave the shared database as this suite found it, so the next run begins from the same
    // preconditions this one did — but close the pool whatever that delete does. Awaiting the
    // cleanup first and closing second would skip `end()` on exactly the runs where cleanup
    // failed, leaving a backend attached and the worker unable to exit cleanly.
    try {
      await deleteFixtures();
    } finally {
      await pool.end();
    }
  });

  beforeEach(deleteFixtures);

  async function createTestUser(id: string, handle: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, handle) VALUES ($1, $2)`,
      [id, handle]
    );
  }

  it('awards achievement, clamps to target, and preserves unlockedAt', async () => {
    const userId = '018f3a5b-7c9d-7000-8000-000000000001';
    await createTestUser(userId, 'player1');

    const t1 = new Date('2026-08-01T10:00:00Z');
    const t2 = new Date('2026-08-01T12:00:00Z');

    // first-win target = 1
    const res1 = await repo.award(userId, 'first-win', 1, t1);
    assert.equal(res1.progress, 1);
    assert.ok(res1.unlockedAt);
    assert.equal(res1.unlockedAt.toISOString(), t1.toISOString());

    // Second award at t2
    const res2 = await repo.award(userId, 'first-win', 1, t2);
    assert.equal(res2.progress, 1);
    assert.equal(res2.unlockedAt?.toISOString(), t1.toISOString());
  });

  it('rejects unknown achievement key', async () => {
    const userId = '018f3a5b-7c9d-7000-8000-000000000001';
    await createTestUser(userId, 'player1');

    await assert.rejects(
      () => repo.award(userId, 'invalid-key', 1),
      (err: unknown) => {
        assert.ok(err instanceof AchievementRuleError);
        assert.equal(err.code, 'unknown_achievement');
        return true;
      }
    );
  });

  it('rejects non-existent player with not_found', async () => {
    const nonExistentUserId = '018f3a5b-7c9d-7000-8000-999999999999';

    await assert.rejects(
      () => repo.award(nonExistentUserId, 'first-win', 1),
      (err: unknown) => {
        assert.ok(err instanceof AchievementRuleError);
        assert.equal(err.code, 'not_found');
        return true;
      }
    );
  });

  it('cascades deletion when user is deleted', async () => {
    const userId = '018f3a5b-7c9d-7000-8000-000000000001';
    await createTestUser(userId, 'player1');

    await repo.award(userId, 'first-win', 1);

    const initialSummary = await repo.getSummary(userId);
    assert.equal(initialSummary.unlockedCount, 1);

    // Delete user
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const countRes = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM achievement_progress WHERE player_id = $1',
      [userId]
    );
    assert.equal(countRes.rows[0].count, '0');
  });

  it('sums concurrent increments and unlocks exactly once', async () => {
    const userId = '018f3a5b-7c9d-7000-8000-000000000001';
    await createTestUser(userId, 'player1');

    // Ten concurrent awards through the REPOSITORY, not through SQL this test wrote itself. The
    // previous version of this test issued its own hand-copied INSERT ... ON CONFLICT and asserted
    // on the result, so it would have passed with `award` replaced by a read-then-write: it was
    // checking that Postgres implements ON CONFLICT, which nobody doubted.
    //
    // A lost update here is not subtle. Read-then-write callers overlap, several read the same
    // value, and the total lands short of ten — leaving the achievement locked, because it never
    // reaches its target.
    const at = new Date('2026-08-02T10:00:00Z');
    await Promise.all(
      Array.from({ length: 10 }, () => repo.award(userId, 'games-10', 1, at))
    );

    const afterRace = await repo.listPlayerAchievements(userId);
    const games10 = afterRace.items.find((i) => i.key === 'games-10');
    assert.ok(games10, 'games-10 must be listed');
    assert.equal(games10.progress, 10, 'every concurrent increment must be counted');
    assert.ok(games10.unlockedAt, 'reaching the target must unlock');

    // And the unlock instant is written once. A later award must not restamp it — the date a player
    // earned something is not a field that gets to change.
    const firstUnlock = games10.unlockedAt;
    await repo.award(userId, 'games-10', 1, new Date('2026-08-02T18:00:00Z'));
    const afterExtra = await repo.listPlayerAchievements(userId);
    const games10Again = afterExtra.items.find((i) => i.key === 'games-10');
    assert.equal(games10Again?.progress, 10, 'progress must stay clamped to target');
    assert.equal(
      games10Again?.unlockedAt?.toISOString(),
      firstUnlock?.toISOString(),
      'unlockedAt must not move once set'
    );
  });
});
