import test from 'node:test';
import * as assert from 'node:assert/strict';
import { parseSearchQuery } from '../src/query';

test('parseSearchQuery: bare terms', () => {
  const result = parseSearchQuery('ruy e4');
  assert.deepEqual(result, {
    terms: ['ruy', 'e4'],
    phrases: [],
    filters: [],
  });
});

test('parseSearchQuery: a quoted phrase', () => {
  const result = parseSearchQuery('"kingside attack"');
  assert.deepEqual(result, {
    terms: [],
    phrases: ['kingside attack'],
    filters: [],
  });
});

test('parseSearchQuery: field:value filter (field lowercased, not negated)', () => {
  const result = parseSearchQuery('VARIANT:blitz');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [{ field: 'variant', value: 'blitz', negated: false }],
  });
});

test('parseSearchQuery: -field:value negated filter', () => {
  const result = parseSearchQuery('-result:1-0');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [{ field: 'result', value: '1-0', negated: true }],
  });
});

test('parseSearchQuery: quoted filter value field:"a b"', () => {
  const result = parseSearchQuery('field:"a b" -player:"grand master"');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'field', value: 'a b', negated: false },
      { field: 'player', value: 'grand master', negated: true },
    ],
  });
});

test('parseSearchQuery: field: with empty value treated as term, not filter', () => {
  const result = parseSearchQuery('field: -variant:');
  assert.deepEqual(result, {
    terms: ['field:', '-variant:'],
    phrases: [],
    filters: [],
  });
});

test('parseSearchQuery: quoted empty value (field:"" / -field:"") treated as term, not filter', () => {
  const result = parseSearchQuery('field:"" -variant:""');
  assert.deepEqual(result, {
    terms: ['field:""', '-variant:""'],
    phrases: [],
    filters: [],
  });
});

test('parseSearchQuery: mixed input (ruy "kingside attack" variant:blitz -result:1-0)', () => {
  const result = parseSearchQuery('ruy "kingside attack" variant:blitz -result:1-0');
  assert.deepEqual(result, {
    terms: ['ruy'],
    phrases: ['kingside attack'],
    filters: [
      { field: 'variant', value: 'blitz', negated: false },
      { field: 'result', value: '1-0', negated: true },
    ],
  });
});

test('parseSearchQuery: empty input returns empty structures', () => {
  assert.deepEqual(parseSearchQuery(''), { terms: [], phrases: [], filters: [] });
  assert.deepEqual(parseSearchQuery('   '), { terms: [], phrases: [], filters: [] });
});

test('parseSearchQuery: unterminated quote consumed to end of input', () => {
  const phraseResult = parseSearchQuery('"kingside attack');
  assert.deepEqual(phraseResult, {
    terms: [],
    phrases: ['kingside attack'],
    filters: [],
  });

  const filterResult = parseSearchQuery('field:"unterminated value');
  assert.deepEqual(filterResult, {
    terms: [],
    phrases: [],
    filters: [{ field: 'field', value: 'unterminated value', negated: false }],
  });
});
