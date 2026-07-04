import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityScheduler, JobPriority, QueueFullError } from '../src/index.js';
import { ManualClock } from './helpers.js';

function entry(value: string, priority: JobPriority, signal?: AbortSignal) {
  return { value, priority, ...(signal ? { signal } : {}), onCancel: () => undefined };
}

test('serves higher priority first, FIFO within a class', () => {
  const clock = new ManualClock();
  const q = new PriorityScheduler<string>({ clock });
  q.enqueue(entry('bg', JobPriority.Background));
  q.enqueue(entry('bot', JobPriority.BotMove));
  q.enqueue(entry('bot2', JobPriority.BotMove));
  assert.equal(q.dequeue(), 'bot');
  assert.equal(q.dequeue(), 'bot2');
  assert.equal(q.dequeue(), 'bg');
  assert.equal(q.dequeue(), undefined);
});

test('aging prevents starvation of a long-waiting low-priority job', () => {
  const clock = new ManualClock();
  const q = new PriorityScheduler<string>({ clock, agingMs: 100 });
  q.enqueue(entry('bg', JobPriority.Background)); // effective 3 at t=0
  clock.advance(400); // aged by 4 classes -> effective 0
  q.enqueue(entry('live', JobPriority.LiveAnalysis)); // fresh -> effective 1
  assert.equal(q.dequeue(), 'bg', 'the aged background job now outranks fresh live analysis');
});

test('enforces per-class backpressure', () => {
  const clock = new ManualClock();
  const q = new PriorityScheduler<string>({ clock, capacityPerClass: 1 });
  q.enqueue(entry('a', JobPriority.LiveAnalysis));
  assert.throws(() => q.enqueue(entry('b', JobPriority.LiveAnalysis)), QueueFullError);
});

test('removes and cancels an aborted queued entry', () => {
  const clock = new ManualClock();
  const q = new PriorityScheduler<string>({ clock });
  const controller = new AbortController();
  let cancelled = false;
  q.enqueue({ value: 'x', priority: JobPriority.LiveAnalysis, signal: controller.signal, onCancel: () => (cancelled = true) });
  assert.equal(q.size, 1);
  controller.abort();
  assert.equal(cancelled, true);
  assert.equal(q.size, 0);
  assert.equal(q.dequeue(), undefined);
});
