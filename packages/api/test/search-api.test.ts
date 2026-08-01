import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_EMBEDDING_DIMENSIONS } from '@chess-platform/search';
import { startHarness } from './helpers';

test('GET /v1/search: query matching indexed documents', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.searchRepository);
    await harness.searchRepository.index({ id: 'doc-1', text: 'tactical endgame puzzle' });
    await harness.searchRepository.index({ id: 'doc-2', text: 'grandmaster blitz tournament' });
    await harness.searchRepository.index({ id: 'doc-3', text: 'endgame study with rooks' });

    const res = await harness.json('GET', '/v1/search?q=endgame');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.results.length, 2);
    const ids = res.body.results.map((r: { id: string }) => r.id);
    assert.ok(ids.includes('doc-1'));
    assert.ok(ids.includes('doc-3'));
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: natural-language promotion converts terms to filters', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.searchRepository);
    await harness.searchRepository.index({
      id: 'game-1',
      text: 'magnus vs hikaru',
      fields: { speed: 'blitz', result: '1-0' },
    });
    await harness.searchRepository.index({
      id: 'game-2',
      text: 'fabiano vs alireza',
      fields: { speed: 'rapid', result: '1-0' },
    });

    const res = await harness.json('GET', '/v1/search?q=blitz');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].id, 'game-1');
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: pagination with limit and offset', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.searchRepository);
    await harness.searchRepository.index({ id: 'doc-a', text: 'chess tactic alpha' });
    await harness.searchRepository.index({ id: 'doc-b', text: 'chess tactic beta' });
    await harness.searchRepository.index({ id: 'doc-c', text: 'chess tactic gamma' });

    const res = await harness.json('GET', '/v1/search?q=tactic&limit=1&offset=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.results.length, 1);
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: validation errors for missing/blank q and invalid limit/offset', async () => {
  const harness = await startHarness();
  try {
    const resNoQ = await harness.json('GET', '/v1/search');
    assert.equal(resNoQ.status, 422);

    const resEmptyQ = await harness.json('GET', '/v1/search?q=');
    assert.equal(resEmptyQ.status, 422);

    const resBlankQ = await harness.json('GET', '/v1/search?q=%20%20');
    assert.equal(resBlankQ.status, 422);

    const resBadOffset = await harness.json('GET', '/v1/search?q=test&offset=-1');
    assert.equal(resBadOffset.status, 422);

    const resNonIntOffset = await harness.json('GET', '/v1/search?q=test&offset=abc');
    assert.equal(resNonIntOffset.status, 422);

    const resBadLimit = await harness.json('GET', '/v1/search?q=test&limit=0');
    assert.equal(resBadLimit.status, 422);
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: 503 when search repository is not configured', async () => {
  const harness = await startHarness({}, { withoutSearch: true });
  try {
    const res = await harness.json('GET', '/v1/search?q=test');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.message, 'search is not configured');
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: mode absent equals mode=keyword', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.searchRepository);
    await harness.searchRepository.index({ id: 'doc-1', text: 'tactical endgame puzzle' });

    const resDefault = await harness.json('GET', '/v1/search?q=tactical');
    const resKeyword = await harness.json('GET', '/v1/search?q=tactical&mode=keyword');

    assert.equal(resDefault.status, 200);
    assert.equal(resKeyword.status, 200);
    assert.deepEqual(resDefault.body, resKeyword.body);
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: mode=semantic ranks semantically-near document above far one', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.semanticSearchRepository && harness.embeddingProvider);
    const textNear = 'tactical endgame puzzle';
    const textFar = 'unrelated baking recipe with flour';

    const embNear = await harness.embeddingProvider.embed(textNear);
    const embFar = await harness.embeddingProvider.embed(textFar);

    await harness.semanticSearchRepository.index({ id: 'doc-near', text: textNear, embedding: embNear });
    await harness.semanticSearchRepository.index({ id: 'doc-far', text: textFar, embedding: embFar });

    const res = await harness.json('GET', '/v1/search?q=tactical&mode=semantic');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.results[0].id, 'doc-near');
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: mode=hybrid returns union of keyword-only and vector-only matches', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.semanticSearchRepository && harness.embeddingProvider);

    const dummyEmb = new Array(SEARCH_EMBEDDING_DIMENSIONS).fill(0);
    await harness.semanticSearchRepository.index({ id: 'doc-kw', text: 'endgame study', embedding: dummyEmb });

    const embVec = await harness.embeddingProvider.embed('endgame study');
    await harness.semanticSearchRepository.index({
      id: 'doc-vec',
      text: 'unrelated words',
      embedding: embVec,
    });

    const res = await harness.json('GET', '/v1/search?q=endgame&mode=hybrid');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    const ids = res.body.results.map((r: { id: string }) => r.id);
    assert.ok(ids.includes('doc-kw'));
    assert.ok(ids.includes('doc-vec'));
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: mode=semantic honours filter parsed out of q', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.semanticSearchRepository && harness.embeddingProvider);
    const text1 = 'magnus vs hikaru';
    const emb1 = await harness.embeddingProvider.embed(text1);

    await harness.semanticSearchRepository.index({
      id: 'game-blitz',
      text: text1,
      embedding: emb1,
      fields: { variant: 'blitz' },
    });
    await harness.semanticSearchRepository.index({
      id: 'game-rapid',
      text: text1,
      embedding: emb1,
      fields: { variant: 'rapid' },
    });

    const res = await harness.json('GET', '/v1/search?q=magnus%20variant:blitz&mode=semantic');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.results[0].id, 'game-blitz');
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: mode=bogus returns 422 validation error', async () => {
  const harness = await startHarness();
  try {
    const res = await harness.json('GET', '/v1/search?q=test&mode=bogus');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.message, '"mode" must be one of keyword, semantic, hybrid');
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: 503 when semantic search is not configured', async () => {
  const harness = await startHarness({}, { withoutSemanticSearch: true });
  try {
    const resSemantic = await harness.json('GET', '/v1/search?q=test&mode=semantic');
    assert.equal(resSemantic.status, 503);
    assert.equal(resSemantic.body.error.message, 'semantic search is not configured');

    const resHybrid = await harness.json('GET', '/v1/search?q=test&mode=hybrid');
    assert.equal(resHybrid.status, 503);
    assert.equal(resHybrid.body.error.message, 'semantic search is not configured');
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: pagination with limit and offset in semantic mode', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.semanticSearchRepository && harness.embeddingProvider);
    for (const id of ['doc-a', 'doc-b', 'doc-c']) {
      const emb = await harness.embeddingProvider.embed(`chess tactic ${id}`);
      await harness.semanticSearchRepository.index({ id, text: `chess tactic ${id}`, embedding: emb });
    }

    const res = await harness.json('GET', '/v1/search?q=tactic&mode=semantic&limit=1&offset=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.results.length, 1);
  } finally {
    await harness.close();
  }
});

test('GET /v1/search: embedding text excludes filters', async () => {
  const harness = await startHarness();
  try {
    assert.ok(harness.semanticSearchRepository && harness.embeddingProvider);
    const emb1 = await harness.embeddingProvider.embed('tactics puzzle');
    const emb2 = await harness.embeddingProvider.embed('tactics study');

    await harness.semanticSearchRepository.index({ id: 'doc-1', text: 'tactics puzzle', embedding: emb1, fields: { variant: 'blitz' } });
    await harness.semanticSearchRepository.index({ id: 'doc-2', text: 'tactics study', embedding: emb2, fields: { variant: 'blitz' } });

    const resWithFilter = await harness.json('GET', '/v1/search?q=tactics%20variant:blitz&mode=semantic');
    const resWithoutFilter = await harness.json('GET', '/v1/search?q=tactics&mode=semantic');

    assert.equal(resWithFilter.status, 200);
    assert.equal(resWithoutFilter.status, 200);
    // Compare SCORES, not just the order. Both documents are variant:blitz, so the filter excludes
    // nothing and a merely-reordered assertion would still pass if `variant`/`blitz` had been hashed
    // into the query vector. Identical cosine scores are what actually proves they were not.
    assert.deepEqual(resWithFilter.body.results, resWithoutFilter.body.results);
  } finally {
    await harness.close();
  }
});

