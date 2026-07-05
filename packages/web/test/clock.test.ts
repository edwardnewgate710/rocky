import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChessClock } from '../src/core/clock.js';

test('clock counts down the active side only', () => {
  const c = new ChessClock({ initialMs: 60_000 });
  c.start(0);
  const s = c.snapshot(5_000);
  assert.equal(s.white, 55_000);
  assert.equal(s.black, 60_000);
  assert.equal(s.turn, 'white');
});

test('move switches turn and applies increment', () => {
  const c = new ChessClock({ initialMs: 60_000, incrementMs: 2_000 });
  c.start(0);
  c.move(5_000); // white used 5s, +2s increment -> 57s, now black to move
  const s = c.snapshot(5_000);
  assert.equal(s.white, 57_000);
  assert.equal(s.turn, 'black');
});

test('time clamps at zero and flags', () => {
  const c = new ChessClock({ initialMs: 3_000 });
  c.start(0);
  assert.equal(c.hasFlagged(3_000), true);
  assert.equal(c.snapshot(10_000).white, 0);
});

test('no increment is granted after flagging', () => {
  const c = new ChessClock({ initialMs: 3_000, incrementMs: 2_000 });
  c.start(0);
  c.move(5_000); // white already at 0 when moving -> no increment
  assert.equal(c.snapshot(5_000).white, 0);
});

test('sync overwrites from authoritative server state', () => {
  const c = new ChessClock({ initialMs: 60_000 });
  c.start(0);
  c.sync({ white: 42_000, black: 30_000, turn: 'black', nowMs: 1_000 });
  const s = c.snapshot(2_000);
  assert.equal(s.white, 42_000); // white idle
  assert.equal(s.black, 29_000); // black ticked 1s
  assert.equal(s.turn, 'black');
});

test('stop pauses without switching sides', () => {
  const c = new ChessClock({ initialMs: 60_000 });
  c.start(0);
  c.stop(4_000);
  const s = c.snapshot(10_000);
  assert.equal(s.white, 56_000);
  assert.equal(s.running, false);
});
