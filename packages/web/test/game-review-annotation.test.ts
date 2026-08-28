import test from 'node:test';
import assert from 'node:assert/strict';
import { gameReviewAnnotation } from '../src/app/game-review-annotation.js';

test('game review maps every server-owned post-game classification to a visible symbol', () => {
  assert.deepEqual(gameReviewAnnotation('brilliant'), {
    label: 'Brilliant', symbol: '!!', tone: 'brilliant',
  });
  assert.deepEqual(gameReviewAnnotation('great'), {
    label: 'Great', symbol: '!', tone: 'great',
  });
  assert.deepEqual(gameReviewAnnotation('best'), {
    label: 'Best move', symbol: '★', tone: 'best',
  });
  assert.deepEqual(gameReviewAnnotation('excellent'), {
    label: 'Excellent', symbol: '✓', tone: 'excellent',
  });
  assert.deepEqual(gameReviewAnnotation('good'), {
    label: 'Good move', symbol: '✓', tone: 'good',
  });
  assert.deepEqual(gameReviewAnnotation('book'), {
    label: 'Book', symbol: '📖', tone: 'book',
  });
  assert.deepEqual(gameReviewAnnotation('inaccuracy'), {
    label: 'Inaccuracy', symbol: '?!', tone: 'inaccuracy',
  });
  assert.deepEqual(gameReviewAnnotation('mistake'), {
    label: 'Mistake', symbol: '?', tone: 'mistake',
  });
  assert.deepEqual(gameReviewAnnotation('miss'), {
    label: 'Miss', symbol: '×', tone: 'miss',
  });
  assert.deepEqual(gameReviewAnnotation('blunder'), {
    label: 'Blunder', symbol: '??', tone: 'blunder',
  });
  assert.deepEqual(gameReviewAnnotation('missed_win'), {
    label: 'Missed win', symbol: '×', tone: 'missed_win',
  });
});

test('game review keeps rendering when a newer server classification is unknown', () => {
  assert.deepEqual(gameReviewAnnotation('future_classification'), {
    label: 'Unrated', symbol: '•', tone: 'neutral',
  });
});
