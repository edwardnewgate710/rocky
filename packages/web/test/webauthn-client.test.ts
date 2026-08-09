/**
 * Tests for WebAuthn API client methods (AuthApi).
 *
 * Verifies exact method, path, body, auth, and cookie/session adoption semantics
 * across all six WebAuthn endpoints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json, empty } from './support/fake-transport.js';
import type {
  AuthResponse,
  WebAuthnRegisterVerifyRequest,
  WebAuthnLoginVerifyRequest,
} from '../src/api/models.js';

function make(transport: FakeTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => {},
    now: () => 1000,
  });
}

function auth(access: string): AuthResponse {
  return {
    user: {
      id: 'u-alice',
      handle: 'alice',
      country: null,
      createdAt: '2026-01-01T00:00:00Z',
      roles: ['user'],
    },
    tokens: {
      accessToken: access,
      tokenType: 'Bearer',
      expiresIn: 3600,
      refreshToken: 'refresh',
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  };
}

test('AuthApi.listPasskeys: issues GET /v1/auth/webauthn/passkeys with auth: true', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok')),
    () => json(200, [{ id: 'cred-1', name: 'Passkey 1', createdAt: '2026-01-01T00:00:00Z' }]),
  );
  const client = make(t);
  await client.auth.login({ handle: 'a', password: 'b' });

  const result = await client.auth.listPasskeys();

  assert.equal(t.calls[1]!.method, 'GET');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/auth/webauthn/passkeys');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, 'cred-1');
});

test('AuthApi.deletePasskey: issues DELETE /v1/auth/webauthn/passkeys/:id with URI encoding and auth: true', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok')),
    () => empty(204),
  );
  const client = make(t);
  await client.auth.login({ handle: 'a', password: 'b' });

  await client.auth.deletePasskey('cred/special+id=');

  assert.equal(t.calls[1]!.method, 'DELETE');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/auth/webauthn/passkeys/cred%2Fspecial%2Bid%3D');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok');
});

test('AuthApi.registerPasskeyOptions: issues POST /v1/auth/webauthn/register/options with auth: true', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok')),
    () => json(200, {
      challenge: 'ch123',
      rp: { name: 'Gambit', id: 'localhost' },
      user: { id: 'u1', name: 'alice', displayName: 'alice' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
    }),
  );
  const client = make(t);
  await client.auth.login({ handle: 'a', password: 'b' });

  const opts = await client.auth.registerPasskeyOptions();

  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/auth/webauthn/register/options');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok');
  assert.equal(opts.challenge, 'ch123');
});

test('AuthApi.verifyPasskeyRegister: issues POST /v1/auth/webauthn/register/verify with body and auth: true', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok')),
    () => json(200, { id: 'cred-new', name: 'Passkey', createdAt: '2026-01-01T00:00:00Z' }),
  );
  const client = make(t);
  await client.auth.login({ handle: 'a', password: 'b' });

  const body: WebAuthnRegisterVerifyRequest = {
    id: 'cred-new',
    rawId: 'cred-new',
    type: 'public-key',
    response: {
      clientDataJSON: 'base64json',
      attestationObject: 'base64cbor',
    },
  };

  const res = await client.auth.verifyPasskeyRegister(body);

  assert.equal(t.calls[1]!.method, 'POST');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/auth/webauthn/register/verify');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok');
  assert.deepEqual(JSON.parse(t.calls[1]!.body as string), body);
  assert.equal(res.id, 'cred-new');
});

test('AuthApi.loginPasskeyOptions: issues POST /v1/auth/webauthn/login/options with handle body', async () => {
  const t = new FakeTransport(
    () => json(200, {
      challenge: 'ch456',
      timeout: 60000,
      rpId: 'localhost',
      userVerification: 'required',
    }),
  );
  const client = make(t);

  const opts = await client.auth.loginPasskeyOptions({ handle: 'alice' });

  assert.equal(t.calls[0]!.method, 'POST');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/webauthn/login/options');
  assert.equal(t.calls[0]!.headers['authorization'], undefined);
  assert.equal(t.calls[0]!.credentials, undefined);
  assert.deepEqual(JSON.parse(t.calls[0]!.body as string), { handle: 'alice' });
  assert.equal(opts.challenge, 'ch456');
});

test('AuthApi.verifyPasskeyLogin: issues POST /v1/auth/webauthn/login/verify with credentials: include and adopts session', async () => {
  const t = new FakeTransport(
    () => json(200, auth('access-token-xyz')),
  );
  const client = make(t);

  const body: WebAuthnLoginVerifyRequest = {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key',
    response: {
      clientDataJSON: 'clientData',
      authenticatorData: 'authData',
      signature: 'sig',
      userHandle: 'u-alice',
    },
  };

  const result = await client.auth.verifyPasskeyLogin(body);

  assert.equal(t.calls[0]!.method, 'POST');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/auth/webauthn/login/verify');
  assert.equal(t.calls[0]!.credentials, 'include');
  assert.deepEqual(JSON.parse(t.calls[0]!.body as string), body);
  assert.equal(result.user.handle, 'alice');
  assert.equal(client.session.isAuthenticated, true);
  assert.equal(client.session.current?.tokens.accessToken, 'access-token-xyz');
});
