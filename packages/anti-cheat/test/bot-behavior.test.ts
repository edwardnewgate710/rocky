import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  analyzeBotBehavior,
  behaviorSuspicion,
  BOT_MIN_SAMPLE_SIZE,
  INSTANT_MOVE_MS,
  CV_HIGH,
  CV_REVIEW,
  INSTANT_FRACTION_HIGH,
  INSTANT_FRACTION_REVIEW,
  type TimedMove,
} from '../src/bot-behavior';

test('uniform and instant bot: high suspicion, low CV, high instantFraction', () => {
  const moves: TimedMove[] = Array.from({ length: 12 }, () => ({ ms: 50 }));
  const report = analyzeBotBehavior(moves);

  assert.equal(report.lowConfidence, false);
  assert.equal(report.sampleSize, 12);
  assert.equal(report.meanMs, 50);
  assert.equal(report.stdevMs, 0);
  assert.equal(report.coefficientOfVariation, 0);
  assert.equal(report.instantMoves, 12);
  assert.equal(report.instantFraction, 1.0);
  assert.equal(report.sumMs, 600);
  assert.equal(report.sumSqMs, 30000);
  assert.equal(report.suspicion, 'high');
});

test('human varied pacing: clean suspicion with high CV and low instantFraction', () => {
  const timings = [3000, 800, 12000, 1500, 400, 6000, 900, 2200, 500, 4000];
  const moves: TimedMove[] = timings.map((ms) => ({ ms }));
  const report = analyzeBotBehavior(moves);

  assert.equal(report.lowConfidence, false);
  assert.equal(report.sampleSize, 10);
  assert.ok(report.coefficientOfVariation > CV_REVIEW, `CV ${report.coefficientOfVariation} should be > ${CV_REVIEW}`);
  assert.equal(report.instantMoves, 0);
  assert.equal(report.instantFraction, 0);
  assert.equal(report.suspicion, 'clean');
});

test('lowConfidence gate: small sample size prevents escalation', () => {
  const moves: TimedMove[] = Array.from({ length: BOT_MIN_SAMPLE_SIZE - 1 }, () => ({ ms: 50 }));
  const report = analyzeBotBehavior(moves);

  assert.equal(report.lowConfidence, true);
  assert.equal(report.sampleSize, 9);
  assert.equal(report.coefficientOfVariation, 0);
  assert.equal(report.instantFraction, 1.0);
  assert.equal(report.suspicion, 'clean');
});

test('book exclusion: book moves are excluded from statistics and sampleSize', () => {
  // 10 book moves with instant 50ms timing (would be bot-like if included)
  const bookMoves: TimedMove[] = Array.from({ length: 10 }, () => ({ ms: 50, isBook: true }));
  // 10 non-book moves with human varied timing (> 150ms)
  const nonBookTimings = [2000, 800, 5000, 1200, 400, 6000, 900, 3000, 1000, 4500];
  const nonBookMoves: TimedMove[] = nonBookTimings.map((ms) => ({ ms, isBook: false }));

  const report = analyzeBotBehavior([...bookMoves, ...nonBookMoves]);

  assert.equal(report.sampleSize, 10);
  assert.equal(report.instantMoves, 0);
  assert.equal(report.instantFraction, 0);
  assert.equal(report.lowConfidence, false);
  assert.equal(report.suspicion, 'clean');
});

test('empty input: returns documented all-zero clean lowConfidence report', () => {
  const report = analyzeBotBehavior([]);

  assert.equal(report.suspicion, 'clean');
  assert.equal(report.sampleSize, 0);
  assert.equal(report.meanMs, 0);
  assert.equal(report.stdevMs, 0);
  assert.equal(report.coefficientOfVariation, 0);
  assert.equal(report.instantMoves, 0);
  assert.equal(report.instantFraction, 0);
  assert.equal(report.sumMs, 0);
  assert.equal(report.sumSqMs, 0);
  assert.equal(report.lowConfidence, true);
});

test('statistic correctness: exact math for small hand-computable set', () => {
  const moves: TimedMove[] = [
    { ms: 100 },
    { ms: 300 },
    { ms: 50, isBook: true }, // ignored
  ];

  const report = analyzeBotBehavior(moves);

  assert.equal(report.sampleSize, 2);
  assert.ok(Math.abs(report.meanMs - 200) < 1e-9, `meanMs expected 200, got ${report.meanMs}`);
  assert.ok(Math.abs(report.stdevMs - 100) < 1e-9, `stdevMs expected 100, got ${report.stdevMs}`);
  assert.ok(
    Math.abs(report.coefficientOfVariation - 0.5) < 1e-9,
    `CV expected 0.5, got ${report.coefficientOfVariation}`,
  );
  assert.equal(report.instantMoves, 1);
  assert.equal(report.instantFraction, 0.5);
  assert.equal(report.sumMs, 400);
  assert.equal(report.sumSqMs, 100000);
  assert.equal(report.lowConfidence, true);
  assert.equal(report.suspicion, 'clean'); // lowConfidence forces clean
});

test('review band: CV in review range with low instantFraction produces review suspicion', () => {
  // 10 non-instant moves (all >= 1000ms, so instantFraction = 0)
  // 8 moves of 1000ms, 2 moves of 2000ms
  // Mean = 1200ms, Population Stdev = 400ms, CV = 400 / 1200 = 0.3333333333333333
  // CV is > CV_HIGH (0.25) and <= CV_REVIEW (0.5) → CV band is 'review'
  const timings = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000, 2000];
  const moves: TimedMove[] = timings.map((ms) => ({ ms }));

  const report = analyzeBotBehavior(moves);

  assert.equal(report.lowConfidence, false);
  assert.equal(report.sampleSize, 10);
  assert.ok(report.coefficientOfVariation > CV_HIGH && report.coefficientOfVariation <= CV_REVIEW);
  assert.equal(report.instantFraction, 0);
  assert.equal(report.suspicion, 'review');
});

test('review band: instantFraction in review range with high CV produces review suspicion', () => {
  // 10 moves: 7 instant moves (50ms) and 3 long moves (10000ms)
  // instantMoves = 7, instantFraction = 0.7 (>= INSTANT_FRACTION_REVIEW 0.7, < INSTANT_FRACTION_HIGH 0.9)
  // Mean = (7*50 + 3*10000) / 10 = 30350 / 10 = 3035ms
  // Variance = (7*(50-3035)^2 + 3*(10000-3035)^2) / 10 = (7*8910225 + 3*48510225) / 10 = (62371575 + 145530675) / 10 = 20790225
  // Stdev = sqrt(20790225) = 4559.63ms
  // CV = 4559.63 / 3035 = 1.502 > 0.5 (CV band: clean)
  // Instant band: instantFraction 0.7 >= 0.7 -> review
  const timings = [50, 50, 50, 50, 50, 50, 50, 10000, 10000, 10000];
  const moves: TimedMove[] = timings.map((ms) => ({ ms }));

  const report = analyzeBotBehavior(moves);

  assert.equal(report.lowConfidence, false);
  assert.equal(report.sampleSize, 10);
  assert.equal(report.instantMoves, 7);
  assert.equal(report.instantFraction, 0.7);
  assert.ok(report.coefficientOfVariation > CV_REVIEW);
  assert.equal(report.suspicion, 'review');
});

test('behaviorSuspicion helper direct assertions', () => {
  assert.equal(behaviorSuspicion(0.2, 0.0), 'high');
  assert.equal(behaviorSuspicion(0.4, 0.0), 'review');
  assert.equal(behaviorSuspicion(0.6, 0.0), 'clean');

  assert.equal(behaviorSuspicion(0.6, 0.95), 'high');
  assert.equal(behaviorSuspicion(0.6, 0.75), 'review');
  assert.equal(behaviorSuspicion(0.6, 0.5), 'clean');

  // Max severity takes precedent
  assert.equal(behaviorSuspicion(0.4, 0.95), 'high');
  assert.equal(behaviorSuspicion(0.2, 0.75), 'high');
});
