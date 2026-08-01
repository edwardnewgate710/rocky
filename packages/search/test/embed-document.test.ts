import test from 'node:test';
import assert from 'node:assert/strict';
import { HashingEmbeddingProvider, embedDocument, embedDocuments } from '../src';
import type { SearchableDocument } from '../src';

test('embedDocument: embeds text, preserves fields, and preserves absent fields without mutating input', async () => {
  const provider = new HashingEmbeddingProvider(256);
  const docWithFields: SearchableDocument = Object.freeze({
    id: 'doc-1',
    text: 'Sicilian Defense Najdorf',
    fields: Object.freeze({ variant: 'blitz', speed: 'fast' }),
  });

  const resultWithFields = await embedDocument(provider, docWithFields);
  assert.strictEqual(resultWithFields.id, 'doc-1');
  assert.strictEqual(resultWithFields.text, 'Sicilian Defense Najdorf');
  assert.deepEqual(resultWithFields.fields, { variant: 'blitz', speed: 'fast' });
  assert.strictEqual(resultWithFields.embedding.length, 256);

  const docWithoutFields: SearchableDocument = Object.freeze({
    id: 'doc-2',
    text: 'French Defense Winawer',
  });

  const resultWithoutFields = await embedDocument(provider, docWithoutFields);
  assert.strictEqual(resultWithoutFields.id, 'doc-2');
  assert.strictEqual(resultWithoutFields.text, 'French Defense Winawer');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resultWithoutFields, 'fields'), false);
  assert.strictEqual(resultWithoutFields.embedding.length, 256);
});

test('embedDocuments: embeds multiple documents sequentially preserving input order and empty arrays', async () => {
  const provider = new HashingEmbeddingProvider(128);

  const emptyResult = await embedDocuments(provider, []);
  assert.deepEqual(emptyResult, []);

  const docs: readonly SearchableDocument[] = [
    { id: 'd-1', text: 'First doc text', fields: { tag: 'a' } },
    { id: 'd-2', text: 'Second doc text' },
    { id: 'd-3', text: 'Third doc text', fields: { tag: 'c' } },
  ];

  const results = await embedDocuments(provider, docs);
  assert.strictEqual(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.id),
    ['d-1', 'd-2', 'd-3']
  );
  assert.strictEqual(results[0]?.embedding.length, 128);
  assert.strictEqual(results[1]?.embedding.length, 128);
  assert.strictEqual(results[2]?.embedding.length, 128);
  assert.deepEqual(results[0]?.fields, { tag: 'a' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(results[1], 'fields'), false);
  assert.deepEqual(results[2]?.fields, { tag: 'c' });
});
