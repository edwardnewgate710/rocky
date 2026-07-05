import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlacement, STARTING_FEN } from '../src/core/position.js';

test('parses the starting position into 32 pieces', () => {
  const board = parsePlacement(STARTING_FEN);
  assert.equal(board.size, 32);
  assert.deepEqual(board.get('e1'), { color: 'w', role: 'k' });
  assert.deepEqual(board.get('d8'), { color: 'b', role: 'q' });
  assert.deepEqual(board.get('a2'), { color: 'w', role: 'p' });
  assert.equal(board.get('e4'), undefined);
});

test('handles empty-square run digits', () => {
  const board = parsePlacement('8/8/8/4p3/8/8/8/8 b - - 0 1');
  assert.equal(board.size, 1);
  assert.deepEqual(board.get('e5'), { color: 'b', role: 'p' });
});

test('rejects malformed placements', () => {
  assert.throws(() => parsePlacement('8/8/8/8/8/8/8 w - - 0 1'), /8 ranks/);
  assert.throws(() => parsePlacement('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w - - 0 1'), /8 files|invalid/);
  assert.throws(() => parsePlacement('pppppppppp/8/8/8/8/8/8/8 w - - 0 1'), /overflow|fill 8 files/);
  assert.throws(() => parsePlacement('9/8/8/8/8/8/8/8 w - - 0 1'), /invalid FEN piece/);
});
