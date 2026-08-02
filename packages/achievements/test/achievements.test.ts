import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AchievementRuleError,
  InMemoryAchievementsRepository,
  comparePlayerAchievements,
  evaluateGameAchievements,
  getAchievementDefinition,
  paginate,
  type FinishedGameSummary,
  type PlayerAchievementView,
} from '../src';

describe('@chess-platform/achievements', () => {
  describe('Rule 1: Idempotent and monotonic awarding & clamping to target', () => {
    it('clamps progress to target and leaves unlockedAt unchanged on duplicate awards', async () => {
      const repo = new InMemoryAchievementsRepository();
      const playerId = 'player-1';
      const t1 = new Date('2026-08-01T10:00:00Z');
      const t2 = new Date('2026-08-01T11:00:00Z');

      // First win has target = 1
      const res1 = await repo.award(playerId, 'first-win', 1, t1);
      assert.equal(res1.progress, 1);
      assert.equal(res1.unlockedAt?.toISOString(), t1.toISOString());

      // Awarding again must clamp progress to 1 and keep t1
      const res2 = await repo.award(playerId, 'first-win', 1, t2);
      assert.equal(res2.progress, 1);
      assert.equal(res2.unlockedAt?.toISOString(), t1.toISOString());
    });
  });

  describe('Rule 2: Unknown achievement key rejected', () => {
    it('throws unknown_achievement error when key is not in catalogue', async () => {
      const repo = new InMemoryAchievementsRepository();
      await assert.rejects(
        () => repo.award('player-1', 'non-existent-achievement', 1),
        (err: unknown) => {
          assert.ok(err instanceof AchievementRuleError);
          assert.equal(err.code, 'unknown_achievement');
          return true;
        }
      );
    });
  });

  describe('Rule 3: unlockedAt set exactly once when progress reaches target', () => {
    it('sets unlockedAt only when progress hits target and preserves original date', async () => {
      const repo = new InMemoryAchievementsRepository();
      const playerId = 'player-1';
      const t1 = new Date('2026-08-01T10:00:00Z');
      const t2 = new Date('2026-08-01T11:00:00Z');
      const t3 = new Date('2026-08-01T12:00:00Z');

      // games-10 requires target = 10
      const step1 = await repo.award(playerId, 'games-10', 5, t1);
      assert.equal(step1.progress, 5);
      assert.equal(step1.unlockedAt, undefined);

      // Hits target at t2
      const step2 = await repo.award(playerId, 'games-10', 5, t2);
      assert.equal(step2.progress, 10);
      assert.equal(step2.unlockedAt?.toISOString(), t2.toISOString());

      // Subsequent award at t3 does not move unlockedAt
      const step3 = await repo.award(playerId, 'games-10', 5, t3);
      assert.equal(step3.progress, 10);
      assert.equal(step3.unlockedAt?.toISOString(), t2.toISOString());
    });
  });

  describe('Rule 4: Progress increments validated', () => {
    it('rejects NaN, Infinity, and negative increments with invalid_progress', async () => {
      const repo = new InMemoryAchievementsRepository();
      const playerId = 'player-1';

      // 0.5 belongs on this list: the two adapters used to disagree about it. In memory it became
      // `progress + 0.5`; in Postgres the same value was cast into an INTEGER column and rounded.
      // Progress counts events, and half a game is a caller mistake, not a smaller amount.
      for (const invalid of [NaN, Infinity, -Infinity, -1, -5, 0.5, 2.7]) {
        await assert.rejects(
          () => repo.award(playerId, 'games-10', invalid),
          (err: unknown) => {
            assert.ok(err instanceof AchievementRuleError);
            assert.equal(err.code, 'invalid_progress');
            return true;
          }
        );
      }
    });
  });

  describe('Rule 5: Hidden achievements listing visibility', () => {
    it('omits hidden achievements when locked, but includes them once unlocked', async () => {
      const repo = new InMemoryAchievementsRepository();
      const playerId = 'player-1';

      const initialPage = await repo.listPlayerAchievements(playerId);
      const hasSecretInitial = initialPage.items.some((item) => item.key === 'secret-master');
      assert.equal(hasSecretInitial, false);

      // Unlock secret-master
      await repo.award(playerId, 'secret-master', 1);

      const unlockedPage = await repo.listPlayerAchievements(playerId);
      const secretItem = unlockedPage.items.find((item) => item.key === 'secret-master');
      assert.ok(secretItem);
      assert.equal(secretItem.progress, 1);
      assert.ok(secretItem.unlockedAt);
    });
  });

  describe('Rule 6: Sorting by unlockedAt DESC, then key ASC code-point order', () => {
    it('orders unlocked before locked, newest unlocked first, then code-point key ASC', () => {
      const t1 = new Date('2026-08-01T10:00:00Z');
      const t2 = new Date('2026-08-01T12:00:00Z');

      const items: PlayerAchievementView[] = [
        { key: 'z-locked', name: 'Z', description: '', category: 'g', tier: 'bronze', points: 10, hidden: false, progress: 0 },
        { key: 'a-locked', name: 'A', description: '', category: 'g', tier: 'bronze', points: 10, hidden: false, progress: 0 },
        { key: 'old-unlocked', name: 'Old', description: '', category: 'g', tier: 'bronze', points: 10, hidden: false, progress: 1, unlockedAt: t1 },
        { key: 'new-unlocked', name: 'New', description: '', category: 'g', tier: 'bronze', points: 10, hidden: false, progress: 1, unlockedAt: t2 },
      ];

      items.sort(comparePlayerAchievements);

      assert.deepEqual(items.map((i) => i.key), [
        'new-unlocked',
        'old-unlocked',
        'a-locked',
        'z-locked',
      ]);
    });
  });

  describe('Rule 7: Summary points and unlocked count', () => {
    it('counts only unlocked achievements for points and unlockedCount', async () => {
      const repo = new InMemoryAchievementsRepository();
      const playerId = 'player-1';

      // 0 unlocked initially
      const initialSummary = await repo.getSummary(playerId);
      assert.equal(initialSummary.unlockedCount, 0);
      assert.equal(initialSummary.pointsTotal, 0);

      // Award first-win (10 pts) and first-game (10 pts)
      await repo.award(playerId, 'first-win', 1);
      await repo.award(playerId, 'first-game', 1);

      // Partial progress on games-10 (not unlocked)
      await repo.award(playerId, 'games-10', 5);

      const summary = await repo.getSummary(playerId);
      assert.equal(summary.unlockedCount, 2);
      assert.equal(summary.pointsTotal, 20);
    });
  });

  describe('Evaluator: Pure Game Evaluation', () => {
    it('evaluates finished game awards for win, speed, and brevity', () => {
      const game: FinishedGameSummary = {
        gameId: 'g1',
        whitePlayerId: 'p1',
        blackPlayerId: 'p2',
        winnerPlayerId: 'p1',
        result: '1-0',
        speed: 'blitz',
        plyCount: 20,
      };

      const p1State = {
        playerId: 'p1',
        existingAchievements: new Map(),
      };

      const intents = evaluateGameAchievements(game, p1State);
      const keys = intents.map((i) => i.achievementKey);

      assert.ok(keys.includes('first-game'));
      assert.ok(keys.includes('first-win'));
      assert.ok(keys.includes('speed-demon'));
      assert.ok(keys.includes('quick-win'));

      // Every key the evaluator emits must exist in the catalogue. Without this, a typo produces an
      // intent the repository will reject at award time — inside a game-ended handler, where the
      // failure is a swallowed log rather than anything a test would notice.
      for (const key of keys) {
        assert.ok(
          getAchievementDefinition(key) !== undefined,
          `evaluator emitted '${key}', which the catalogue does not define`
        );
      }
    });

    it('returns empty awards for aborted games', () => {
      const game: FinishedGameSummary = {
        gameId: 'g2',
        whitePlayerId: 'p1',
        blackPlayerId: 'p2',
        result: '*',
      };

      const intents = evaluateGameAchievements(game, { playerId: 'p1', existingAchievements: new Map() });
      assert.equal(intents.length, 0);
    });
  });

  describe('Pagination contract', () => {
    it('handles NaN, negative values and offset/limit slicing', () => {
      const list = [1, 2, 3, 4, 5];
      const pageNaN = paginate(list, { limit: NaN, offset: NaN });
      assert.equal(pageNaN.total, 5);
      assert.equal(pageNaN.items.length, 0);

      const pageNormal = paginate(list, { limit: 2, offset: 1 });
      assert.equal(pageNormal.total, 5);
      assert.deepEqual(pageNormal.items, [2, 3]);
    });
  });
});
