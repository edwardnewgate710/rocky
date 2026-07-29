import test from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemorySemanticSearchRepository } from '../src/semantic-repository';
import { HashingEmbeddingProvider } from '../src/embedding';
import { parseSearchQuery } from '../src/query';
import type { SemanticSearchableDocument } from '../src/semantic';

test('semantic-repository: index, indexAll, size, remove, clear', async () => {
  const repo = new InMemorySemanticSearchRepository();
  assert.equal(await repo.size(), 0);

  const doc1: SemanticSearchableDocument = {
    id: 'doc:1',
    text: 'Sicilian Defense',
    embedding: [1, 0, 0],
  };

  await repo.index(doc1);
  assert.equal(await repo.size(), 1);

  // Upsert with updated text/embedding
  const doc1Updated: SemanticSearchableDocument = {
    id: 'doc:1',
    text: 'Sicilian Defense Accelerated Dragon',
    embedding: [1, 0, 0],
  };
  await repo.index(doc1Updated);
  assert.equal(await repo.size(), 1);

  const doc2: SemanticSearchableDocument = {
    id: 'doc:2',
    text: 'French Defense',
    embedding: [0, 1, 0],
  };
  const doc3: SemanticSearchableDocument = {
    id: 'doc:3',
    text: 'Caro-Kann Defense',
    embedding: [0, 0, 1],
  };
  await repo.indexAll([doc2, doc3]);
  assert.equal(await repo.size(), 3);

  assert.equal(await repo.remove('doc:2'), true);
  assert.equal(await repo.remove('non-existent'), false);
  assert.equal(await repo.size(), 2);

  await repo.clear();
  assert.equal(await repo.size(), 0);
});

// Regression (CodeRabbit, PR #51): a single mismatched embedding used to be accepted, and every
// later query then threw from cosineSimilarity — one bad write took down reads for the whole index.
test('semantic-repository: a mismatched embedding is rejected at write, not at every later read', async () => {
  const repo = new InMemorySemanticSearchRepository();
  await repo.index({ id: 'good', text: 'Sicilian', embedding: [1, 0, 0] });

  await assert.rejects(
    () => repo.index({ id: 'bad', text: 'French', embedding: [1, 0] }),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.ok(err.message.includes('bad'));
      return true;
    }
  );

  // The bad document never entered the index, so queries still work.
  assert.equal(await repo.size(), 1);
  const page = await repo.querySemantic([1, 0, 0]);
  assert.equal(page.total, 1);
  assert.equal(page.results[0].id, 'good');
});

test('semantic-repository: indexAll rejects a mismatched embedding mid-batch', async () => {
  const repo = new InMemorySemanticSearchRepository();

  await assert.rejects(
    () =>
      repo.indexAll([
        { id: '1', text: 'a', embedding: [1, 0, 0] },
        { id: '2', text: 'b', embedding: [0, 1] },
        { id: '3', text: 'c', embedding: [0, 0, 1] },
      ]),
    (err: unknown) => err instanceof RangeError
  );

  // Documents before the offending one are kept; the index stays queryable.
  assert.equal(await repo.size(), 1);
  assert.equal((await repo.querySemantic([1, 0, 0])).total, 1);
});

test('semantic-repository: clearing releases the dimension so the index can be reused', async () => {
  const repo = new InMemorySemanticSearchRepository();
  await repo.index({ id: '1', text: 'a', embedding: [1, 0, 0] });
  await repo.clear();

  await repo.index({ id: '2', text: 'b', embedding: [1, 0] });
  assert.equal(await repo.size(), 1);
  assert.equal((await repo.querySemantic([1, 0])).results[0].id, '2');
});

// Emptying via remove() must land in the same state as clear() (CodeRabbit, PR #51).
test('semantic-repository: removing the last document releases the dimension too', async () => {
  const repo = new InMemorySemanticSearchRepository();
  await repo.indexAll([
    { id: '1', text: 'a', embedding: [1, 0, 0] },
    { id: '2', text: 'b', embedding: [0, 1, 0] },
  ]);

  // Still latched while any document remains.
  await repo.remove('1');
  await assert.rejects(
    () => repo.index({ id: '3', text: 'c', embedding: [1, 0] }),
    (err: unknown) => err instanceof RangeError
  );

  await repo.remove('2');
  assert.equal(await repo.size(), 0);
  await repo.index({ id: '4', text: 'd', embedding: [1, 0] });
  assert.equal((await repo.querySemantic([1, 0])).results[0].id, '4');
});

test('semantic-repository: pagination clamping semantics (offset/limit)', async () => {
  const repo = new InMemorySemanticSearchRepository();
  const docs: SemanticSearchableDocument[] = [
    { id: '1', text: 'Doc 1', embedding: [1, 0, 0] },
    { id: '2', text: 'Doc 2', embedding: [0.9, 0.1, 0] },
    { id: '3', text: 'Doc 3', embedding: [0.8, 0.2, 0] },
    { id: '4', text: 'Doc 4', embedding: [0.7, 0.3, 0] },
    { id: '5', text: 'Doc 5', embedding: [0.6, 0.4, 0] },
  ];
  await repo.indexAll(docs);

  const queryVector = [1, 0, 0];

  // Default / no options -> total 5, all 5 results
  const page1 = await repo.querySemantic(queryVector);
  assert.equal(page1.total, 5);
  assert.equal(page1.results.length, 5);

  // In-range offset & limit -> offset 1, limit 2
  const page2 = await repo.querySemantic(queryVector, { offset: 1, limit: 2 });
  assert.equal(page2.total, 5);
  assert.equal(page2.results.length, 2);
  assert.equal(page2.results[0].id, '2');
  assert.equal(page2.results[1].id, '3');

  // Negative offset & limit clamp to 0
  const pageNegative = await repo.querySemantic(queryVector, { offset: -5, limit: -10 });
  assert.equal(pageNegative.total, 5);
  assert.equal(pageNegative.results.length, 0); // limit 0 => 0 items

  // Beyond-end offset
  const pageBeyond = await repo.querySemantic(queryVector, { offset: 100, limit: 5 });
  assert.equal(pageBeyond.total, 5);
  assert.equal(pageBeyond.results.length, 0);
});

test('semantic-repository: end-to-end round trip with HashingEmbeddingProvider', async () => {
  const provider = new HashingEmbeddingProvider(256);
  const repo = new InMemorySemanticSearchRepository();

  const ruyText = 'Ruy Lopez Spanish Opening e4 e5 Nf3 Nc6 Bb5';
  const sicilianText = 'Sicilian Defense e4 c5 Nf3 d6 d4 cxd4';
  const frenchText = 'French Defense e4 e6 d4 d5 Nc3 Bb4';

  const docRuy: SemanticSearchableDocument = {
    id: 'game:ruy',
    text: ruyText,
    embedding: await provider.embed(ruyText),
  };
  const docSicilian: SemanticSearchableDocument = {
    id: 'game:sicilian',
    text: sicilianText,
    embedding: await provider.embed(sicilianText),
  };
  const docFrench: SemanticSearchableDocument = {
    id: 'game:french',
    text: frenchText,
    embedding: await provider.embed(frenchText),
  };

  await repo.indexAll([docRuy, docSicilian, docFrench]);

  // Semantic query: embed query text and query repository
  const queryText = 'Sicilian Defense e4 c5';
  const queryVector = await provider.embed(queryText);

  const semanticPage = await repo.querySemantic(queryVector, { limit: 1 });
  assert.equal(semanticPage.total, 3);
  assert.equal(semanticPage.results.length, 1);
  assert.equal(semanticPage.results[0].id, 'game:sicilian');

  // Hybrid query: combine query object and query vector
  const queryObj = parseSearchQuery(queryText);
  const hybridPage = await repo.queryHybrid(queryObj, queryVector, { limit: 2 });
  assert.equal(hybridPage.total, 3);
  assert.equal(hybridPage.results.length, 2);
  assert.equal(hybridPage.results[0].id, 'game:sicilian');
});
