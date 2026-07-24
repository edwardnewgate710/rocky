import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemoryBotBehaviorReportRepository } from '../src/bot-repository';
import type { BotBehaviorReport } from '../src/bot-behavior';

function createDummyReport(sampleSize = 10): BotBehaviorReport {
  return {
    suspicion: 'clean',
    sampleSize,
    meanMs: 500,
    stdevMs: 100,
    coefficientOfVariation: 0.2,
    instantMoves: 0,
    instantFraction: 0,
    sumMs: 5000,
    sumSqMs: 2600000,
    lowConfidence: false,
  };
}

describe('InMemoryBotBehaviorReportRepository', () => {
  it('saves batch and lists reports by player', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const reportW = createDummyReport(12);
    const reportB = createDummyReport(15);

    await repo.saveBatch([
      { gameId: 'g1', playerId: 'p1', color: 'white', report: reportW },
      { gameId: 'g1', playerId: 'p2', color: 'black', report: reportB },
    ]);

    const p1Reports = await repo.listByPlayer('p1');
    assert.equal(p1Reports.length, 1);
    assert.equal(p1Reports[0]!.gameId, 'g1');
    assert.equal(p1Reports[0]!.playerId, 'p1');
    assert.equal(p1Reports[0]!.color, 'white');
    assert.equal(p1Reports[0]!.report.sampleSize, 12);

    const p2Reports = await repo.listByPlayer('p2');
    assert.equal(p2Reports.length, 1);
    assert.equal(p2Reports[0]!.gameId, 'g1');
    assert.equal(p2Reports[0]!.playerId, 'p2');
    assert.equal(p2Reports[0]!.color, 'black');
    assert.equal(p2Reports[0]!.report.sampleSize, 15);
  });

  it('upserts idempotently so saving the same (playerId, gameId) replaces prior record', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const firstReport = createDummyReport(10);
    const updatedReport = createDummyReport(20);

    await repo.saveBatch([
      { gameId: 'g1', playerId: 'p1', color: 'white', report: firstReport },
    ]);

    let reports = await repo.listByPlayer('p1');
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.report.sampleSize, 10);

    // Save again with same (playerId, gameId)
    await repo.saveBatch([
      { gameId: 'g1', playerId: 'p1', color: 'white', report: updatedReport },
    ]);

    reports = await repo.listByPlayer('p1');
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.report.sampleSize, 20);
  });

  it('returns empty array for an unknown player', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const reports = await repo.listByPlayer('unknown-player');
    assert.deepEqual(reports, []);
  });
});
