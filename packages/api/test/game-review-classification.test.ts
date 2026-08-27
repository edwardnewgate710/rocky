import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGameReviewMove, emptyGameReviewSummary } from '../src/game-review/classification.js';
import type { MistakePredictionOutcome } from '../src/analysis/mistake-prediction-service.js';

function assessment(overrides: Partial<MistakePredictionOutcome> = {}): MistakePredictionOutcome {
  return {
    fen: 'fen', variant: 'standard', move: 'e2e4', classification: 'ok',
    before: { evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
    centipawnLoss: 0, bestMove: 'e2e4', bestLine: ['e2e4'], depth: 16,
    ...overrides,
  };
}

function classify(
  overrides: Parameters<typeof assessment>[0] = {},
  evidence: Partial<Parameters<typeof classifyGameReviewMove>[0]> = {},
) {
  return classifyGameReviewMove({ assessment: assessment(overrides), mover: 'w', isBook: false, offeredMaterial: false, alternative: null, ...evidence });
}

test('the review summary starts with every public classification at zero', () => {
  assert.deepEqual(emptyGameReviewSummary(), {
    brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0,
    inaccuracy: 0, mistake: 0, miss: 0, blunder: 0, missed_win: 0,
  });
});

test('book and missed-win teaching labels take precedence over generic engine loss', () => {
  assert.equal(classify({ classification: 'blunder' }, { isBook: true }), 'book');
  assert.equal(classify({
    classification: 'blunder',
    before: { evalKind: 'cp', evalValue: 450, evalLabel: '+4.50' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: 0, evalLabel: '0.00' },
  }), 'missed_win');
  assert.equal(classify({
    classification: 'mistake',
    before: { evalKind: 'cp', evalValue: 180, evalLabel: '+1.80' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: 0, evalLabel: '0.00' },
  }), 'miss');
});

test('positive move labels require explicit engine evidence', () => {
  assert.equal(classify({
    before: { evalKind: 'cp', evalValue: 200, evalLabel: '+2.00' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: 200, evalLabel: '+2.00' },
  }, { offeredMaterial: true }), 'brilliant');
  assert.equal(classify({}, {
    alternative: { move: 'd2d4', evaluation: { kind: 'cp', value: -120 } },
  }), 'great');
  assert.equal(classify(), 'best');
  assert.equal(classify({ bestMove: 'd2d4', centipawnLoss: 10 }), 'excellent');
  assert.equal(classify({ bestMove: 'd2d4', centipawnLoss: 30 }), 'good');
});

test('the measured error ladder remains legible when no special teaching event occurred', () => {
  assert.equal(classify({ classification: 'inaccuracy', centipawnLoss: 60 }), 'inaccuracy');
  assert.equal(classify({ classification: 'mistake', centipawnLoss: 150 }), 'mistake');
  assert.equal(classify({ classification: 'blunder', centipawnLoss: 300 }), 'blunder');
});
