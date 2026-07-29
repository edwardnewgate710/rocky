import test from 'node:test';
import * as assert from 'node:assert/strict';
import { hybridSearch } from '../src/hybrid';
import { parseSearchQuery } from '../src/query';
import type { SemanticSearchableDocument } from '../src/semantic';

test('hybrid: union behavior (doc found by only one signal still appears)', () => {
  // Query text: "sicilian"
  // Query vector: [1, 0, 0]
  const docs: SemanticSearchableDocument[] = [
    { id: 'keyword-only', text: 'sicilian defense e4 c5', embedding: [0, 1, 0] }, // matches "sicilian", orthogonal vector
    { id: 'semantic-only', text: 'french defense e4 e6', embedding: [1, 0, 0] }, // no "sicilian", matching vector
  ];

  const query = parseSearchQuery('sicilian');
  const queryVector = [1, 0, 0];

  const results = hybridSearch(query, queryVector, docs, { keywordWeight: 0.5 });

  assert.equal(results.length, 2);
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes('keyword-only'));
  assert.ok(ids.includes('semantic-only'));
});

test('hybrid: keywordWeight: 1 produces exact keyword ordering', () => {
  const docs: SemanticSearchableDocument[] = [
    { id: 'doc-low-kw', text: 'ruy', embedding: [1, 0, 0] }, // 1 occurrence, perfect vector
    { id: 'doc-high-kw', text: 'ruy ruy ruy', embedding: [0, 1, 0] }, // 3 occurrences, orthogonal vector
  ];

  const query = parseSearchQuery('ruy');
  const queryVector = [1, 0, 0];

  const results = hybridSearch(query, queryVector, docs, { keywordWeight: 1 });

  // Keyword ordering ranks doc-high-kw first
  assert.deepEqual(
    results.map((r) => r.id),
    ['doc-high-kw', 'doc-low-kw']
  );
});

test('hybrid: keywordWeight: 0 produces exact semantic ordering', () => {
  const docs: SemanticSearchableDocument[] = [
    { id: 'doc-low-kw', text: 'ruy', embedding: [1, 0, 0] }, // 1 occurrence, perfect vector
    { id: 'doc-high-kw', text: 'ruy ruy ruy', embedding: [0, 1, 0] }, // 3 occurrences, orthogonal vector
  ];

  const query = parseSearchQuery('ruy');
  const queryVector = [1, 0, 0];

  const results = hybridSearch(query, queryVector, docs, { keywordWeight: 0 });

  // Semantic ordering ranks doc-low-kw first (embedding matches queryVector)
  assert.deepEqual(
    results.map((r) => r.id),
    ['doc-low-kw', 'doc-high-kw']
  );
});

test('hybrid: invalid option validation throws RangeError', () => {
  const docs: SemanticSearchableDocument[] = [
    { id: '1', text: 'test', embedding: [1, 0, 0] },
  ];
  const query = parseSearchQuery('test');
  const queryVector = [1, 0, 0];

  const invalidKeywordWeights = [-0.1, 1.1, NaN, Infinity, -Infinity];
  for (const w of invalidKeywordWeights) {
    assert.throws(
      () => hybridSearch(query, queryVector, docs, { keywordWeight: w }),
      (err: unknown) => err instanceof RangeError
    );
  }

  const invalidRrfKs = [0, -1, -60, NaN, Infinity, -Infinity];
  for (const k of invalidRrfKs) {
    assert.throws(
      () => hybridSearch(query, queryVector, docs, { rrfK: k }),
      (err: unknown) => err instanceof RangeError
    );
  }
});

test('hybrid: pure and inputs are not mutated', () => {
  const docs: SemanticSearchableDocument[] = [
    { id: '2', text: 'ruy ruy', embedding: [1, 0, 0] },
    { id: '1', text: 'ruy', embedding: [1, 0, 0] },
  ];
  const docsCopy = JSON.parse(JSON.stringify(docs));
  const query = parseSearchQuery('ruy');
  const queryVector = [1, 0, 0];

  hybridSearch(query, queryVector, docs, { keywordWeight: 0.5, rrfK: 60 });

  assert.deepEqual(docs, docsCopy);
});
