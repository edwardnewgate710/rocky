import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthController } from '../src/app/auth-controller.js';
import type { AuthSession } from '../src/app/auth-controller.js';

function makeFakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

function makeFakeClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      login: async () => ({
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-1', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-1', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      }),
      register: async () => ({
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-2', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      }),
      logout: async () => {},
      refresh: async () => ({
        user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-refreshed', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      }),
      ...overrides,
    },
  };
}

test('initial session is null and isAuthenticated is false', () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  assert.equal(ctrl.currentSession, null);
  assert.equal(ctrl.isAuthenticated(), false);
});

test('login creates a session with correct fields from AuthResponse', async () => {
  const client = makeFakeClient() as any;
  let sessions: (AuthSession | null)[] = [];
  let pending: boolean[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: (p) => { pending.push(p); },
      onError: () => {},
    },
  });
  const session = await ctrl.login('alice', 'pw');
  assert.ok(session);
  assert.equal(session!.handle, 'alice');
  assert.equal(session!.userId, 'u1');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.deepEqual(pending, [true, false]);
});

test('M12 inc 2: login does NOT persist the access token to storage', async () => {
  const storage = makeFakeStorage();
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  await ctrl.login('alice', 'pw');
  const raw = storage.getItem('gambit-session')!;
  const parsed = JSON.parse(raw);
  assert.equal(parsed.accessToken, undefined, 'accessToken must not be persisted');
  assert.equal(parsed.handle, 'alice');
  assert.equal(parsed.userId, 'u1');
});

test('register creates a session with correct fields', async () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  const session = await ctrl.register('bob', 'pw');
  assert.ok(session);
  assert.equal(session!.handle, 'bob');
  assert.equal(session!.userId, 'u2');
});

test('logout clears session and calls onSessionChange(null)', async () => {
  const client = makeFakeClient() as any;
  let sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
  });
  await ctrl.login('alice', 'pw');
  await ctrl.logout();
  assert.equal(ctrl.currentSession, null);
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(sessions[sessions.length - 1], null);
});

test('M12 inc 2: restore loads session from storage via cookie-based refresh', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    handle: 'stored-user', userId: 'u3',
  }));
  let session: AuthSession | null = null;
  const ctrl = new AuthController({
    client: makeFakeClient() as any,
    callbacks: { onSessionChange: (s) => { session = s; }, onPending: () => {}, onError: () => {} },
    storage,
  });
  const restored = await ctrl.restore();
  assert.ok(restored);
  assert.equal(restored!.handle, 'stored-user');
  assert.equal(restored!.userId, 'u3');
  assert.equal(session, restored);
});

test('M12 inc 2: restore returns null when storage is empty', async () => {
  const storage = makeFakeStorage();
  const ctrl = new AuthController({
    client: makeFakeClient() as any,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  assert.equal(await ctrl.restore(), null);
});

test('M12 inc 2: restore returns null when refresh fails (cookie expired)', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    handle: 'stored-user', userId: 'u3',
  }));
  const client = makeFakeClient({
    refresh: async () => { throw new Error('cookie expired'); },
  }) as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  const restored = await ctrl.restore();
  assert.equal(restored, null);
  // Persisted state should be cleared.
  assert.equal(storage.getItem('gambit-session'), null);
});

test('errors are reported via onError', async () => {
  const client = makeFakeClient({
    login: async () => { throw new Error('bad password'); },
  }) as any;
  let errors: string[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: (m) => { errors.push(m); } },
  });
  const result = await ctrl.login('alice', 'wrong');
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'bad password');
});


test('M12 inc 2: reload path — persisted {handle,userId} + refresh yields session + access token', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    handle: 'stored-user', userId: 'u3',
  }));
  let refreshCalled = false;
  let refreshResult: any = null;
  const client = makeFakeClient({
    refresh: async () => {
      refreshCalled = true;
      refreshResult = {
        user: { id: 'u3', handle: 'stored-user', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'fresh-from-cookie', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      };
      return refreshResult;
    },
  }) as any;
  // Add a mock session that tracks the current access token (like SessionManager does).
  let currentAccessToken: string | undefined;
  client.session = {
    get current() { return currentAccessToken ? { tokens: { accessToken: currentAccessToken } } : null; },
    adopt: (auth: any) => { currentAccessToken = auth.tokens.accessToken; },
    reset: () => { currentAccessToken = undefined; },
    get isAuthenticated() { return currentAccessToken !== undefined; },
  };
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage,
  });
  const restored = await ctrl.restore();
  assert.ok(restored, 'restore should return a session');
  assert.equal(restored!.handle, 'stored-user');
  assert.equal(refreshCalled, true, 'refresh should have been called via cookie');
  // The refresh response should contain a valid access token.
  assert.ok(refreshResult?.tokens?.accessToken, 'refresh response should contain an access token');
  assert.equal(refreshResult.tokens.accessToken, 'fresh-from-cookie');
});

test('dispose ignores future calls', async () => {
  const client = makeFakeClient() as any;
  let changes = 0;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => { changes++; }, onPending: () => {}, onError: () => {} },
  });
  ctrl.dispose();
  await ctrl.login('alice', 'pw');
  assert.equal(changes, 0);
  assert.equal(ctrl.isAuthenticated(), false);
});

test('M2: isAuthenticated gates create-seek path', async () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  // Before login: not authenticated
  assert.equal(ctrl.isAuthenticated(), false);
  // After login: authenticated
  await ctrl.login('alice', 'pw');
  assert.equal(ctrl.isAuthenticated(), true);
  // After logout: not authenticated
  await ctrl.logout();
  assert.equal(ctrl.isAuthenticated(), false);
});
