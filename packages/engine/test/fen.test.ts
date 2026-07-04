import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuralFenValidator, InvalidFenError } from '../src/index.js';
import { START_FEN } from './helpers.js';

const v = new StructuralFenValidator();

test('accepts the standard starting position', () => {
  assert.doesNotThrow(() => v.validate(START_FEN, 'chess'));
});

test('accepts a Crazyhouse FEN with a pocket', () => {
  assert.doesNotThrow(() => v.validate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1', 'crazyhouse'));
});

test('accepts a board-and-side-only FEN', () => {
  assert.doesNotThrow(() => v.validate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w', 'chess'));
});

test('rejects an empty FEN', () => {
  assert.throws(() => v.validate('', 'chess'), InvalidFenError);
});

test('rejects a FEN with no side-to-move field', () => {
  assert.throws(() => v.validate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 'chess'), InvalidFenError);
});

test('rejects an illegal side-to-move token', () => {
  assert.throws(() => v.validate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', 'chess'), InvalidFenError);
});

test('rejects hostile characters', () => {
  assert.throws(() => v.validate('rnbq; rm -rf / w', 'chess'), InvalidFenError);
});

test('rejects an over-long string', () => {
  assert.throws(() => v.validate(`${'8/'.repeat(120)}8 w`, 'chess'), InvalidFenError);
});
