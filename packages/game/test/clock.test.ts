import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charge, classifySpeed, hasFlagged, initClock, type TimeControl } from '../src/clock';

const inc: TimeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' };
const delay: TimeControl = { initialMs: 60_000, incrementMs: 0, delayMs: 3_000, kind: 'delay' };
const sd: TimeControl = { initialMs: 30_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' };

test('increment: elapsed is deducted then increment added', () => {
  const c0 = initClock(inc, 1_000);
  const r = charge(c0, 'w', 6_000, inc); // spent 5s
  assert.equal(r.moveTimeMs, 5_000);
  assert.equal(r.chargedMs, 5_000);
  assert.equal(r.clock.remaining.w, 180_000 - 5_000 + 2_000);
  assert.equal(r.flagged, false);
});

test('delay: time within the delay window is not charged', () => {
  const c0 = initClock(delay, 0);
  const r = charge(c0, 'b', 2_500, delay); // spent 2.5s, under 3s delay
  assert.equal(r.chargedMs, 0);
  assert.equal(r.clock.remaining.b, 60_000);
});

test('delay: only time beyond the delay is charged', () => {
  const c0 = initClock(delay, 0);
  const r = charge(c0, 'w', 10_000, delay); // spent 10s, 3s free -> 7s charged
  assert.equal(r.chargedMs, 7_000);
  assert.equal(r.clock.remaining.w, 60_000 - 7_000);
});

test('flag: exhausting the clock sets flagged and clamps to zero, no increment', () => {
  const c0 = initClock(inc, 0);
  const r = charge(c0, 'w', 200_000, inc); // spent more than 180s
  assert.equal(r.flagged, true);
  assert.equal(r.clock.remaining.w, 0);
});

test('deterministic replay: explicit moveTimeMs reproduces remaining', () => {
  const c0 = initClock(inc, 1_000);
  const live = charge(c0, 'w', 4_000, inc);
  const replay = charge(c0, 'w', 999_999, inc, live.moveTimeMs);
  assert.deepEqual(replay.clock.remaining, live.clock.remaining);
});

test('hasFlagged detects an expired clock without a move', () => {
  const c0 = initClock(sd, 0);
  assert.equal(hasFlagged(c0, 'w', 29_000, sd), false);
  assert.equal(hasFlagged(c0, 'w', 31_000, sd), true);
});

test('classifySpeed buckets time controls', () => {
  assert.equal(classifySpeed({ initialMs: 15_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }), 'ultrabullet');
  assert.equal(classifySpeed({ initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }), 'bullet');
  assert.equal(classifySpeed({ initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }), 'blitz');
  assert.equal(classifySpeed({ initialMs: 600_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }), 'rapid');
  assert.equal(classifySpeed({ initialMs: 5_400_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' }), 'classical');
  assert.equal(classifySpeed({ initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' }), 'correspondence');
});
