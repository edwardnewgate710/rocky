import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { join } from 'node:path';
import { AchievementRuleError } from '@chess-platform/achievements';
import { createPool, migrate, PgAchievementsRepository } from '../src/pg/index.js';

const databaseUrl = process.env.DATABASE_URL;

describe('PgAchievementsRepository (integration)', { skip: !databaseUrl }, () => {
  let pool: Pool;
  let repo: PgAchievementsRepository;

  before(async () => {
    pool = createPool({ connectionString: databaseUrl });
    await migrate(pool, join(process.cwd(), 'migrations'));
    repo = new PgAchievementsRepository(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM achievement_progress');
    await pool.query('DELETE FROM users');
  });

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
