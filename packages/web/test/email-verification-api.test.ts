/**
 * Tests for email verification API client methods (AuthApi).
 *
 * Verifies exact HTTP method, URL path, request body, status handling,
 * credentials absence, and error behavior for email verify endpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, empty, json } from './support/fake-transport.js';
import { UnauthorizedError } from '../src/net/errors.js';

function make(transport: FakeTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => {},
    now: () => 1000,
  });
}

test('AuthApi.verifyEmail: issues POST /v1/auth/email/verify with body and no credentials', async () => {
  const t = new FakeTransport(() => empty(204));
  const client = make(t);

  await client.auth.verifyEmail({ token: 'tok-abc' });

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.method, 'POST');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/email/verify');
  assert.equal(t.calls[0]!.body, JSON.stringify({ token: 'tok-abc' }));
  assert.equal(t.calls[0]!.credentials, undefined);
});

test('AuthApi.verifyEmail: handles 401 invalid/expired token error and rejects with UnauthorizedError', async () => {
  const t = new FakeTransport(() => json(401, { error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } }));
  const client = make(t);

  await assert.rejects(
    () => client.auth.verifyEmail({ token: 'bad-token' }),
    (err: unknown) => {
      assert.ok(err instanceof UnauthorizedError);
      assert.equal((err as UnauthorizedError).status, 401);
      return true;
    },
  );
});
