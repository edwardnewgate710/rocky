import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PremoveQueue } from '../src/core/premove.js';

test('single premove queue holds one move and dequeues it', () => {
  const q = new PremoveQueue();
  assert.equal(q.active, false);
  q.enqueue({ from: 'e2', to: 'e4' });
  assert.equal(q.active, true);
  assert.equal(q.size, 1);
  assert.deepEqual(q.peek(), { from: 'e2', to: 'e4' });
  assert.deepEqual(q.dequeue(), { from: 'e2', to: 'e4' });
  assert.equal(q.active, false);
  assert.equal(q.dequeue(), null);
});

test('default queue keeps only the most recent premove', () => {
  const q = new PremoveQueue();
  q.enqueue({ from: 'e2', to: 'e4' });
  q.enqueue({ from: 'd2', to: 'd4' });
  assert.equal(q.size, 1);
  assert.deepEqual(q.peek(), { from: 'd2', to: 'd4' });
});

test('chained premoves respect maxDepth and drop oldest at capacity', () => {
  const q = new PremoveQueue({ maxDepth: 2 });
  q.enqueue({ from: 'e2', to: 'e4' });
  q.enqueue({ from: 'g1', to: 'f3' });
  q.enqueue({ from: 'f1', to: 'c4' });
  assert.equal(q.size, 2);
  assert.deepEqual(q.list(), [
    { from: 'g1', to: 'f3' },
    { from: 'f1', to: 'c4' },
  ]);
});

test('promotion premove is preserved', () => {
  const q = new PremoveQueue();
  q.enqueue({ from: 'e7', to: 'e8', promotion: 'q' });
  assert.deepEqual(q.dequeue(), { from: 'e7', to: 'e8', promotion: 'q' });
});

test('clear cancels all premoves', () => {
  const q = new PremoveQueue({ maxDepth: 3 });
  q.enqueue({ from: 'e2', to: 'e4' });
  q.enqueue({ from: 'd2', to: 'd4' });
  q.clear();
  assert.equal(q.active, false);
  assert.deepEqual(q.list(), []);
});

test('invalid maxDepth throws', () => {
  assert.throws(() => new PremoveQueue({ maxDepth: 0 }), RangeError);
});
