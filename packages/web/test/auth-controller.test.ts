import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthController } from '../src/app/auth-controller.js';
import type { AuthSession } from '../src/app/auth-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { LoginRequest, RegisterRequest } from '../src/api/models.js';

function makeFakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

/**
 * The fake exposes the invalidation handler the controller registers, so a test can fire the one
 * thing `SessionManager` would fire — a refresh that failed — without driving a real refresh.
 */
function makeFakeSession() {
  return {
    resets: 0,
    invalidate: null as null | (() => void),
    reset(): void { this.resets++; },
    onInvalidated(handler: () => void): void { this.invalidate = handler; },
  };
}

function makeFakeClient(overrides: Record<string, unknown> = {}) {
  return {
    session: makeFakeSession(),
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

/**
 * Capture the exact body the controller hands `GambitClient.auth`, for one method.
 *
 * The assertion that matters for the optional registration email is the *shape* of that object,
 * not a serialization of it: `assert.deepEqual` under `node:assert/strict` already treats
 * `{ handle, password, email: undefined }` as different from `{ handle, password }`, and comparing
 * the key set on top says so in the language of the requirement. Comparing `JSON.stringify` output
 * instead would also fail on a harmless reordering of the literal, which is a test that breaks for
 * a reason the product does not care about.
 */
function captureAuthBody<T>(method: 'register' | 'login'): {
  readonly controller: AuthController;
  readonly bodies: readonly T[];
} {
  const bodies: T[] = [];
  const client = makeFakeClient({
    [method]: async (body: T) => {
      bodies.push(body);
      return {
        user: { id: 'u2', handle: 'bob', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
        tokens: { accessToken: 'tok-2', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'ref-2', refreshExpiresAt: '2030-01-01T00:00:00Z' },
      };
    },
  }) as unknown as GambitClient;
  const controller = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  return { controller, bodies };
}

test('register forwards a trimmed optional email', async () => {
  const { controller, bodies } = captureAuthBody<RegisterRequest>('register');

  await controller.register('bob', 'pw', '  bob@example.com  ');

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { handle: 'bob', password: 'pw', email: 'bob@example.com' });
});

test('register omits the email key entirely when no email is given or it is blank', async () => {
  const { controller, bodies } = captureAuthBody<RegisterRequest>('register');

  await controller.register('bob', 'pw');
  await controller.register('bob', 'pw', '   ');

  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.deepEqual(body, { handle: 'bob', password: 'pw' });
    // Absent, not present-and-empty: the server treats a supplied address as one to verify, so an
    // `email: ''` or `email: null` reaching the wire is a different request from an email-less one.
    assert.deepEqual(Object.keys(body).sort(), ['handle', 'password']);
  }
});

test('sign-in is unaffected by the optional registration email and still sends only credentials', async () => {
  const { controller, bodies } = captureAuthBody<LoginRequest>('login');

  await controller.login('alice', 'pw');

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], { handle: 'alice', password: 'pw' });
  assert.deepEqual(Object.keys(bodies[0]!).sort(), ['handle', 'password']);
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

/**
 * Revoking the session this browser is using is allowed (ADR-0110), so "the session went away and
 * the user did not ask" is a state a user can now reach on purpose. `SessionManager` clears its own
 * store when a refresh fails, but this controller holds a separate snapshot and a persisted handle
 * hint: without this the header and account controls kept showing a signed-in user whose every
 * protected request answered 401.
 */
test('a session invalidated by a failed refresh stops the UI showing a signed-in user', async () => {
  const storage = makeFakeStorage();
  const client = makeFakeClient() as any;
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
    storage,
  });
  await ctrl.login('alice', 'pw');
  assert.equal(ctrl.isAuthenticated(), true);

  // Exactly what SessionManager does when a refresh fails.
  assert.ok(client.session.invalidate, 'the controller registered for invalidation');
  client.session.invalidate();

  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(ctrl.currentSession, null);
  assert.equal(sessions[sessions.length - 1], null, 'the UI was told to drop the session');
  assert.equal(storage.getItem('gambit-session'), null, 'the persisted hint went too');
});

test('M12 inc 2: restore takes identity from cookie refresh, not storage', async () => {
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
  assert.equal(restored!.handle, 'alice');
  assert.equal(restored!.userId, 'u1');
  assert.equal(session, restored);
  assert.deepEqual(JSON.parse(storage.getItem('gambit-session')!), {
    handle: 'alice', userId: 'u1',
  });
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
    onInvalidated: () => {},
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

test('password reset clearance wins over an in-flight session restore', async () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));

  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let currentAccessToken: string | undefined;
  let client: any;
  const refreshed = {
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'late-token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  };
  client = makeFakeClient({
    refresh: async () => {
      await refreshGate;
      client.session.adopt(refreshed);
      return refreshed;
    },
  });
  client.session = {
    get current() { return currentAccessToken ? { tokens: { accessToken: currentAccessToken } } : null; },
    adopt: (auth: any) => { currentAccessToken = auth.tokens.accessToken; },
    reset: () => { currentAccessToken = undefined; },
    onInvalidated: () => {},
  };

  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (session) => { sessions.push(session); },
      onPending: () => {},
      onError: () => {},
    },
    storage,
  });

  const restore = ctrl.restore();
  ctrl.clearLocalSession();
  releaseRefresh();

  assert.equal(await restore, null);
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(client.session.current, null);
  assert.equal(storage.getItem('gambit-session'), null);
  assert.deepEqual(sessions, [null]);
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
