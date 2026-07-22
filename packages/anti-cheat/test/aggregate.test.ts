import test from 'node:test';
import * as assert from 'node:assert/strict';
import type { PlayerCorrelationReport } from '../src/analyzer';
import { aggregatePlayer, type PlayerAggregateInput } from '../src/aggregate';

function mockReport(overrides: Partial<PlayerCorrelationReport>): PlayerCorrelationReport {
  return {
    suspicion: 'clean',
    acpl: 0,
    acplCapped: 0,
    t1Rate: 0,
    t3Rate: 0,
    onlyMoveExcluded: 0,
    sampleSize: 0,
    unscored: 0,
    lowConfidence: false,
    t1Matches: 0,
    t3Matches: 0,
    tRateSampleCount: 0,
    rawCentipawnLossTotal: 0,
    cappedCentipawnLossTotal: 0,
    ...overrides,
  };
}

test('empty input yields a zeroed, low-confidence clean report', () => {
  const result = aggregatePlayer([]);

  assert.equal(result.suspicion, 'clean');
  assert.equal(result.lowConfidence, true);
  assert.equal(result.gamesAnalyzed, 0);
  assert.equal(result.pooledSampleSize, 0);
  assert.equal(result.pooledTRateSampleCount, 0);
  assert.equal(result.acpl, 0);
  assert.equal(result.acplCapped, 0);
  assert.equal(result.t1Rate, 0);
  assert.equal(result.t3Rate, 0);
  assert.deepEqual(result.flaggedGameIds, []);
});

test('pooling correctly differs from naive averaging', () => {
  // Game 1: 3 plies, 100% T1, ACPL 0 — a naive per-game average would treat this
  // as fully as the two 60-ply games below.
  const game1: PlayerAggregateInput = {
    gameId: 'g1',
    report: mockReport({ t1Matches: 3, tRateSampleCount: 3, sampleSize: 3 }),
  };
  // Games 2 & 3: 60 plies each, 0% T1, ACPL 100.
  const game2: PlayerAggregateInput = {
    gameId: 'g2',
    report: mockReport({
      t1Matches: 0,
      tRateSampleCount: 60,
      sampleSize: 60,
      rawCentipawnLossTotal: 6000,
      cappedCentipawnLossTotal: 6000,
    }),
  };
  const game3: PlayerAggregateInput = {
    gameId: 'g3',
    report: mockReport({
      t1Matches: 0,
      tRateSampleCount: 60,
      sampleSize: 60,
      rawCentipawnLossTotal: 6000,
      cappedCentipawnLossTotal: 6000,
    }),
  };

  const result = aggregatePlayer([game1, game2, game3]);

  // Naive average T1 would be (1.0 + 0 + 0) / 3 = 33%. Pooled is 3 / 123 ≈ 2.4%.
  assert.equal(result.t1Rate, 3 / 123);
  // Naive average ACPL would be (0 + 100 + 100) / 3 = 66.7. Pooled is 12000 / 123 ≈ 97.6.
  assert.equal(result.acplCapped, 12000 / 123);
  assert.equal(result.lowConfidence, false);
});

test('one anomalous perfect game is diluted among clean games', () => {
  const perfectGame: PlayerAggregateInput = {
    gameId: 'perfect',
    report: mockReport({
      suspicion: 'high',
      t1Matches: 30,
      tRateSampleCount: 30,
      sampleSize: 30,
    }),
  };
  const cleanGames: PlayerAggregateInput[] = [1, 2, 3].map((i) => ({
    gameId: `clean-${i}`,
    report: mockReport({
      suspicion: 'clean',
      t1Matches: 0,
      tRateSampleCount: 40,
      sampleSize: 40,
      rawCentipawnLossTotal: 4000,
      cappedCentipawnLossTotal: 4000,
    }),
  }));

  const result = aggregatePlayer([perfectGame, ...cleanGames]);

  // Pooled T1: 30 / 150 = 20%; pooled ACPL: 12000 / 150 = 80 → stays clean.
  assert.equal(result.lowConfidence, false);
  assert.equal(result.suspicion, 'clean');
  // ...but the anomalous game is surfaced for the reviewer.
  assert.deepEqual(result.flaggedGameIds, ['perfect']);
});

test('multiple strong games reach the high band', () => {
  const strongGames: PlayerAggregateInput[] = [1, 2, 3].map((i) => ({
    gameId: `strong-${i}`,
    report: mockReport({
      suspicion: 'high',
      t1Matches: 35,
      tRateSampleCount: 40, // 87.5% per game
      sampleSize: 40,
      rawCentipawnLossTotal: 400, // ACPL 10 per game
      cappedCentipawnLossTotal: 400,
    }),
  }));

  const result = aggregatePlayer(strongGames);

  assert.equal(result.lowConfidence, false);
  assert.equal(result.t1Rate, 105 / 120); // 87.5%
  assert.equal(result.acplCapped, 10);
  assert.equal(result.suspicion, 'high');
  assert.deepEqual(result.flaggedGameIds, ['strong-1', 'strong-2', 'strong-3']);
});

test('individually low-confidence games can form a confident aggregate', () => {
  // Each game is 15 plies (< LOW_CONFIDENCE_SAMPLE_MIN) so individually clean,
  // but together they clear the aggregate gate.
  const games: PlayerAggregateInput[] = [1, 2, 3].map((i) => ({
    gameId: `short-${i}`,
    report: mockReport({
      suspicion: 'clean',
      lowConfidence: true,
      t1Matches: 10,
      tRateSampleCount: 15,
      sampleSize: 15,
      rawCentipawnLossTotal: 150, // ACPL 10
      cappedCentipawnLossTotal: 150,
    }),
  }));

  const result = aggregatePlayer(games);

  assert.equal(result.lowConfidence, false); // 3 games, pooled T-rate 45 ≥ 40
  assert.equal(result.t1Rate, 30 / 45); // ≈ 66.7% → review band
  assert.equal(result.acplCapped, 10);
  assert.equal(result.suspicion, 'review');
  // Individually clean (low-confidence) games are not flagged for drill-down.
  assert.deepEqual(result.flaggedGameIds, []);
});

test('too few games cannot escalate even with a strong pooled signal', () => {
  // Two games, each strong and large — but gamesAnalyzed (2) < AGG_MIN_GAMES (3).
  const games: PlayerAggregateInput[] = [1, 2].map((i) => ({
    gameId: `g-${i}`,
    report: mockReport({
      suspicion: 'high',
      t1Matches: 45,
      tRateSampleCount: 50,
      sampleSize: 50,
    }),
  }));

  const result = aggregatePlayer(games);

  assert.equal(result.pooledTRateSampleCount, 100); // denominator is plenty
  assert.equal(result.lowConfidence, true); // ...but too few games
  assert.equal(result.suspicion, 'clean');
});

test('a thin pooled denominator cannot escalate even across enough games', () => {
  // Three games but each contributes only a few eligible plies → pooled < 40.
  const games: PlayerAggregateInput[] = [1, 2, 3].map((i) => ({
    gameId: `g-${i}`,
    report: mockReport({
      suspicion: 'clean',
      t1Matches: 5,
      tRateSampleCount: 5,
      sampleSize: 5,
    }),
  }));

  const result = aggregatePlayer(games);

  assert.equal(result.gamesAnalyzed, 3);
  assert.equal(result.pooledTRateSampleCount, 15); // < AGG_MIN_POOLED_TRATE
  assert.equal(result.lowConfidence, true);
  assert.equal(result.suspicion, 'clean');
});

test('a duplicate gameId is rejected so history cannot be double-counted', () => {
  const report = mockReport({ t1Matches: 20, tRateSampleCount: 20, sampleSize: 20 });
  assert.throws(
    () => aggregatePlayer([
      { gameId: 'g1', report },
      { gameId: 'g1', report },
    ]),
    /duplicate gameId "g1"/,
  );
});
