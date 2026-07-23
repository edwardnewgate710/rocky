import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  aggregateBotBehavior,
  BOT_AGG_MIN_GAMES,
  BOT_AGG_MIN_POOLED_SAMPLE,
  type BotAggregateInput,
} from '../src/bot-aggregate';
import { analyzeBotBehavior, type BotBehaviorReport, type TimedMove } from '../src/bot-behavior';

function mockBotReport(overrides: Partial<BotBehaviorReport> = {}): BotBehaviorReport {
  return {
    suspicion: 'clean',
    sampleSize: 0,
    meanMs: 0,
    stdevMs: 0,
    coefficientOfVariation: 0,
    instantMoves: 0,
    instantFraction: 0,
    sumMs: 0,
    sumSqMs: 0,
    lowConfidence: false,
    ...overrides,
  };
}

test('empty input yields a zeroed, low-confidence clean report', () => {
  const result = aggregateBotBehavior([]);

  assert.equal(result.suspicion, 'clean');
  assert.equal(result.lowConfidence, true);
  assert.equal(result.gamesAnalyzed, 0);
  assert.equal(result.pooledSampleSize, 0);
  assert.equal(result.pooledMeanMs, 0);
  assert.equal(result.pooledStdevMs, 0);
  assert.equal(result.pooledCoefficientOfVariation, 0);
  assert.equal(result.pooledInstantMoves, 0);
  assert.equal(result.pooledInstantFraction, 0);
  assert.deepEqual(result.flaggedGameIds, []);
});

test('pooling correctly differs from naive averaging of per-game means', () => {
  // Game 1: 10 moves of 100ms (sumMs = 1000, meanMs = 100)
  const g1: BotAggregateInput = {
    gameId: 'g1',
    report: mockBotReport({
      sampleSize: 10,
      meanMs: 100,
      sumMs: 1000,
      sumSqMs: 100000,
    }),
  };
  // Game 2: 90 moves of 500ms (sumMs = 45000, meanMs = 500)
  const g2: BotAggregateInput = {
    gameId: 'g2',
    report: mockBotReport({
      sampleSize: 90,
      meanMs: 500,
      sumMs: 45000,
      sumSqMs: 22500000,
    }),
  };
  // Game 3: 10 moves of 500ms (sumMs = 5000, meanMs = 500)
  const g3: BotAggregateInput = {
    gameId: 'g3',
    report: mockBotReport({
      sampleSize: 10,
      meanMs: 500,
      sumMs: 5000,
      sumSqMs: 2500000,
    }),
  };

  const result = aggregateBotBehavior([g1, g2, g3]);

  // Naive average of per-game meanMs = (100 + 500 + 500) / 3 = 366.666...
  // Pooled meanMs = (1000 + 45000 + 5000) / 110 = 51000 / 110 = 463.6363636363636
  const naiveAverageMean = (g1.report.meanMs + g2.report.meanMs + g3.report.meanMs) / 3;
  assert.notEqual(result.pooledMeanMs, naiveAverageMean);
  assert.ok(Math.abs(result.pooledMeanMs - 51000 / 110) < 1e-9);
  assert.equal(result.pooledSampleSize, 110);
});

test('confidence gate: fewer than BOT_AGG_MIN_GAMES forces clean and lowConfidence', () => {
  // 2 games, each with sample size 30 (pooled sample 60 >= 40), both high suspicion
  const g1: BotAggregateInput = {
    gameId: 'g1',
    report: mockBotReport({
      suspicion: 'high',
      sampleSize: 30,
      meanMs: 50,
      sumMs: 1500,
      sumSqMs: 75000,
      instantMoves: 30,
      instantFraction: 1.0,
    }),
  };
  const g2: BotAggregateInput = {
    gameId: 'g2',
    report: mockBotReport({
      suspicion: 'high',
      sampleSize: 30,
      meanMs: 50,
      sumMs: 1500,
      sumSqMs: 75000,
      instantMoves: 30,
      instantFraction: 1.0,
    }),
  };

  const result = aggregateBotBehavior([g1, g2]);

  assert.equal(result.gamesAnalyzed, 2);
  assert.equal(result.pooledSampleSize, 60);
  assert.equal(result.lowConfidence, true);
  assert.equal(result.suspicion, 'clean');
  assert.deepEqual(result.flaggedGameIds, ['g1', 'g2']);
});

test('confidence gate: pooled sample below BOT_AGG_MIN_POOLED_SAMPLE forces clean and lowConfidence', () => {
  // 3 games, each with sample size 10 (pooled sample 30 < 40), all high suspicion
  const games: BotAggregateInput[] = [1, 2, 3].map((i) => ({
    gameId: `g${i}`,
    report: mockBotReport({
      suspicion: 'high',
      sampleSize: 10,
      meanMs: 50,
      sumMs: 500,
      sumSqMs: 25000,
      instantMoves: 10,
      instantFraction: 1.0,
    }),
  }));

  const result = aggregateBotBehavior(games);

  assert.equal(result.gamesAnalyzed, 3);
  assert.equal(result.pooledSampleSize, 30);
  assert.equal(result.lowConfidence, true);
  assert.equal(result.suspicion, 'clean');
  assert.deepEqual(result.flaggedGameIds, ['g1', 'g2', 'g3']);
});

test('confident escalation: >= 3 games and pooled sample >= 40 clear the gate', () => {
  // 3 games with 15 moves each (pooled sample = 45 >= 40), instant replies
  const moves: TimedMove[] = Array.from({ length: 15 }, () => ({ ms: 50 }));
  const report = analyzeBotBehavior(moves);

  const games: BotAggregateInput[] = [1, 2, 3].map((i) => ({
    gameId: `g${i}`,
    report,
  }));

  const result = aggregateBotBehavior(games);

  assert.equal(result.gamesAnalyzed, 3);
  assert.equal(result.pooledSampleSize, 45);
  assert.equal(result.lowConfidence, false);
  assert.equal(result.pooledMeanMs, 50);
  assert.equal(result.pooledStdevMs, 0);
  assert.equal(result.pooledCoefficientOfVariation, 0);
  assert.equal(result.pooledInstantFraction, 1.0);
  assert.equal(result.suspicion, 'high');
  assert.deepEqual(result.flaggedGameIds, ['g1', 'g2', 'g3']);
});

test('duplicate gameId throws an error', () => {
  const g1: BotAggregateInput = {
    gameId: 'g1',
    report: mockBotReport({ sampleSize: 20 }),
  };

  assert.throws(
    () => aggregateBotBehavior([g1, g1]),
    /aggregateBotBehavior: duplicate gameId "g1"/,
  );
});

test('flaggedGameIds lists exactly review and high games', () => {
  const games: BotAggregateInput[] = [
    { gameId: 'g-clean', report: mockBotReport({ suspicion: 'clean', sampleSize: 15 }) },
    { gameId: 'g-review', report: mockBotReport({ suspicion: 'review', sampleSize: 15 }) },
    { gameId: 'g-high', report: mockBotReport({ suspicion: 'high', sampleSize: 15 }) },
  ];

  const result = aggregateBotBehavior(games);
  assert.deepEqual(result.flaggedGameIds, ['g-review', 'g-high']);
});

test('pooled-stat correctness: exact math for hand-computable set', () => {
  // Game 1: 10 moves of 100ms (sumMs = 1000, sumSqMs = 100000, instantMoves = 10)
  // Game 2: 30 moves of 300ms (sumMs = 9000, sumSqMs = 2700000, instantMoves = 0)
  // Game 3: 10 moves of 300ms (sumMs = 3000, sumSqMs = 900000, instantMoves = 0)
  // Pooled sampleSize = 50
  // Pooled sumMs = 13000 -> mean = 260
  // Pooled sumSqMs = 3700000
  // Variance = 3700000 / 50 - 260^2 = 74000 - 67600 = 6400
  // Stdev = sqrt(6400) = 80
  // CV = 80 / 260 = 4 / 13 ≈ 0.30769230769
  // InstantMoves = 10 -> instantFraction = 10 / 50 = 0.2
  const g1: BotAggregateInput = {
    gameId: 'g1',
    report: mockBotReport({
      suspicion: 'review',
      sampleSize: 10,
      meanMs: 100,
      stdevMs: 0,
      sumMs: 1000,
      sumSqMs: 100000,
      instantMoves: 10,
      instantFraction: 1.0,
    }),
  };
  const g2: BotAggregateInput = {
    gameId: 'g2',
    report: mockBotReport({
      suspicion: 'clean',
      sampleSize: 30,
      meanMs: 300,
      stdevMs: 0,
      sumMs: 9000,
      sumSqMs: 2700000,
      instantMoves: 0,
      instantFraction: 0,
    }),
  };
  const g3: BotAggregateInput = {
    gameId: 'g3',
    report: mockBotReport({
      suspicion: 'clean',
      sampleSize: 10,
      meanMs: 300,
      stdevMs: 0,
      sumMs: 3000,
      sumSqMs: 900000,
      instantMoves: 0,
      instantFraction: 0,
    }),
  };

  const result = aggregateBotBehavior([g1, g2, g3]);

  assert.equal(result.gamesAnalyzed, 3);
  assert.equal(result.pooledSampleSize, 50);
  assert.ok(Math.abs(result.pooledMeanMs - 260) < 1e-6);
  assert.ok(Math.abs(result.pooledStdevMs - 80) < 1e-6);
  assert.ok(Math.abs(result.pooledCoefficientOfVariation - (4 / 13)) < 1e-6);
  assert.equal(result.pooledInstantMoves, 10);
  assert.ok(Math.abs(result.pooledInstantFraction - 0.2) < 1e-6);
  assert.equal(result.lowConfidence, false);
  // CV = 4/13 ≈ 0.30769 (<= 0.5 CV_REVIEW) -> suspicion 'review'
  assert.equal(result.suspicion, 'review');
});
