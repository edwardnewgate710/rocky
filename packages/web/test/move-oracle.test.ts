import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullMoveOracle, StaticMoveOracle } from '../src/ports/move-oracle.js';

test('NullMoveOracle offers no destinations', () => {
  const o = new NullMoveOracle();
  o.setPosition('startpos');
  assert.deepEqual(o.destinations('e2'), []);
});

test('StaticMoveOracle returns per-position destinations', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const o = new StaticMoveOracle({ [fen]: { e2: ['e3', 'e4'], g1: ['f3', 'h3'] } });
  o.setPosition(fen);
  assert.deepEqual([...o.destinations('e2')], ['e3', 'e4']);
  assert.deepEqual([...o.destinations('g1')], ['f3', 'h3']);
  assert.deepEqual(o.destinations('a2'), []);
});

test('StaticMoveOracle isolates positions', () => {
  const o = new StaticMoveOracle({ fenA: { e2: ['e4'] }, fenB: { d2: ['d4'] } });
  o.setPosition('fenA');
  assert.deepEqual([...o.destinations('e2')], ['e4']);
  assert.deepEqual(o.destinations('d2'), []);
  o.setPosition('fenB');
  assert.deepEqual([...o.destinations('d2')], ['d4']);
  assert.deepEqual(o.destinations('e2'), []);
});

test('StaticMoveOracle returns empty for unknown position', () => {
  const o = new StaticMoveOracle({});
  o.setPosition('whatever');
  assert.deepEqual(o.destinations('e2'), []);
});
