import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from './helpers.js';

describe('Achievements REST API', () => {
  let harness: Harness;
  let user1: { userId: string; token: string };

  before(async () => {
    harness = await startHarness();
    user1 = await harness.makeUser('PlayerOne');
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('GET /v1/achievements', () => {
    it('returns the public catalogue of achievement definitions (hidden excluded)', async () => {
      const res = await harness.json('GET', '/v1/achievements');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      assert.ok(res.body.items.length > 0);

      // Verify no hidden achievements in public catalogue
      const hasHidden = res.body.items.some((item: any) => item.hidden === true);
      assert.equal(hasHidden, false);

      // Verify structure of an item
      const item = res.body.items[0];
      assert.ok(item.key);
      assert.ok(item.name);
      assert.ok(item.description);
      assert.ok(item.category);
      assert.ok(item.tier);
      assert.equal(typeof item.points, 'number');
    });
  });

  describe('GET /v1/players/:playerId/achievements', () => {
    it('returns 422 for malformed UUID path parameter', async () => {
      const res = await harness.json('GET', '/v1/players/invalid-uuid/achievements');
      assert.equal(res.status, 422);
    });

    it('returns 404 for non-existent player', async () => {
      const nonExistentId = '018f3a5b-7c9d-7000-8000-999999999999';
      const res = await harness.json('GET', `/v1/players/${nonExistentId}/achievements`);
      assert.equal(res.status, 404);
    });

    it('returns paginated player achievements with progress', async () => {
      // Award an achievement to user1
      await harness.achievementsRepository?.award(user1.userId, 'first-win', 1);

      const res = await harness.json('GET', `/v1/players/${user1.userId}/achievements?limit=10&offset=0`);
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.total, 'number');
      assert.ok(Array.isArray(res.body.items));

      const firstWin = res.body.items.find((item: any) => item.key === 'first-win');
      assert.ok(firstWin);
      assert.equal(firstWin.progress, 1);
      assert.ok(firstWin.unlockedAt);
    });
  });

  describe('GET /v1/players/:playerId/achievements/summary', () => {
    it('returns 422 for malformed UUID path parameter', async () => {
      const res = await harness.json('GET', '/v1/players/not-a-uuid/achievements/summary');
      assert.equal(res.status, 422);
    });

    it('returns 404 for non-existent player', async () => {
      const nonExistentId = '018f3a5b-7c9d-7000-8000-999999999999';
      const res = await harness.json('GET', `/v1/players/${nonExistentId}/achievements/summary`);
      assert.equal(res.status, 404);
    });

    it('returns summary count and points total for existing player', async () => {
      const res = await harness.json('GET', `/v1/players/${user1.userId}/achievements/summary`);
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.unlockedCount, 'number');
      assert.equal(typeof res.body.pointsTotal, 'number');
      assert.ok(res.body.unlockedCount >= 1);
      assert.ok(res.body.pointsTotal >= 10);
    });
  });

  describe('503 Fallback when achievementsRepository is omitted', () => {
    let unconfiguredHarness: Harness;

    before(async () => {
      unconfiguredHarness = await startHarness({}, { withoutAchievements: true });
    });

    after(async () => {
      if (unconfiguredHarness) {
        await unconfiguredHarness.close();
      }
    });

    it('returns 503 for every achievements route', async () => {
      const validUuid = '018f3a5b-7c9d-7000-8000-000000000001';

      const routes = [
        ['GET', '/v1/achievements'],
        ['GET', `/v1/players/${validUuid}/achievements`],
        ['GET', `/v1/players/${validUuid}/achievements/summary`],
      ];

      for (const [method, path] of routes) {
        const res = await unconfiguredHarness.json(method, path);
        assert.equal(res.status, 503, `Route ${method} ${path} should respond 503 when repo unconfigured`);
      }
    });
  });
});
