import test from 'node:test';
import * as assert from 'node:assert/strict';
import { parseNaturalQuery, NATURAL_VOCABULARY, NATURAL_STOP_WORDS } from '../src/natural';

test('parseNaturalQuery: full promotion of vocabulary words and dropping of stop words', () => {
  const result = parseNaturalQuery('blitz games won by white');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'variant', value: 'blitz', negated: false },
      { field: 'result', value: 'win', negated: false },
      { field: 'color', value: 'white', negated: false },
    ],
  });
});

test('parseNaturalQuery: explicit syntax preserved and mixed with natural vocabulary', () => {
  const result = parseNaturalQuery('player:magnus "kings gambit" rapid');
  assert.deepEqual(result, {
    terms: [],
    phrases: ['kings gambit'],
    filters: [
      { field: 'player', value: 'magnus', negated: false },
      { field: 'variant', value: 'rapid', negated: false },
    ],
  });
});

test('parseNaturalQuery: unrecognized terms kept', () => {
  const result = parseNaturalQuery('sicilian defense magnus');
  assert.deepEqual(result, {
    terms: ['sicilian', 'defense', 'magnus'],
    phrases: [],
    filters: [],
  });
});

test('parseNaturalQuery: case-insensitive promotion', () => {
  const result = parseNaturalQuery('BLITZ Won');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'variant', value: 'blitz', negated: false },
      { field: 'result', value: 'win', negated: false },
    ],
  });
});

test('parseNaturalQuery: result synonyms map to canonical values', () => {
  const lossResult = parseNaturalQuery('losses');
  assert.deepEqual(lossResult.filters, [{ field: 'result', value: 'loss', negated: false }]);

  const drawResult = parseNaturalQuery('drew');
  assert.deepEqual(drawResult.filters, [{ field: 'result', value: 'draw', negated: false }]);
});

test('parseNaturalQuery: filter deduplication preserving first occurrence', () => {
  const result = parseNaturalQuery('blitz blitz win won');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'variant', value: 'blitz', negated: false },
      { field: 'result', value: 'win', negated: false },
    ],
  });
});

test('parseNaturalQuery: negated explicit filter preserved alongside promoted filter', () => {
  const result = parseNaturalQuery('-variant:bullet blitz');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'variant', value: 'bullet', negated: true },
      { field: 'variant', value: 'blitz', negated: false },
    ],
  });
});

test('parseNaturalQuery: empty input and stop-words-only input return empty structures', () => {
  assert.deepEqual(parseNaturalQuery(''), { terms: [], phrases: [], filters: [] });
  assert.deepEqual(parseNaturalQuery('show me all games'), { terms: [], phrases: [], filters: [] });
});

test('Exported vocabulary sanity', () => {
  assert.deepEqual(NATURAL_VOCABULARY.get('960'), {
    field: 'variant',
    value: 'chess960',
  });
  assert.strictEqual(NATURAL_STOP_WORDS.has('the'), true);
});
