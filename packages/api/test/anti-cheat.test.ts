import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PlayerCorrelationReport } from '@chess-platform/anti-cheat';
import { uuidv7 } from '@chess-platform/persistence';
import { startHarness } from './helpers';

function makeReport(suspicion: 'clean' | 'review' | 'high' = 'clean'): PlayerCorrelationReport {
  return {
    suspicion,
    acpl: 12,
    acplCapped: 12,
    t1Rate: 0.75,
    t3Rate: 0.85,
    onlyMoveExcluded: 3,
    sampleSize: 40,
    unscored: 0,
    lowConfidence: false,
    t1Matches: 30,
    t3Matches: 34,
    tRateSampleCount: 40,
    rawCentipawnLossTotal: 480,
    cappedCentipawnLossTotal: 480,
  };
}

test('moderation anti-cheat endpoints: permissions and report retrieval', async () => {
  const h = await startHarness();
  try {
    const mod = await h.makeUser('mod', ['moderator']);
    const plainUser = await h.makeUser('plain', ['user']);
    const targetPlayer = await h.makeUser('target', ['user']);

    const gameId1 = uuidv7();
    const gameId2 = uuidv7();

    await h.repos.antiCheat.saveBatch([
      {
        gameId: gameId1,
        playerId: targetPlayer.userId,
        color: 'white',
        report: makeReport('clean'),
      },
      {
        gameId: gameId2,
        playerId: targetPlayer.userId,
        color: 'black',
        report: makeReport('review'),
      },
    ]);

    // 1. Moderator GETs aggregate
    const aggRes = await h.json('GET', `/v1/moderation/anti-cheat/players/${targetPlayer.userId}`, {
      token: mod.token,
    });
    assert.equal(aggRes.status, 200);
    assert.equal(aggRes.body.playerId, targetPlayer.userId);
    assert.equal(aggRes.body.gamesAnalyzed, 2);
    assert.equal(aggRes.body.pooledSampleSize, 80);
    assert.equal(aggRes.body.pooledTRateSampleCount, 80);
    assert.deepEqual(aggRes.body.flaggedGameIds, [gameId2]);

    // 2. Moderator GETs per-game reports
    const gamesRes = await h.json('GET', `/v1/moderation/anti-cheat/players/${targetPlayer.userId}/games`, {
      token: mod.token,
    });
    assert.equal(gamesRes.status, 200);
    assert.equal(gamesRes.body.length, 2);
    assert.equal(gamesRes.body[0].gameId, gameId1);
    assert.equal(gamesRes.body[0].color, 'white');
    assert.equal(gamesRes.body[1].gameId, gameId2);
    assert.equal(gamesRes.body[1].color, 'black');

    // 3. Plain user gets 403 on both
    const plainAgg = await h.json('GET', `/v1/moderation/anti-cheat/players/${targetPlayer.userId}`, {
      token: plainUser.token,
    });
    assert.equal(plainAgg.status, 403);

    const plainGames = await h.json('GET', `/v1/moderation/anti-cheat/players/${targetPlayer.userId}/games`, {
      token: plainUser.token,
    });
    assert.equal(plainGames.status, 403);

    // 4. Unauthenticated gets 401 on both
    const unauthAgg = await h.json('GET', `/v1/moderation/anti-cheat/players/${targetPlayer.userId}`);
    assert.equal(unauthAgg.status, 401);

    const unauthGames = await h.json('GET', `/v1/moderation/anti-cheat/players/${targetPlayer.userId}/games`);
    assert.equal(unauthGames.status, 401);

    // 5. Aggregate for player with NO seeded reports
    const emptyPlayerId = uuidv7();
    const emptyAgg = await h.json('GET', `/v1/moderation/anti-cheat/players/${emptyPlayerId}`, {
      token: mod.token,
    });
    assert.equal(emptyAgg.status, 200);
    assert.equal(emptyAgg.body.gamesAnalyzed, 0);
    assert.equal(emptyAgg.body.suspicion, 'clean');
    assert.equal(emptyAgg.body.lowConfidence, true);

    // 6. Games list respects the `limit` query param
    const limitedGames = await h.json(
      'GET',
      `/v1/moderation/anti-cheat/players/${targetPlayer.userId}/games?limit=1`,
      { token: mod.token },
    );
    assert.equal(limitedGames.status, 200);
    assert.equal(limitedGames.body.length, 1);
    assert.equal(limitedGames.body[0].gameId, gameId1);

    // 7. Malformed playerId is rejected at the edge (422), before it can reach a
    //    UUID column, on both endpoints
    const badAgg = await h.json('GET', '/v1/moderation/anti-cheat/players/not-a-uuid', {
      token: mod.token,
    });
    assert.equal(badAgg.status, 422);
    const badGames = await h.json('GET', '/v1/moderation/anti-cheat/players/not-a-uuid/games', {
      token: mod.token,
    });
    assert.equal(badGames.status, 422);
  } finally {
    await h.close();
  }
});
