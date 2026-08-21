import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmailDeliveryConfig } from '../src/email/config.js';
import { buildEmailContent } from '../src/email/content.js';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test-key-not-a-real-secret',
  EMAIL_FROM: 'security@example.com',
  PUBLIC_WEB_ORIGIN: 'https://chess.example.com/',
};

describe('email delivery configuration', () => {
  it('accepts one valid production Resend configuration and normalizes the public origin', () => {
    const config = resolveEmailDeliveryConfig(PRODUCTION_ENV);

    assert.equal(config.provider, 'resend');
    assert.equal(config.publicWebOrigin, 'https://chess.example.com');
    assert.equal(config.timeoutMs, 5_000);
  });

  it('fails closed when production credentials are missing', () => {
    const { RESEND_API_KEY: _omitted, ...env } = PRODUCTION_ENV;
    assert.throws(() => resolveEmailDeliveryConfig(env), /RESEND_API_KEY is required/);
  });

  it('allows the console sender only when explicitly selected outside production', () => {
    assert.deepEqual(resolveEmailDeliveryConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'console' }), {
      provider: 'console',
    });
    assert.throws(
      () => resolveEmailDeliveryConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' }),
      /EMAIL_PROVIDER must be "resend" in production/,
    );
  });

  it('requires an explicit provider even outside production', () => {
    assert.throws(() => resolveEmailDeliveryConfig({ NODE_ENV: 'development' }), /EMAIL_PROVIDER is required/);
  });

  for (const origin of [
    'chess.example.com',
    'ftp://chess.example.com',
    'https://user:password@chess.example.com',
    'https://chess.example.com/app',
    'https://chess.example.com/?source=email',
    'https://chess.example.com/#fragment',
    'http://chess.example.com',
  ]) {
    it(`rejects unsafe production PUBLIC_WEB_ORIGIN ${origin}`, () => {
      assert.throws(
        () => resolveEmailDeliveryConfig({ ...PRODUCTION_ENV, PUBLIC_WEB_ORIGIN: origin }),
        /PUBLIC_WEB_ORIGIN/,
      );
    });
  }

  it('rejects sender values capable of adding another address or header', () => {
    for (const from of ['first@example.com,second@example.com', 'safe@example.com\r\nBcc: victim@example.com']) {
      assert.throws(() => resolveEmailDeliveryConfig({ ...PRODUCTION_ENV, EMAIL_FROM: from }), /EMAIL_FROM/);
    }
  });
});

describe('email link and content contract', () => {
  it('uses the password-reset fragment route and encodes the token', () => {
    const content = buildEmailContent('password_reset', 'https://chess.example.com', 'a b&c');
    assert.equal(content.url, 'https://chess.example.com/password-reset#token=a%20b%26c');
    assert.match(content.text, /expires in 30 minutes/);
    assert.ok(!content.text.includes('\nToken:'));
  });

  it('uses the email-verification fragment route from the same origin', () => {
    const content = buildEmailContent('email_verify', 'https://chess.example.com', 'verify/token');
    assert.equal(content.url, 'https://chess.example.com/email-verify#token=verify%2Ftoken');
    assert.ok(!content.text.includes('\nToken:'));
  });
});
