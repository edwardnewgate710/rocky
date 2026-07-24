import test from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemorySearchRepository } from '../src/repository';
import { parseSearchQuery } from '../src/query';
import type { SearchableDocument } from '../src/search';

test('repository: index + query + size', () => {
  const repo = new InMemorySearchRepository();
  assert.equal(repo.size(), 0);

  const doc1: SearchableDocument = { id: 'doc1', text: 'Ruy Lopez opening for White' };
  const doc2: SearchableDocument = { id: 'doc2', text: 'Sicilian Defense opening for Black' };
  const doc3: SearchableDocument = { id: 'doc3', text: 'French Defense tactics' };

  repo.index(doc1);
  repo.index(doc2);
  repo.index(doc3);

  assert.equal(repo.size(), 3);

  const query = parseSearchQuery('opening');
  const page = repo.query(query);

  assert.equal(page.total, 2);
  assert.equal(page.results.length, 2);
  assert.deepEqual(
    page.results.map((r) => r.id),
    ['doc1', 'doc2']
  );
});

test('repository: upsert by id replaces content and retains size', () => {
  const repo = new InMemorySearchRepository();
  const initialDoc: SearchableDocument = { id: 'game-1', text: 'Ruy Lopez e4 e5' };
  repo.index(initialDoc);

  assert.equal(repo.size(), 1);
  assert.equal(repo.query(parseSearchQuery('ruy')).total, 1);

  const updatedDoc: SearchableDocument = { id: 'game-1', text: 'Caro-Kann e4 c6' };
  repo.index(updatedDoc);

  assert.equal(repo.size(), 1);
  assert.equal(repo.query(parseSearchQuery('ruy')).total, 0);
  const page = repo.query(parseSearchQuery('caro'));
  assert.equal(page.total, 1);
  assert.equal(page.results[0].id, 'game-1');
});

test('repository: remove returns boolean and decrements size', () => {
  const repo = new InMemorySearchRepository();
  repo.index({ id: 'doc1', text: 'King endgame' });

  assert.equal(repo.remove('absent-id'), false);
  assert.equal(repo.size(), 1);

  assert.equal(repo.remove('doc1'), true);
  assert.equal(repo.size(), 0);

  const page = repo.query(parseSearchQuery('endgame'));
  assert.equal(page.total, 0);
  assert.equal(page.results.length, 0);
});

test('repository: indexAll + clear', () => {
  const repo = new InMemorySearchRepository();
  const docs: SearchableDocument[] = [
    { id: '1', text: 'Pawn storm' },
    { id: '2', text: 'Knight fork' },
    { id: '3', text: 'Bishop pin' },
  ];

  repo.indexAll(docs);
  assert.equal(repo.size(), 3);

  repo.clear();
  assert.equal(repo.size(), 0);

  const page = repo.query(parseSearchQuery('pawn'));
  assert.equal(page.total, 0);
  assert.deepEqual(page.results, []);
});

test('repository: pagination (limit, offset, past end, negative clamping, undefined limit)', () => {
  const repo = new InMemorySearchRepository();
  const docs: SearchableDocument[] = [
    { id: 'doc1', text: 'chess tactic chess' }, // score: 2 for 'chess'
    { id: 'doc2', text: 'chess tactic' }, // score: 1 for 'chess'
    { id: 'doc3', text: 'chess strategy' }, // score: 1 for 'chess' (id tie-break after doc2)
    { id: 'doc4', text: 'chess endgame' }, // score: 1 for 'chess'
    { id: 'doc5', text: 'chess opening' }, // score: 1 for 'chess'
  ];

  repo.indexAll(docs);
  const q = parseSearchQuery('chess');

  // Undefined limit => returns all
  const pageAll = repo.query(q);
  assert.equal(pageAll.total, 5);
  assert.equal(pageAll.results.length, 5);
  assert.deepEqual(
    pageAll.results.map((r) => r.id),
    ['doc1', 'doc2', 'doc3', 'doc4', 'doc5']
  );

  // limit: 2 => first 2 hits
  const page1 = repo.query(q, { limit: 2 });
  assert.equal(page1.total, 5);
  assert.deepEqual(
    page1.results.map((r) => r.id),
    ['doc1', 'doc2']
  );

  // offset: 2, limit: 2 => 3rd and 4th hits
  const page2 = repo.query(q, { offset: 2, limit: 2 });
  assert.equal(page2.total, 5);
  assert.deepEqual(
    page2.results.map((r) => r.id),
    ['doc3', 'doc4']
  );

  // offset past end => empty results with correct total
  const pagePastEnd = repo.query(q, { offset: 10, limit: 2 });
  assert.equal(pagePastEnd.total, 5);
  assert.deepEqual(pagePastEnd.results, []);

  // negative limit and offset clamp to 0
  const pageClamped = repo.query(q, { offset: -5, limit: -2 });
  assert.equal(pageClamped.total, 5);
  assert.deepEqual(pageClamped.results, []);
});

test('repository: determinism across calls (score DESC, id ASC tie-break)', () => {
  const repo = new InMemorySearchRepository();
  const docs: SearchableDocument[] = [
    { id: 'charlie', text: 'puzzle study' },
    { id: 'alpha', text: 'puzzle study' },
    { id: 'bravo', text: 'puzzle study' },
  ];

  repo.indexAll(docs);
  const q = parseSearchQuery('puzzle');

  const pageA = repo.query(q);
  const pageB = repo.query(q);

  assert.deepEqual(pageA, pageB);
  assert.deepEqual(
    pageA.results.map((r) => r.id),
    ['alpha', 'bravo', 'charlie']
  );
});

test('repository: immutability (input docs and index state not mutated)', () => {
  const repo = new InMemorySearchRepository();
  const originalDoc: SearchableDocument = { id: 'doc1', text: 'Original text', fields: { tag: 'v1' } };
  const docCopy = JSON.parse(JSON.stringify(originalDoc));

  repo.index(originalDoc);
  assert.deepEqual(originalDoc, docCopy);

  const q = parseSearchQuery('original');
  const page1 = repo.query(q);
  assert.equal(repo.size(), 1);

  const page2 = repo.query(q);
  assert.deepEqual(page1, page2);
  assert.deepEqual(originalDoc, docCopy);
});
