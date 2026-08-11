/**
 * Tests for password recovery API client methods (AuthApi).
 *
 * Verifies exact HTTP method, URL path, request body, status handling,
 * and error behavior for request and confirm password reset endpoints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, empty, json } from './support/fake-transport.js';

function make(transport: FakeTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => {},
    now: () => 1000,
  });
}

test('AuthApi.requestPasswordReset: issues POST /v1/auth/password-reset/request with body', async () => {
  const t = new FakeTransport(() => empty(202));
  const client = make(t);

  await client.auth.requestPasswordReset({ handleOrEmail: 'alice@example.com' });

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.method, 'POST');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/password-reset/request');
  assert.equal(t.calls[0]!.body, JSON.stringify({ handleOrEmail: 'alice@example.com' }));
});

test('AuthApi.confirmPasswordReset: issues POST /v1/auth/password-reset/confirm with body', async () => {
  const t = new FakeTransport(() => empty(204));
  const client = make(t);

  await client.auth.confirmPasswordReset({ token: 'tok-12345', newPassword: 'newpassword123' });

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.method, 'POST');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/password-reset/confirm');
  assert.equal(t.calls[0]!.body, JSON.stringify({ token: 'tok-12345', newPassword: 'newpassword123' }));
  assert.equal(t.calls[0]!.credentials, 'include');
});

test('AuthApi.confirmPasswordReset: handles 401 invalid/expired token error', async () => {
  const t = new FakeTransport(() => json(401, { message: 'Invalid or expired token' }));
  const client = make(t);

  await assert.rejects(
    () => client.auth.confirmPasswordReset({ token: 'bad-token', newPassword: 'newpassword123' }),
    (err: Error) => {
      assert.match(err.message, /401/);
      return true;
    },
  );
});
