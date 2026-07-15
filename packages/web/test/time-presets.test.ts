import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_PRESETS,
  DEFAULT_PRESET_ID,
  presetToTimeControl,
  estimateSpeed,
} from '../src/app/time-presets.js';

test('every preset has a unique id and non-negative values', () => {
  const ids = new Set<string>();
  for (const p of TIME_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.minutes > 0, `${p.id} minutes must be positive`);
    assert.ok(p.increment >= 0, `${p.id} increment must be >= 0`);
  }
});

test('the default preset exists in the ladder', () => {
  assert.ok(TIME_PRESETS.some((p) => p.id === DEFAULT_PRESET_ID));
});

test('presetToTimeControl maps sudden-death vs increment', () => {
  const noInc = presetToTimeControl(5, 0);
  assert.deepEqual(noInc, { initialMs: 300_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' });

  const withInc = presetToTimeControl(3, 2);
  assert.deepEqual(withInc, { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' });
});

test('presetToTimeControl rounds a half-minute initial time', () => {
  const tc = presetToTimeControl(0.5, 0);
  assert.equal(tc.initialMs, 30_000);
});

test('estimateSpeed buckets the ladder the way players expect', () => {
  const speedOf = (m: number, i: number) => estimateSpeed(presetToTimeControl(m, i));
  assert.equal(speedOf(1, 0), 'Bullet');
  assert.equal(speedOf(2, 1), 'Bullet');
  assert.equal(speedOf(3, 0), 'Blitz');
  assert.equal(speedOf(5, 3), 'Blitz');
  assert.equal(speedOf(10, 0), 'Rapid');
  assert.equal(speedOf(15, 10), 'Rapid');
  assert.equal(speedOf(30, 20), 'Classical');
});
