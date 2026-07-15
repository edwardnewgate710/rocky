/**
 * Tests for `resolveConfig` — focused on the CORS invariants enforced per
 * ADR-0011 and the cookieSecure default from ADR-0012. The middleware
 * reflects exact origins and never emits `*`, so an invalid CORS config
 * should fail fast at startup rather than silently misbehave.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';

const SECRET = 'x'.repeat(32);

describe('resolveConfig CORS validation', () => {
  it('rejects a wildcard "*" in allowedOrigins', () => {
    assert.throws(
      () =>
        resolveConfig({
          accessTokenSecret: SECRET,
          cors: { allowedOrigins: ['*'], allowCredentials: false },
        }),
      /must not contain '\*'/,
    );
  });

  it('rejects allowCredentials with an empty allowlist', () => {
    assert.throws(
      () =>
        resolveConfig({
          accessTokenSecret: SECRET,
          cors: { allowedOrigins: [], allowCredentials: true },
        }),
      /allowCredentials is true but cors.allowedOrigins is empty/,
    );
  });

  it('accepts credentials with explicit origins', () => {
    const cfg = resolveConfig({
      accessTokenSecret: SECRET,
      cors: { allowedOrigins: ['https://app.example.com'], allowCredentials: true },
    });
    assert.equal(cfg.cors.allowCredentials, true);
    assert.deepEqual(cfg.cors.allowedOrigins, ['https://app.example.com']);
  });

  it('accepts the safe default (empty allowlist, no credentials)', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET });
    assert.deepEqual(cfg.cors.allowedOrigins, []);
    assert.equal(cfg.cors.allowCredentials, false);
    assert.equal(cfg.enableHsts, true);
  });
});

describe('resolveConfig cookieSecure', () => {
  it('defaults cookieSecure to true', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET });
    assert.equal(cfg.cookieSecure, true);
  });

  it('accepts cookieSecure: false for local/dev over HTTP', () => {
    const cfg = resolveConfig({ accessTokenSecret: SECRET, cookieSecure: false });
    assert.equal(cfg.cookieSecure, false);
  });
});
