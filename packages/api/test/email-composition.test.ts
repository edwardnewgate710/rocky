import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSenderFromEnv } from '../src/email/composition.js';
import { ConsoleEmailSender } from '../src/ports/email.js';
import { ResendEmailSender } from '../src/email/resend-email-sender.js';

describe('email delivery composition', () => {
  it('composes only an explicitly selected console sender outside production', () => {
    assert.ok(createEmailSenderFromEnv({
      NODE_ENV: 'development',
      EMAIL_PROVIDER: 'console',
    }) instanceof ConsoleEmailSender);
  });

  it('composes the single production provider from validated configuration', () => {
    assert.ok(createEmailSenderFromEnv({
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_secret',
      EMAIL_FROM: 'security@example.com',
      PUBLIC_WEB_ORIGIN: 'https://chess.example.com',
    }) instanceof ResendEmailSender);
  });

  it('fails closed instead of falling back when production configuration is absent', () => {
    assert.throws(
      () => createEmailSenderFromEnv({ NODE_ENV: 'production' }),
      /EMAIL_PROVIDER is required/,
    );
  });
});
