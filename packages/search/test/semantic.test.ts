import test from 'node:test';
import * as assert from 'node:assert/strict';
import { semanticSearch, type SemanticSearchableDocument } from '../src/semantic';
import { parseSearchQuery } from '../src/query';

test('semantic: ranking order (higher cosine similarity comes first)', () => {
  const queryVector = [1, 0, 0];
  const docs: SemanticSearchableDocument[] = [
    { id: 'low', text: 'Low similarity', embedding: [0.5, 0.866, 0] }, // similarity 0.5
    { id: 'high', text: 'High similarity', embedding: [0.9, 0.436, 0] }, // similarity ~0.9
    { id: 'perfect', text: 'Perfect similarity', embedding: [1, 0, 0] }, // similarity 1.0
  ];

  const results = semanticSearch(queryVector, docs);

  assert.deepEqual(
    results.map((r) => r.id),
    ['perfect', 'high', 'low']
  );
  assert.equal(results[0].score, 1);
});

test('semantic: minScore threshold drops hits strictly below threshold', () => {
  const queryVector = [1, 0, 0];
  const docs: SemanticSearchableDocument[] = [
    { id: '1', text: 'Doc 1', embedding: [1, 0, 0] }, // score 1.0
    { id: '2', text: 'Doc 2', embedding: [0.5, 0.866, 0] }, // score 0.5
    { id: '3', text: 'Doc 3', embedding: [0.2, 0.98, 0] }, // score 0.2
  ];

  const results = semanticSearch(queryVector, docs, { minScore: 0.5 });

  assert.deepEqual(
    results.map((r) => r.id),
    ['1', '2']
  );
});

// Regression (CodeRabbit, PR #51): `score < NaN` is false for every document, so a NaN threshold
// silently returned the entire index instead of filtering it.
test('semantic: a non-finite minScore is rejected rather than silently disabling the threshold', () => {
  const docs: SemanticSearchableDocument[] = [
    { id: '1', text: 'Doc 1', embedding: [1, 0, 0] },
    { id: '2', text: 'Doc 2', embedding: [0, 1, 0] },
  ];

  for (const minScore of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => semanticSearch([1, 0, 0], docs, { minScore }),
      (err: unknown) => err instanceof RangeError,
      `expected minScore ${minScore} to be rejected`
    );
  }

  // A finite threshold still works, including the falsy 0.
  assert.equal(semanticSearch([1, 0, 0], docs, { minScore: 0.5 }).length, 1);
  assert.equal(semanticSearch([1, 0, 0], docs, { minScore: 0 }).length, 2);
});

test('semantic: filters work including negation', () => {
  const queryVector = [1, 0, 0];
  const docs: SemanticSearchableDocument[] = [
    { id: '1', text: 'Doc 1', fields: { variant: 'blitz', result: '1-0' }, embedding: [1, 0, 0] },
    { id: '2', text: 'Doc 2', fields: { variant: 'blitz', result: '0-1' }, embedding: [1, 0, 0] },
    { id: '3', text: 'Doc 3', fields: { variant: 'bullet', result: '1-0' }, embedding: [1, 0, 0] },
  ];

  const query = parseSearchQuery('variant:blitz -result:1-0');
  const results = semanticSearch(queryVector, docs, { filters: query.filters });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '2');
});

test('semantic: stable id tie-break for equal scores', () => {
  const queryVector = [1, 0, 0];
  const docs: SemanticSearchableDocument[] = [
    { id: 'charlie', text: 'Doc C', embedding: [1, 0, 0] },
    { id: 'alpha', text: 'Doc A', embedding: [1, 0, 0] },
    { id: 'bravo', text: 'Doc B', embedding: [1, 0, 0] },
  ];

  const results = semanticSearch(queryVector, docs);

  assert.deepEqual(
    results.map((r) => r.id),
    ['alpha', 'bravo', 'charlie']
  );
});

test('semantic: dimension mismatch propagates RangeError', () => {
  const queryVector = [1, 0, 0];
  const docs: SemanticSearchableDocument[] = [
    { id: 'mismatch', text: 'Doc', embedding: [1, 0] }, // length 2 vs length 3
  ];

  assert.throws(
    () => semanticSearch(queryVector, docs),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.ok(err.message.includes('3'));
      assert.ok(err.message.includes('2'));
      return true;
    }
  );
});

test('semantic: pure and inputs are not mutated', () => {
  const queryVector = [1, 0, 0];
  const originalDocs: SemanticSearchableDocument[] = [
    { id: '2', text: 'Doc 2', embedding: [1, 0, 0] },
    { id: '1', text: 'Doc 1', embedding: [1, 0, 0] },
  ];

  const docsCopy = JSON.parse(JSON.stringify(originalDocs));
  const queryVectorCopy = [...queryVector];

  semanticSearch(queryVector, originalDocs);

  assert.deepEqual(originalDocs, docsCopy);
  assert.deepEqual(queryVector, queryVectorCopy);
});
