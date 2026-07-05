import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryTokenStore,
  NoSessionError,
  SessionManager,
  WebStorageTokenStore,
} from '../src/net/session.js';
import type { KeyValueStorage, StoredSession } from '../src/net/session.js';
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

class FakeStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

test('MemoryTokenStore stores and clears', () => {
  const store = new MemoryTokenStore();
  assert.equal(store.load(), null);
  store.save(storedSession());
  assert.ok(store.load());
  store.clear();
  assert.equal(store.load(), null);
});

test('WebStorageTokenStore round-trips and rejects corrupt payloads', () => {
  const storage = new FakeStorage();
  const store = new WebStorageTokenStore(storage, 'k');
  assert.equal(store.load(), null);
  const session = storedSession();
  store.save(session);
  assert.deepEqual(store.load(), session);
  storage.setItem('k', 'not-json');
  assert.equal(store.load(), null);
  store.clear();
  assert.equal(store.load(), null);
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
