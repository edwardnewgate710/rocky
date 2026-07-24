import test from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemorySearchRepository } from '../src/repository';
import { parseSearchQuery } from '../src/query';
import type { SearchableDocument } from '../src/search';

test('repository: index + query + size', async () => {
  const repo = new InMemorySearchRepository();
  assert.equal(await repo.size(), 0);

  const doc1: SearchableDocument = { id: 'doc1', text: 'Ruy Lopez opening for White' };
  const doc2: SearchableDocument = { id: 'doc2', text: 'Sicilian Defense opening for Black' };
  const doc3: SearchableDocument = { id: 'doc3', text: 'French Defense tactics' };

  await repo.index(doc1);
  await repo.index(doc2);
  await repo.index(doc3);

  assert.equal(await repo.size(), 3);

  const query = parseSearchQuery('opening');
  const page = await repo.query(query);

  assert.equal(page.total, 2);
  assert.equal(page.results.length, 2);
  assert.deepEqual(
    page.results.map((r) => r.id),
    ['doc1', 'doc2']
  );
});

test('repository: upsert by id replaces content and retains size', async () => {
  const repo = new InMemorySearchRepository();
  const initialDoc: SearchableDocument = { id: 'game-1', text: 'Ruy Lopez e4 e5' };
  await repo.index(initialDoc);

  assert.equal(await repo.size(), 1);
  assert.equal((await repo.query(parseSearchQuery('ruy'))).total, 1);

  const updatedDoc: SearchableDocument = { id: 'game-1', text: 'Caro-Kann e4 c6' };
  await repo.index(updatedDoc);

  assert.equal(await repo.size(), 1);
  assert.equal((await repo.query(parseSearchQuery('ruy'))).total, 0);
  const page = await repo.query(parseSearchQuery('caro'));
  assert.equal(page.total, 1);
  assert.equal(page.results[0].id, 'game-1');
});

test('repository: remove returns boolean and decrements size', async () => {
  const repo = new InMemorySearchRepository();
  await repo.index({ id: 'doc1', text: 'King endgame' });

  assert.equal(await repo.remove('absent-id'), false);
  assert.equal(await repo.size(), 1);

  assert.equal(await repo.remove('doc1'), true);
  assert.equal(await repo.size(), 0);

  const page = await repo.query(parseSearchQuery('endgame'));
  assert.equal(page.total, 0);
  assert.equal(page.results.length, 0);
});

test('repository: indexAll + clear', async () => {
  const repo = new InMemorySearchRepository();
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Pawn storm' },
    { id: '2', text: 'Knight fork' },
    { id: '3', text: 'Bishop pin' },
  ];

  await repo.indexAll(docs);
  assert.equal(await repo.size(), 3);

  await repo.clear();
  assert.equal(await repo.size(), 0);

  const page = await repo.query(parseSearchQuery('pawn'));
  assert.equal(page.total, 0);
  assert.deepEqual(page.results, []);
});

test('repository: pagination (limit, offset, past end, negative clamping, undefined limit)', async () => {
  const repo = new InMemorySearchRepository();
  const docs: SearchableDocument[] = [
    { id: 'doc1', text: 'chess tactic chess' }, // score: 2 for 'chess'
    { id: 'doc2', text: 'chess tactic' }, // score: 1 for 'chess'
    { id: 'doc3', text: 'chess strategy' }, // score: 1 for 'chess' (id tie-break after doc2)
    { id: 'doc4', text: 'chess endgame' }, // score: 1 for 'chess'
    { id: 'doc5', text: 'chess opening' }, // score: 1 for 'chess'
  ];

  await repo.indexAll(docs);
  const q = parseSearchQuery('chess');

  // Undefined limit => returns all
  const pageAll = await repo.query(q);
  assert.equal(pageAll.total, 5);
  assert.equal(pageAll.results.length, 5);
  assert.deepEqual(
    pageAll.results.map((r) => r.id),
    ['doc1', 'doc2', 'doc3', 'doc4', 'doc5']
  );

  // limit: 2 => first 2 hits
  const page1 = await repo.query(q, { limit: 2 });
  assert.equal(page1.total, 5);
  assert.deepEqual(
    page1.results.map((r) => r.id),
    ['doc1', 'doc2']
  );

  // offset: 2, limit: 2 => 3rd and 4th hits
  const page2 = await repo.query(q, { offset: 2, limit: 2 });
  assert.equal(page2.total, 5);
  assert.deepEqual(
    page2.results.map((r) => r.id),
    ['doc3', 'doc4']
  );

  // offset past end => empty results with correct total
  const pagePastEnd = await repo.query(q, { offset: 10, limit: 2 });
  assert.equal(pagePastEnd.total, 5);
  assert.deepEqual(pagePastEnd.results, []);

  // negative limit and offset clamp to 0
  const pageClamped = await repo.query(q, { offset: -5, limit: -2 });
  assert.equal(pageClamped.total, 5);
  assert.deepEqual(pageClamped.results, []);
});

test('repository: determinism across calls (score DESC, id ASC tie-break)', async () => {
  const repo = new InMemorySearchRepository();
  const docs: SearchableDocument[] = [
    { id: 'charlie', text: 'puzzle study' },
    { id: 'alpha', text: 'puzzle study' },
    { id: 'bravo', text: 'puzzle study' },
  ];

  await repo.indexAll(docs);
  const q = parseSearchQuery('puzzle');

  const pageA = await repo.query(q);
  const pageB = await repo.query(q);

  assert.deepEqual(pageA, pageB);
  assert.deepEqual(
    pageA.results.map((r) => r.id),
    ['alpha', 'bravo', 'charlie']
  );
});

test('repository: immutability (input docs and index state not mutated)', async () => {
  const repo = new InMemorySearchRepository();
  const originalDoc: SearchableDocument = { id: 'doc1', text: 'Original text', fields: { tag: 'v1' } };
  const docCopy = JSON.parse(JSON.stringify(originalDoc));

  await repo.index(originalDoc);
  assert.deepEqual(originalDoc, docCopy);

  const q = parseSearchQuery('original');
  const page1 = await repo.query(q);
  assert.equal(await repo.size(), 1);

  const page2 = await repo.query(q);
  assert.deepEqual(page1, page2);
  assert.deepEqual(originalDoc, docCopy);
});

