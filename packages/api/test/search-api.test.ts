import test from 'node:test';
import assert from 'node:assert/strict';
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
