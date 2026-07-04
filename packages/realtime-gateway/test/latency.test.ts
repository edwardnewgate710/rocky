import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateRttMs, estimateSkewMs, interpolateRemaining } from '../src/latency';

test('RTT is the elapsed time between ping and pong, never negative', () => {
  assert.equal(estimateRttMs(1_000, 1_120), 120);
  assert.equal(estimateRttMs(1_000, 900), 0);
});

test('skew subtracts half the RTT from the server timestamp offset', () => {
  // Client pinged at 1000, server stamped 1080, RTT 40 -> one-way ~20.
  assert.equal(estimateSkewMs(1_000, 1_080, 40), 60);
});

test('interpolated remaining counts down and clamps at zero', () => {
  // Turn began (server) at 10_000 with 30s left; 5s later on a synced clock.
  assert.equal(interpolateRemaining(30_000, 10_000, 15_000, 0), 25_000);
  // With clock skew: client clock is 100ms behind the server.
  assert.equal(interpolateRemaining(30_000, 10_000, 15_000, 100), 24_900);
  // Never negative.
  assert.equal(interpolateRemaining(1_000, 10_000, 20_000, 0), 0);
});
