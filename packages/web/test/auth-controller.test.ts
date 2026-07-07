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
      login: async () => ({ token: 'tok-1', handle: 'alice', userId: 'u1' }),
      register: async () => ({ token: 'tok-2', handle: 'bob', userId: 'u2' }),
      logout: async () => {},
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

test('login sets the session and calls onSessionChange', async () => {
  const client = makeFakeClient() as any;
  const sessions: (AuthSession | null)[] = [];
  const pendingStates: boolean[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: (p) => { pendingStates.push(p); },
      onError: () => {},
    },
  });
  const result = await ctrl.login('alice', 'pw');
  assert.ok(result);
  assert.equal(result!.handle, 'alice');
  assert.equal(result!.token, 'tok-1');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.handle, 'alice');
  assert.deepEqual(pendingStates, [true, false]);
});

test('register sets the session and calls onSessionChange', async () => {
  const client = makeFakeClient() as any;
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
  });
  const result = await ctrl.register('bob', 'pw');
  assert.ok(result);
  assert.equal(result!.handle, 'bob');
  assert.equal(result!.token, 'tok-2');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.handle, 'bob');
});

test('login error is reported via onError and session stays null', async () => {
  const client = makeFakeClient({
    login: async () => { throw new Error('invalid credentials'); },
  }) as any;
  const errors: string[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: () => {},
      onPending: () => {},
      onError: (m) => { errors.push(m); },
    },
  });
  const result = await ctrl.login('alice', 'wrong');
  assert.equal(result, null);
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'invalid credentials');
});

test('logout clears the session and calls onSessionChange with null', async () => {
  const client = makeFakeClient() as any;
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
  });
  await ctrl.login('alice', 'pw');
  sessions.length = 0;
  await ctrl.logout();
  assert.equal(ctrl.currentSession, null);
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0], null);
});

test('logout clears persisted storage', async () => {
  const storage = makeFakeStorage();
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage: storage as any,
  });
  await ctrl.login('alice', 'pw');
  assert.ok(storage.getItem('gambit-session'));
  await ctrl.logout();
  assert.equal(storage.getItem('gambit-session'), null);
});

test('login persists session to storage', async () => {
  const storage = makeFakeStorage();
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage: storage as any,
  });
  await ctrl.login('alice', 'pw');
  const raw = storage.getItem('gambit-session');
  assert.ok(raw);
  const parsed = JSON.parse(raw!);
  assert.equal(parsed.handle, 'alice');
  assert.equal(parsed.token, 'tok-1');
});

test('restore recovers a persisted session from storage', () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', JSON.stringify({
    token: 'tok-x',
    handle: 'carol',
    userId: 'u3',
  }));
  const client = makeFakeClient() as any;
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
    storage: storage as any,
  });
  const restored = ctrl.restore();
  assert.ok(restored);
  assert.equal(restored!.handle, 'carol');
  assert.equal(restored!.token, 'tok-x');
  assert.equal(ctrl.isAuthenticated(), true);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.handle, 'carol');
});

test('restore returns null when storage is empty', () => {
  const storage = makeFakeStorage();
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage: storage as any,
  });
  const restored = ctrl.restore();
  assert.equal(restored, null);
  assert.equal(ctrl.isAuthenticated(), false);
});

test('restore clears corrupted storage entries', () => {
  const storage = makeFakeStorage();
  storage.setItem('gambit-session', 'not-json{');
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
    storage: storage as any,
  });
  const restored = ctrl.restore();
  assert.equal(restored, null);
  assert.equal(storage.getItem('gambit-session'), null);
});

test('restore returns null when no storage is provided', () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  assert.equal(ctrl.restore(), null);
});

test('logout is non-fatal on server error — clears locally regardless', async () => {
  const client = makeFakeClient({
    logout: async () => { throw new Error('server gone'); },
  }) as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  await ctrl.login('alice', 'pw');
  assert.equal(ctrl.isAuthenticated(), true);
  await ctrl.logout();
  assert.equal(ctrl.isAuthenticated(), false);
  assert.equal(ctrl.currentSession, null);
});

test('dispose ignores future calls', async () => {
  const client = makeFakeClient() as any;
  const sessions: (AuthSession | null)[] = [];
  const ctrl = new AuthController({
    client,
    callbacks: {
      onSessionChange: (s) => { sessions.push(s); },
      onPending: () => {},
      onError: () => {},
    },
  });
  ctrl.dispose();
  const result = await ctrl.login('alice', 'pw');
  assert.equal(result, null);
  assert.equal(sessions.length, 0);
  assert.equal(ctrl.isAuthenticated(), false);
});

test('isAuthenticated can be used as a predicate for lobby gating (M2)', async () => {
  const client = makeFakeClient() as any;
  const ctrl = new AuthController({
    client,
    callbacks: { onSessionChange: () => {}, onPending: () => {}, onError: () => {} },
  });
  // Before login: not authenticated.
  assert.equal(ctrl.isAuthenticated(), false);
  await ctrl.login('alice', 'pw');
  // After login: authenticated — create-seek should be allowed.
  assert.equal(ctrl.isAuthenticated(), true);
  await ctrl.logout();
  // After logout: not authenticated — create-seek should be gated.
  assert.equal(ctrl.isAuthenticated(), false);
});
