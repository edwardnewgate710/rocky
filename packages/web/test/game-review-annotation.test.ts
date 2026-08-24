import test from 'node:test';
import assert from 'node:assert/strict';
import { gameReviewAnnotation } from '../src/app/game-review-annotation.js';

test('game review labels only conclusions supported by the engine evidence', () => {
  assert.deepEqual(gameReviewAnnotation({ move: 'e2e4', bestMove: 'e2e4', classification: 'ok' }), {
    label: 'Best move', symbol: '★', tone: 'best',
  });
  assert.deepEqual(gameReviewAnnotation({ move: 'e2e4', bestMove: 'd2d4', classification: 'ok' }), {
    label: 'Good move', symbol: '✓', tone: 'good',
  });
  assert.deepEqual(gameReviewAnnotation({ move: 'e2e4', bestMove: 'd2d4', classification: 'inaccuracy' }), {
    label: 'Inaccuracy', symbol: '?!', tone: 'inaccuracy',
  });
  assert.deepEqual(gameReviewAnnotation({ move: 'e2e4', bestMove: 'd2d4', classification: 'mistake' }), {
    label: 'Mistake', symbol: '?', tone: 'mistake',
  });
  assert.deepEqual(gameReviewAnnotation({ move: 'e2e4', bestMove: 'd2d4', classification: 'blunder' }), {
    label: 'Blunder', symbol: '??', tone: 'blunder',
  });
});
