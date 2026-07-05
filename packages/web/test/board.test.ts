import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSquare,
  toSquare,
  fileIndex,
  rankIndex,
  squareShade,
  squareToPixel,
  pixelToSquare,
} from '../src/core/board.js';

test('isSquare accepts valid and rejects invalid squares', () => {
  assert.ok(isSquare('a1'));
  assert.ok(isSquare('h8'));
  assert.ok(!isSquare('i1'));
  assert.ok(!isSquare('a9'));
  assert.ok(!isSquare('e'));
  assert.ok(!isSquare('e44'));
});

test('file/rank indices and toSquare round-trip', () => {
  assert.equal(fileIndex('e4'), 4);
  assert.equal(rankIndex('e4'), 3);
  assert.equal(toSquare(4, 3), 'e4');
  assert.equal(toSquare(0, 0), 'a1');
  assert.equal(toSquare(7, 7), 'h8');
  assert.throws(() => toSquare(8, 0), RangeError);
});

test('squareShade matches board colouring (a1 dark, h1 light)', () => {
  assert.equal(squareShade('a1'), 'dark');
  assert.equal(squareShade('h1'), 'light');
  assert.equal(squareShade('a8'), 'light');
});

test('squareToPixel places a1 correctly for both orientations', () => {
  // White orientation: a1 is bottom-left -> col 0, bottom row (row 7).
  assert.deepEqual(squareToPixel('a1', 800, 'white'), { x: 0, y: 700 });
  // Black orientation: a1 is top-right -> col 7, top row (row 0).
  assert.deepEqual(squareToPixel('a1', 800, 'black'), { x: 700, y: 0 });
});

test('pixelToSquare is the inverse of squareToPixel', () => {
  for (const orientation of ['white', 'black'] as const) {
    for (const sq of ['a1', 'e4', 'h8', 'd5', 'b7']) {
      const px = squareToPixel(sq, 800, orientation);
      // Sample the centre of the cell.
      const centre = { x: px.x + 50, y: px.y + 50 };
      assert.equal(pixelToSquare(centre, 800, orientation), sq);
    }
  }
});

test('pixelToSquare returns null outside the board', () => {
  assert.equal(pixelToSquare({ x: -1, y: 10 }, 800, 'white'), null);
  assert.equal(pixelToSquare({ x: 800, y: 10 }, 800, 'white'), null);
});
