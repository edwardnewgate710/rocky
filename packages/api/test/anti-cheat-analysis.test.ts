import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { NoEngineForVariantError } from '@chess-platform/engine';
import type { PositionEvaluator } from '@chess-platform/anti-cheat';
import { startHarness } from './helpers';

function createFinishedGameEvents(gameId: string, white: string, black: string) {
  const timeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const };
  let { game, events } = Game.create({
    gameId,
    timeControl,
    players: { white, black },
    rated: true,
    at: 1000,
  });
  const allEvents = [...events];
  let t = 2000;
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    ({ game, events } = game.playMove(uci, t));
    allEvents.push(...events);
    t += 1000;
  }
  return allEvents;
}

test('POST /v1/moderation/anti-cheat/games/:gameId/analyze: successful analysis as moderator', async () => {
  const harness = await startHarness();
  try {
    const mod = await harness.makeUser('mod', ['moderator']);
    const white = await harness.makeUser('white_player');
    const black = await harness.makeUser('black_player');
    const gameId = '11111111-1111-7111-8111-111111111111';

    const events = createFinishedGameEvents(gameId, white.userId, black.userId);
    await harness.antiCheatEventStore.append(gameId, -1, events);

    const res = await harness.json('POST', `/v1/moderation/anti-cheat/games/${gameId}/analyze`, {
      token: mod.token,
      body: { depth: 18 },
    });

    assert.equal(res.status, 200);
    assert.ok(res.body.white);
    assert.ok(res.body.black);
    assert.equal(typeof res.body.white.sampleSize, 'number');
    assert.ok(['clean', 'review', 'high'].includes(res.body.white.suspicion));
    assert.equal(typeof res.body.black.sampleSize, 'number');
    assert.ok(['clean', 'review', 'high'].includes(res.body.black.suspicion));

    // Follow-up: verify reports were stored and accessible via inc-5 GET endpoint
    const listRes = await harness.json('GET', `/v1/moderation/anti-cheat/players/${white.userId}/games`, {
      token: mod.token,
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].gameId, gameId);
    assert.equal(listRes.body[0].playerId, white.userId);
  } finally {
    await harness.close();
  }
});

test('POST /v1/moderation/anti-cheat/games/:gameId/analyze: auth and role checks', async () => {
  const harness = await startHarness();
  try {
    const user = await harness.makeUser('plain_user');
    const gameId = '11111111-1111-7111-8111-111111111111';

    // Plain user -> 403
    const resUser = await harness.json('POST', `/v1/moderation/anti-cheat/games/${gameId}/analyze`, {
      token: user.token,
    });
    assert.equal(resUser.status, 403);

    // Unauthenticated -> 401
    const resAnon = await harness.json('POST', `/v1/moderation/anti-cheat/games/${gameId}/analyze`);
    assert.equal(resAnon.status, 401);
  } finally {
    await harness.close();
  }
});

test('POST /v1/moderation/anti-cheat/games/:gameId/analyze: error cases (404, 422)', async () => {
  const harness = await startHarness();
  try {
    const mod = await harness.makeUser('mod', ['moderator']);
    const unknownGameId = '99999999-9999-7999-8999-999999999999';

    // Unknown gameId -> 404
    const res404 = await harness.json('POST', `/v1/moderation/anti-cheat/games/${unknownGameId}/analyze`, {
      token: mod.token,
    });
    assert.equal(res404.status, 404);

    // Malformed gameId -> 422
    const res422Id = await harness.json('POST', '/v1/moderation/anti-cheat/games/not-a-uuid/analyze', {
      token: mod.token,
    });
    assert.equal(res422Id.status, 422);

    // Out-of-range depth (below min 8) -> 422
    const res422Depth = await harness.json('POST', `/v1/moderation/anti-cheat/games/${unknownGameId}/analyze`, {
      token: mod.token,
      body: { depth: 3 },
    });
    assert.equal(res422Depth.status, 422);
  } finally {
    await harness.close();
  }
});

test('POST /v1/moderation/anti-cheat/games/:gameId/analyze: returns 503 when engine not configured', async () => {
  const harness = await startHarness({}, { withoutAntiCheatAnalysis: true });
  try {
    const mod = await harness.makeUser('mod', ['moderator']);
    const gameId = '11111111-1111-7111-8111-111111111111';

    const res = await harness.json('POST', `/v1/moderation/anti-cheat/games/${gameId}/analyze`, {
      token: mod.token,
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'anti-cheat analysis engine is not configured');
  } finally {
    await harness.close();
  }
});

test('POST /v1/moderation/anti-cheat/games/:gameId/analyze: returns 503 when no engine supports the variant', async () => {
  const throwingEvaluator: PositionEvaluator = {
    evaluate: () => {
      throw new NoEngineForVariantError('standard');
    },
  };
  const harness = await startHarness({}, { antiCheatEvaluator: throwingEvaluator });
  try {
    const mod = await harness.makeUser('mod', ['moderator']);
    const white = await harness.makeUser('white_player');
    const black = await harness.makeUser('black_player');
    const gameId = '55555555-5555-7555-8555-555555555555';

    const events = createFinishedGameEvents(gameId, white.userId, black.userId);
    await harness.antiCheatEventStore.append(gameId, -1, events);

    const res = await harness.json('POST', `/v1/moderation/anti-cheat/games/${gameId}/analyze`, {
      token: mod.token,
      body: { depth: 18 },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
  } finally {
    await harness.close();
  }
});
