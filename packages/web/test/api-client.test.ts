import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { RetryPolicy } from '../src/net/retry.js';
import { UnauthorizedError } from '../src/net/errors.js';
import { FakeTransport, empty, json } from './support/fake-transport.js';
import type { AuthResponse, SelfUser } from '../src/api/models.js';

const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' };
const selfUser: SelfUser = {
  id: 'u1',
  handle: 'alice',
  country: null,
  createdAt: '2020-01-01T00:00:00Z',
  roles: ['user'],
};

function auth(access: string, refresh = 'r', expiresIn = 3600): AuthResponse {
  return {
    user: selfUser,
    tokens: {
      accessToken: access,
      tokenType: 'Bearer',
      expiresIn,
      refreshToken: refresh,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  };
}

function make(transport: FakeTransport): GambitClient {
  return new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: NO_RETRY,
    sleep: async () => {},
    now: () => 1000,
  });
}

test('health hits the unauthenticated endpoint', async () => {
  const t = new FakeTransport(() => json(200, { status: 'ok', name: 'gambit', version: '0.1.0' }));
  const health = await make(t).health();
  assert.equal(health.status, 'ok');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/health');
  assert.equal(t.calls[0]!.headers['authorization'], undefined);
});

test('login adopts the session and later authed calls send the bearer token', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(200, selfUser),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  assert.equal(c.session.isAuthenticated, true);
  const me = await c.users.me();
  assert.equal(me.handle, 'alice');
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
});

test('M12 inc 2: login sends credentials:include', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  assert.equal(t.calls[0]!.credentials, 'include');
});

test('M12 inc 2: register sends credentials:include', async () => {
  const t = new FakeTransport(() => json(201, auth('tok-R')));
  const c = make(t);
  await c.auth.register({ handle: 'newbie', password: 'password1' });
  assert.equal(t.calls[0]!.credentials, 'include');
});

test('authed call without a session fails fast before any request', async () => {
  const t = new FakeTransport();
  await assert.rejects(make(t).users.me(), UnauthorizedError);
  assert.equal(t.calls.length, 0);
});

test('a server 401 triggers one refresh and replays with the new token', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(401, { error: { code: 'unauthenticated', message: 'expired', requestId: 'r' } }),
    () => json(200, auth('tok-B', 'r2')),
    () => json(200, selfUser),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  const me = await c.users.me();
  assert.equal(me.handle, 'alice');
  assert.equal(t.calls.length, 4);
  assert.equal(t.calls[1]!.headers['authorization'], 'Bearer tok-A');
  // M12 inc 2: refresh sends credentials:include and no body token.
  assert.equal(t.calls[2]!.url, 'https://api.test/v1/auth/refresh');
  assert.equal(t.calls[2]!.credentials, 'include');
  assert.equal(t.calls[2]!.body, undefined);
  assert.equal(t.calls[3]!.headers['authorization'], 'Bearer tok-B');
});

test('a failed refresh surfaces the original 401 and clears the session', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A')),
    () => json(401, { error: { code: 'unauthenticated', message: 'expired', requestId: 'r' } }),
    () => json(401, { error: { code: 'invalid_grant', message: 'bad refresh', requestId: 'r2' } }),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  await assert.rejects(c.users.me(), UnauthorizedError);
  assert.equal(c.session.isAuthenticated, false);
});

test('read endpoints encode query params and path segments', async () => {
  const t = new FakeTransport(
    () => json(200, []),
    () => json(200, []),
    () => json(200, { id: 'g1' }),
  );
  const c = make(t);
  await c.leaderboard('standard', { limit: 5 });
  await c.users.games('bob', { limit: 3 });
  await c.games.byId('g 1');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/leaderboard/standard?limit=5');
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/users/bob/games?limit=3');
  assert.equal(t.calls[2]!.url, 'https://api.test/v1/games/g%201');
});

test('M12 inc 2: logout sends credentials:include and no body token', async () => {
  const t = new FakeTransport(
    () => json(200, auth('tok-A', 'refresh-Z')),
    () => empty(204),
  );
  const c = make(t);
  await c.auth.login({ handle: 'alice', password: 'pw' });
  await c.auth.logout();
  assert.equal(c.session.isAuthenticated, false);
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/auth/logout');
  assert.equal(t.calls[1]!.credentials, 'include');
  assert.equal(t.calls[1]!.body, undefined);
});

test('M12 inc 2: logout without a session is a no-op', async () => {
  const t = new FakeTransport();
  const c = make(t);
  await c.auth.logout();
  assert.equal(t.calls.length, 0);
});

test('register adopts the session', async () => {
  const t = new FakeTransport(() => json(201, auth('tok-R')));
  const c = make(t);
  const res = await c.auth.register({ handle: 'newbie', password: 'password1' });
  assert.equal(res.tokens.accessToken, 'tok-R');
  assert.equal(c.session.isAuthenticated, true);
});
