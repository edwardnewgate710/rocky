import test from 'node:test';
import * as assert from 'node:assert/strict';
import { search, type SearchableDocument } from '../src/search';
import { parseSearchQuery } from '../src/query';

test('search: term AND semantics (all term-tokens required)', () => {
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Ruy López e4 e5' },
    { id: '2', text: 'Ruy López d4 d5' },
    { id: '3', text: 'Sicilian Defense e4 c5' },
  ];

  const query = parseSearchQuery('ruy e4');
  const results = search(query, docs);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '1');
});

test('search: phrase contiguity (scattered phrase is NOT a hit)', () => {
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Strong attack on the kingside structure' }, // scattered
    { id: '2', text: 'A classic kingside attack on white king' }, // contiguous
  ];

  const query = parseSearchQuery('"kingside attack"');
  const results = search(query, docs);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '2');
  assert.equal(results[0].score, 2); // 2 * 1 phrase match
});

test('search: filter exact match (case-insensitive) incl. negated filter and absent field', () => {
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Game 1', fields: { variant: 'Blitz', result: '1-0' } },
    { id: '2', text: 'Game 2', fields: { variant: 'blitz', result: '0-1' } },
    { id: '3', text: 'Game 3', fields: { variant: 'bullet', result: '1-0' } },
    { id: '4', text: 'Game 4', fields: { variant: 'blitz' } }, // result field absent
  ];

  // query: variant:blitz -result:1-0
  const query = parseSearchQuery('variant:blitz -result:1-0');
  const results = search(query, docs);

  // Should match doc 2 (variant blitz, result 0-1 != 1-0) and doc 4 (variant blitz, result absent != 1-0)
  assert.equal(results.length, 2);
  const matchedIds = results.map((r) => r.id);
  assert.deepEqual(matchedIds, ['2', '4']);
});

test('search: score ordering (more term occurrences ranks higher)', () => {
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Ruy opening' }, // 1 occurrence
    { id: '2', text: 'Ruy Ruy Ruy opening' }, // 3 occurrences
    { id: '3', text: 'Ruy Ruy opening' }, // 2 occurrences
  ];

  const query = parseSearchQuery('ruy');
  const results = search(query, docs);

  assert.deepEqual(results, [
    { id: '2', score: 3 },
    { id: '3', score: 2 },
    { id: '1', score: 1 },
  ]);
});

test('search: deterministic id tie-break for equal scores', () => {
  const docs: SearchableDocument[] = [
    { id: 'charlie', text: 'chess study' },
    { id: 'alpha', text: 'chess study' },
    { id: 'bravo', text: 'chess study' },
  ];

  const query = parseSearchQuery('chess');
  const results = search(query, docs);

  assert.deepEqual(
    results.map((r) => r.id),
    ['alpha', 'bravo', 'charlie']
  );
  assert.equal(results[0].score, 1);
  assert.equal(results[1].score, 1);
  assert.equal(results[2].score, 1);
});

test('search: filters-only query returns all filter-passing docs at score 0', () => {
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Anything here', fields: { variant: 'blitz' } },
    { id: '2', text: 'Other text', fields: { variant: 'bullet' } },
    { id: '3', text: 'More text', fields: { variant: 'blitz' } },
  ];

  const query = parseSearchQuery('variant:blitz');
  const results = search(query, docs);

  assert.deepEqual(results, [
    { id: '1', score: 0 },
    { id: '3', score: 0 },
  ]);
});

test('search: query matching nothing returns empty array', () => {
  const docs: SearchableDocument[] = [
    { id: '1', text: 'French Defense e4 e6' },
    { id: '2', text: 'Caro-Kann e4 c6' },
  ];

  const query = parseSearchQuery('sicilian');
  const results = search(query, docs);

  assert.deepEqual(results, []);
});

test('search: inputs are not mutated', () => {
  const originalDocs: SearchableDocument[] = [
    { id: '2', text: 'Ruy Ruy', fields: { variant: 'blitz' } },
    { id: '1', text: 'Ruy', fields: { variant: 'blitz' } },
  ];

  const docsCopy = JSON.parse(JSON.stringify(originalDocs));
  const query = parseSearchQuery('ruy variant:blitz');
  const queryCopy = JSON.parse(JSON.stringify(query));

  search(query, originalDocs);

  assert.deepEqual(originalDocs, docsCopy);
  assert.deepEqual(query, queryCopy);
});
