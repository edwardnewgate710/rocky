import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryTokenStore,
  NoSessionError,
  SessionManager,
} from '../src/net/session.js';
import type { StoredSession } from '../src/net/session.js';
import type { AuthResponse } from '../src/api/models.js';

function authResponse(access = 'access-1', refresh = 'refresh-1', expiresIn = 3600): AuthResponse {
  return {
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2020-01-01T00:00:00Z', roles: ['user'] },
    tokens: {
      accessToken: access,
      tokenType: 'Bearer',
      expiresIn,
      refreshToken: refresh,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  };
}

function storedSession(): StoredSession {
  const a = authResponse();
  return { user: a.user, tokens: a.tokens, accessTokenExpiresAt: 123 };
}

test('MemoryTokenStore stores and clears', () => {
  const store = new MemoryTokenStore();
  assert.equal(store.load(), null);
  store.save(storedSession());
  assert.ok(store.load());
  store.clear();
  assert.equal(store.load(), null);
});

test('M12 inc 2: MemoryTokenStore never writes to any Web Storage', () => {
  // The token store is in-memory only — no setItem should ever be called.
  // This is the core XSS hardening: the access token is never in localStorage.
  const store = new MemoryTokenStore();
  const session = storedSession();
  store.save(session);
  assert.ok(store.load());
  assert.equal(store.load()!.tokens.accessToken, 'access-1');
  // No storage involved — clearing the store is purely in-memory.
  store.clear();
  assert.equal(store.load(), null);
});

test('M12 inc 2: after login, SessionManager holds access token in memory only', () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  mgr.adopt(authResponse('tok-A', 'ref-A', 3600));
  // The access token is available in memory.
  assert.equal(mgr.authorizationHeader(), 'Bearer tok-A');
  assert.equal(mgr.isAuthenticated, true);
  // But there is no storage to inspect — it's purely in the MemoryTokenStore.
  // On a "reload" (new SessionManager), the token is gone:
  const mgr2 = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  assert.equal(mgr2.isAuthenticated, false);
  assert.equal(mgr2.authorizationHeader(), undefined);
});

test('adopt computes access-token expiry from the injected clock', () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 1000 });
  const session = mgr.adopt(authResponse('a', 'r', 60));
  assert.equal(session.accessTokenExpiresAt, 1000 + 60 * 1000);
  assert.equal(mgr.isAuthenticated, true);
  assert.equal(mgr.authorizationHeader(), 'Bearer a');
});

test('isAccessTokenExpired respects leeway', () => {
  let now = 0;
  const mgr = new SessionManager({
    refresh: async () => authResponse(),
    now: () => now,
    expiryLeewayMs: 1000,
  });
  mgr.adopt(authResponse('a', 'r', 10)); // expires at 10_000
  now = 8000;
  assert.equal(mgr.isAccessTokenExpired(), false);
  now = 9000; // inside the 1000ms leeway
  assert.equal(mgr.isAccessTokenExpired(), true);
});

test('validAccessToken refreshes proactively when expired', async () => {
  let now = 0;
  let refreshCalls = 0;
  const mgr = new SessionManager({
    refresh: async () => {
      refreshCalls += 1;
      return authResponse('fresh', 'r2', 3600);
    },
    now: () => now,
    expiryLeewayMs: 0,
  });
  mgr.adopt(authResponse('stale', 'r1', 1)); // expires at 1000
  now = 5000;
  assert.equal(await mgr.validAccessToken(), 'fresh');
  assert.equal(refreshCalls, 1);
});

test('validAccessToken returns undefined without a session', async () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 0 });
  assert.equal(await mgr.validAccessToken(), undefined);
});

test('refreshNow coalesces concurrent callers (single-flight)', async () => {
  let refreshCalls = 0;
  let resolveRefresh: ((value: AuthResponse) => void) | undefined;
  const mgr = new SessionManager({
    refresh: () => {
      refreshCalls += 1;
      return new Promise<AuthResponse>((resolve) => {
        resolveRefresh = resolve;
      });
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));
  const p1 = mgr.refreshNow();
  const p2 = mgr.refreshNow();
  resolveRefresh?.(authResponse('b', 'r2', 3600));
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(refreshCalls, 1);
  assert.equal(s1.tokens.accessToken, 'b');
  assert.equal(s2.tokens.accessToken, 'b');
});

test('refreshNow clears the session and rethrows on failure', async () => {
  const mgr = new SessionManager({
    refresh: async () => {
      throw new Error('refresh boom');
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'r', 1));
  await assert.rejects(mgr.refreshNow(), /refresh boom/);
  assert.equal(mgr.isAuthenticated, false);
});

test('refreshNow without a session throws NoSessionError', async () => {
  const mgr = new SessionManager({ refresh: async () => authResponse(), now: () => 0 });
  await assert.rejects(mgr.refreshNow(), NoSessionError);
});

test('M12 inc 2: refreshNow passes the refresh token to the refresh function', async () => {
  let receivedToken: string | undefined;
  const mgr = new SessionManager({
    refresh: async (token?: string) => {
      receivedToken = token;
      return authResponse('fresh', 'r2', 3600);
    },
    now: () => 0,
  });
  mgr.adopt(authResponse('a', 'my-refresh', 1));
  await mgr.refreshNow();
  assert.equal(receivedToken, 'my-refresh');
});

test('M12 inc 2: refreshNow works without a refresh token (cookie-based)', async () => {
  // Simulate a restored session with no refresh token (cookie-based).
  let receivedToken: string | undefined;
  const mgr = new SessionManager({
    refresh: async (token?: string) => {
      receivedToken = token;
      return authResponse('fresh', 'r2', 3600);
    },
    now: () => 0,
  });
  // Adopt a session that has no refresh token (simulating cookie-based restore).
  mgr.adopt({
    user: authResponse().user,
    tokens: { accessToken: 'a', tokenType: 'Bearer', expiresIn: 1, refreshExpiresAt: '' },
  });
  await mgr.refreshNow();
  assert.equal(receivedToken, undefined, 'refresh function should receive undefined when no token');
});
