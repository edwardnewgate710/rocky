import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AchievementsController } from '../src/app/achievements-controller.js';
import { httpErrorFrom } from '../src/net/errors.js';
import type { AchievementSummary, PlayerAchievement } from '../src/api/models.js';

const ACHIEVEMENT: PlayerAchievement = {
  key: 'first-win',
  name: 'Victory',
  description: 'Win your first game.',
  category: 'games',
  tier: 'bronze',
  points: 10,
  hidden: false,
  progress: 0,
  unlockedAt: null,
};

const SUMMARY: AchievementSummary = { unlockedCount: 0, pointsTotal: 0 };

interface Captured {
  readonly loaded: number;
  readonly unavailable: number;
  readonly errors: string[];
  readonly requests: number;
}

/**
 * `failWith` is thrown by both endpoints; pass `null` to answer normally. The request counter spans
 * both, which is what makes "stopped asking" observable.
 */
function makeController(failWith: unknown = null) {
  let requests = 0;
  let loaded = 0;
  let unavailable = 0;
  const errors: string[] = [];
  const client = {
    achievements: {
      forPlayer: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return { total: 1, items: [ACHIEVEMENT] };
      },
      summary: async () => {
        requests += 1;
        if (failWith !== null) throw failWith;
        return SUMMARY;
      },
    },
  };
  const controller = new AchievementsController({
    client: client as never,
    callbacks: {
      onAchievements: () => { loaded += 1; },
      onError: (message) => { errors.push(message); },
      onUnavailable: () => { unavailable += 1; },
    },
  });
  const captured: Captured = {
    get loaded() { return loaded; },
    get unavailable() { return unavailable; },
    get errors() { return errors; },
    get requests() { return requests; },
  } as Captured;
  return { controller, captured };
}

test('a deployment without achievements is asked once, then never again', async () => {
  const { controller, captured } = makeController(httpErrorFrom(503, undefined));

  await controller.load('player-1');
  assert.equal(captured.unavailable, 1);
  assert.equal(captured.errors.length, 0);
  assert.equal(captured.loaded, 0);
  const afterFirstProfile = captured.requests;

  // Visiting two more profiles. The answer is a deployment setting, so re-asking would spend two
  // more requests per profile — each one retried, because 503 is classified retryable.
  await controller.load('player-2');
  await controller.load('player-3');
  assert.equal(captured.requests, afterFirstProfile);
  assert.equal(captured.unavailable, 1);
});

test('a server fault is reported and does not stop the section asking', async () => {
  const { controller, captured } = makeController(httpErrorFrom(500, undefined));

  await controller.load('player-1');
  assert.equal(captured.errors.length, 1);
  assert.equal(captured.unavailable, 0);

  // A 500 is transient in a way a missing subsystem is not: the next profile must still try.
  await controller.load('player-2');
  assert.equal(captured.errors.length, 2);
});

test('a foreign error carrying status 503 is reported rather than hiding the section', async () => {
  // Not every object with a `status` is the API answering — a transport or third-party failure can
  // carry one too, and silently removing the section on one would hide a real fault.
  const foreign = Object.assign(new Error('socket closed'), { status: 503 });
  const { controller, captured } = makeController(foreign);

  await controller.load('player-1');
  assert.equal(captured.unavailable, 0);
  assert.deepEqual(captured.errors, ['socket closed']);
});
