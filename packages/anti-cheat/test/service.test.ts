import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { AntiCheatService } from '../src/service';
import { InMemoryAntiCheatReportRepository } from '../src/repository';
import { InMemoryEvaluator } from '../src/fakes';
import type { AnalyzedPly } from '../src/analyzer';

describe('AntiCheatReportRepository & AntiCheatService', () => {
  it('analyzes a game, stores both sides, and aggregates', async () => {
    const evaluator = new InMemoryEvaluator();
    // 20 clean plies to get above confidence threshold
    const plies: AnalyzedPly[] = [];
    for (let i = 0; i < 20; i++) {
      const fen = `fen-${i}`;
      plies.push({ fen, playedUci: 'e2e4', player: i % 2 === 0 ? 'white' : 'black' });
      evaluator.set(fen, {
        topMoves: [
          { uci: 'e2e4', cp: 50 },
          { uci: 'd2d4', cp: 0 },
        ],
      });
    }

    const repo = new InMemoryAntiCheatReportRepository();
    const service = new AntiCheatService(evaluator, repo);

    const report = await service.analyzeAndStore({
      gameId: 'game-1',
      players: { white: 'player-w', black: 'player-b' },
      plies,
      depth: 18,
    });

    // Verify returning the report directly works
    assert.equal(report.white.suspicion, 'clean');
    assert.equal(report.black.suspicion, 'clean');

    // Verify repository storage directly
    const storedW = await repo.listByPlayer('player-w');
    assert.equal(storedW.length, 1);
    assert.equal(storedW[0]!.color, 'white');
    assert.equal(storedW[0]!.report.sampleSize, 10);
    assert.equal(storedW[0]!.gameId, 'game-1');

    const storedB = await repo.listByPlayer('player-b');
    assert.equal(storedB.length, 1);
    assert.equal(storedB[0]!.color, 'black');
    assert.equal(storedB[0]!.report.sampleSize, 10);

    // Verify service aggregate
    const aggW = await service.aggregatePlayer('player-w');
    assert.equal(aggW.suspicion, 'clean');
    // Low confidence because AGG_MIN_GAMES is 3 (from aggregate.ts)
    assert.equal(aggW.lowConfidence, true);
    assert.equal(aggW.gamesAnalyzed, 1);
  });

  it('upserts idempotently: analyzing the same game leaves one record and stable aggregate', async () => {
    const evaluator = new InMemoryEvaluator();
    evaluator.set('fen-1', {
      topMoves: [
        { uci: 'a1a2', cp: 100 },
        { uci: 'b1b2', cp: 0 },
      ],
    });

    // We'll create enough plies/games to bypass lowConfidence for the aggregate later if we wanted to,
    // but here we just need to prove it doesn't duplicate.
    const repo = new InMemoryAntiCheatReportRepository();
    const service = new AntiCheatService(evaluator, repo);

    const input = {
      gameId: 'game-dup',
      players: { white: 'p1', black: 'p2' },
      plies: [{ fen: 'fen-1', playedUci: 'a1a2', player: 'white' as const }],
      depth: 15,
    };

    await service.analyzeAndStore(input);
    await service.analyzeAndStore(input); // Second time

    const stored = await repo.listByPlayer('p1');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.gameId, 'game-dup');

    // Due to idempotency, aggregatePlayer should not throw the duplicate gameId error
    const agg = await service.aggregatePlayer('p1');
    assert.equal(agg.gamesAnalyzed, 1);
  });

  it('aggregatePlayer on player with no games returns pure zeroed fallback', async () => {
    const repo = new InMemoryAntiCheatReportRepository();
    const service = new AntiCheatService(new InMemoryEvaluator(), repo);

    const agg = await service.aggregatePlayer('ghost');
    assert.equal(agg.gamesAnalyzed, 0);
    assert.equal(agg.pooledSampleSize, 0);
    assert.equal(agg.acpl, 0);
    assert.equal(agg.t1Rate, 0);
    assert.equal(agg.lowConfidence, true);
    assert.equal(agg.suspicion, 'clean');
  });

  it('repository saveBatch executes atomically and isolates keys properly', async () => {
    const repo = new InMemoryAntiCheatReportRepository();

    // Simulate a batch save of white and black reports for the same game
    await repo.saveBatch([
      { gameId: 'g1', playerId: 'p1', color: 'white', report: { sampleSize: 10, tRateSampleCount: 10, rawCentipawnLossTotal: 100, cappedCentipawnLossTotal: 100, t1Matches: 5, t3Matches: 8, suspicion: 'clean', lowConfidence: true, acpl: 10, acplCapped: 10, t1Rate: 0.5, t3Rate: 0.8, onlyMoveExcluded: 0, unscored: 0 } },
      { gameId: 'g1', playerId: 'p2', color: 'black', report: { sampleSize: 10, tRateSampleCount: 10, rawCentipawnLossTotal: 150, cappedCentipawnLossTotal: 150, t1Matches: 3, t3Matches: 6, suspicion: 'clean', lowConfidence: true, acpl: 15, acplCapped: 15, t1Rate: 0.3, t3Rate: 0.6, onlyMoveExcluded: 0, unscored: 0 } }
    ]);

    // Same players, new game
    await repo.saveBatch([
      { gameId: 'g2', playerId: 'p1', color: 'black', report: { sampleSize: 15, tRateSampleCount: 15, rawCentipawnLossTotal: 180, cappedCentipawnLossTotal: 180, t1Matches: 4, t3Matches: 7, suspicion: 'clean', lowConfidence: true, acpl: 12, acplCapped: 12, t1Rate: 0.26, t3Rate: 0.46, onlyMoveExcluded: 0, unscored: 0 } },
      { gameId: 'g2', playerId: 'p2', color: 'white', report: { sampleSize: 15, tRateSampleCount: 15, rawCentipawnLossTotal: 270, cappedCentipawnLossTotal: 270, t1Matches: 2, t3Matches: 5, suspicion: 'clean', lowConfidence: true, acpl: 18, acplCapped: 18, t1Rate: 0.13, t3Rate: 0.33, onlyMoveExcluded: 0, unscored: 0 } }
    ]);

    const p1Reports = await repo.listByPlayer('p1');
    const p2Reports = await repo.listByPlayer('p2');

    assert.equal(p1Reports.length, 2);
    assert.equal(p2Reports.length, 2);

    // Verify no collisions between p1 and p2 or g1 and g2
    assert.equal(p1Reports.find(r => r.gameId === 'g1')!.color, 'white');
    assert.equal(p1Reports.find(r => r.gameId === 'g2')!.color, 'black');
    assert.equal(p2Reports.find(r => r.gameId === 'g1')!.color, 'black');
    assert.equal(p2Reports.find(r => r.gameId === 'g2')!.color, 'white');
  });
});
