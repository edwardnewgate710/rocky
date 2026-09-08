import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForHealth } from '../lib/wait-for-health.mjs';

test('waitForHealth caps its polling delay at the remaining deadline', async () => {
  let now = 0;
  const sleeps = [];

  await assert.rejects(
    () =>
      waitForHealth('http://health.invalid', 'test service', {
        timeoutMs: 25,
        pollInterval: 100,
        now: () => now,
        fetch: async () => ({ ok: false }),
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
      }),
    /did not become healthy within 0\.025s/,
  );

  assert.deepEqual(sleeps, [25]);
});
