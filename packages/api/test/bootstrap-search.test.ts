import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPgDependencies } from '../src/bootstrap';
import { InMemorySearchRepository } from '@chess-platform/search';

test('createPgDependencies: searchRepository present by default and absent when SEARCH_ENABLED=0', () => {
  const originalEnv = process.env['SEARCH_ENABLED'];
  const originalSecret = process.env['ACCESS_TOKEN_SECRET'];
  process.env['ACCESS_TOKEN_SECRET'] = 'test-secret-at-least-32-chars-long-12345';
  const pool = new Pool();

  try {
    delete process.env['SEARCH_ENABLED'];
    const { deps: defaultDeps } = createPgDependencies({ pool });
    assert.ok(defaultDeps.searchRepository, 'searchRepository should be present by default');

    process.env['SEARCH_ENABLED'] = '0';
    const { deps: disabledDeps } = createPgDependencies({ pool });
    assert.strictEqual(
      disabledDeps.searchRepository,
      undefined,
      'searchRepository should be undefined when SEARCH_ENABLED=0'
    );

    // S3: Absolute kill switch: injected searchRepository is suppressed when SEARCH_ENABLED=0
    const injected = new InMemorySearchRepository();
    const { deps: overrideDisabledDeps } = createPgDependencies({
      pool,
      searchRepository: injected,
    });
    assert.strictEqual(
      overrideDisabledDeps.searchRepository,
      undefined,
      'injected searchRepository should be undefined when SEARCH_ENABLED=0'
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env['SEARCH_ENABLED'] = originalEnv;
    } else {
      delete process.env['SEARCH_ENABLED'];
    }
    if (originalSecret !== undefined) {
      process.env['ACCESS_TOKEN_SECRET'] = originalSecret;
    } else {
      delete process.env['ACCESS_TOKEN_SECRET'];
    }
    void pool.end();
  }
});
