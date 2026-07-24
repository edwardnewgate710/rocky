import test from 'node:test';
import * as assert from 'node:assert/strict';
import { tokenize } from '../src/tokenize';

test('tokenize: lowercasing text', () => {
  assert.deepEqual(tokenize('RUY LÓPEZ E4 E5'), ['ruy', 'lópez', 'e4', 'e5']);
});

test('tokenize: splitting on punctuation, whitespace, and mixed separators', () => {
  assert.deepEqual(tokenize('Ruy López: e4 e5!!'), ['ruy', 'lópez', 'e4', 'e5']);
  assert.deepEqual(tokenize('hello, world! foo...bar/baz'), ['hello', 'world', 'foo', 'bar', 'baz']);
});

test('tokenize: unicode letters kept intact', () => {
  assert.deepEqual(tokenize('López François Ångström Müller'), [
    'lópez',
    'françois',
    'ångström',
    'müller',
  ]);
});

test('tokenize: digits kept intact', () => {
  assert.deepEqual(tokenize('e4 1-0 2026 chess960'), ['e4', '1', '0', '2026', 'chess960']);
});

test('tokenize: empty string returns empty array', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize('!!!'), []);
});

test('tokenize: collapses multiple consecutive separators', () => {
  assert.deepEqual(tokenize('  ruy  \n\t  lópez---e4...e5   '), ['ruy', 'lópez', 'e4', 'e5']);
});
