import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRIABLE_METHODS,
  computeBackoff,
  withRetry,
} from '../src/net/retry.js';
import type { RetryPolicy } from '../src/net/retry.js';

const NO_JITTER: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' };

test('computeBackoff is exponential and capped (no jitter)', () => {
  assert.equal(computeBackoff(0, NO_JITTER), 100);
  assert.equal(computeBackoff(1, NO_JITTER), 200);
  assert.equal(computeBackoff(2, NO_JITTER), 400);
  assert.equal(computeBackoff(3, NO_JITTER), 800);
  assert.equal(computeBackoff(4, NO_JITTER), 1000);
});

test('full jitter spreads within [0, capped] using injected rng', () => {
  const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: 'full' };
  assert.equal(computeBackoff(1, policy, () => 0), 0);
  assert.equal(computeBackoff(1, policy, () => 0.5), 100);
  assert.equal(computeBackoff(4, policy, () => 0.999), 999);
});

test('RETRIABLE_METHODS are exactly the idempotent verbs', () => {
  assert.equal(RETRIABLE_METHODS.has('GET'), true);
  assert.equal(RETRIABLE_METHODS.has('PUT'), true);
  assert.equal(RETRIABLE_METHODS.has('DELETE'), true);
  assert.equal(RETRIABLE_METHODS.has('POST'), false);
  assert.equal(RETRIABLE_METHODS.has('PATCH'), false);
});

test('withRetry retries transient failures then succeeds', async () => {
  const delays: number[] = [];
  let lastAttempt = 0;
  const result = await withRetry(
    async (attempt) => {
      lastAttempt = attempt;
      if (attempt < 3) throw new Error('boom');
      return 'ok';
    },
    { policy: NO_JITTER, sleep: async (ms) => void delays.push(ms), isRetriable: () => true },
  );
  assert.equal(result, 'ok');
  assert.equal(lastAttempt, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('withRetry gives up after maxAttempts and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error(`fail-${calls}`);
      },
      { policy: NO_JITTER, sleep: async () => {}, isRetriable: () => true },
    ),
    /fail-4/,
  );
  assert.equal(calls, 4);
});

test('withRetry does not retry non-retriable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('nope');
      },
      { policy: NO_JITTER, sleep: async () => {}, isRetriable: () => false },
    ),
    /nope/,
  );
  assert.equal(calls, 1);
});

test('withRetry applies a delay-hint floor', async () => {
  const delays: number[] = [];
  await withRetry(
    async (attempt) => {
      if (attempt < 2) throw new Error('retry');
      return 1;
    },
    {
      policy: NO_JITTER,
      sleep: async (ms) => void delays.push(ms),
      isRetriable: () => true,
      delayHintMs: () => 5000,
    },
  );
  assert.deepEqual(delays, [5000]);
});
