/**
 * Tests for SessionsController.
 *
 * Covers loading, revocation, the authoritative reload afterwards, pending state, error handling,
 * double-action protection, and the disposal guarantees the SPA route lifecycle depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionsController } from '../src/app/sessions-controller.js';
import type { SessionView } from '../src/api/models.js';
import type { GambitClient } from '../src/api/client.js';

function session(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
    lastSeenAt: null,
    lastIp: null,
    lastUserAgent: null,
    createdIp: '203.0.113.9',
    createdUserAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
    ...over,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createMockClient(initial: SessionView[] = []) {
  let list = [...initial];
  let listCalls = 0;
  const revokeCalls: string[] = [];
  let revokeGate: Promise<void> | null = null;
  let revokeError: Error | null = null;

  const mockAuth = {
    sessions: async () => {
      listCalls++;
      return list;
    },
    revokeSession: async (id: string) => {
      revokeCalls.push(id);
      if (revokeGate) await revokeGate;
      if (revokeError) throw revokeError;
      list = list.map((s) => (s.id === id ? { ...s, revokedAt: '2026-08-16T00:00:00.000Z' } : s));
    },
  };

  return {
    client: { auth: mockAuth } as unknown as GambitClient,
    get listCalls() { return listCalls; },
    get revokeCalls() { return revokeCalls; },
    setList: (next: SessionView[]) => { list = [...next]; },
    gateRevoke: (gate: Promise<void>) => { revokeGate = gate; },
    failRevoke: (err: Error) => { revokeError = err; },
  };
}

function collector() {
  const sessions: (readonly SessionView[])[] = [];
  const pending: boolean[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  return {
    sessions, pending, errors, statuses,
    callbacks: {
      onSessions: (s: readonly SessionView[]) => sessions.push(s),
      onPending: (p: boolean) => pending.push(p),
      onError: (m: string) => errors.push(m),
      onStatus: (m: string) => statuses.push(m),
    },
  };
}

test('load publishes the session list', async () => {
  const mock = createMockClient([session('s1'), session('s2')]);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });

  await ctrl.load();

  assert.equal(sink.sessions.length, 1);
  assert.deepEqual(sink.sessions[0]!.map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(sink.errors, []);
});

test('a load failure surfaces as an error and publishes no list', async () => {
  const mock = createMockClient();
  const failing = {
    auth: { sessions: async () => { throw new Error('network down'); } },
  } as unknown as GambitClient;
  const sink = collector();
  const ctrl = new SessionsController({ client: failing, callbacks: sink.callbacks });

  await ctrl.load();

  assert.deepEqual(sink.errors, ['network down']);
  assert.equal(sink.sessions.length, 0);
  assert.equal(mock.listCalls, 0);
});

test('revoking calls the endpoint and then reloads from the server', async () => {
  const mock = createMockClient([session('s1'), session('s2')]);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });

  await ctrl.load();
  await ctrl.revokeSession('s1');

  assert.deepEqual(mock.revokeCalls, ['s1']);
  assert.equal(mock.listCalls, 2, 'the list is re-read rather than patched locally');
  const latest = sink.sessions.at(-1)!;
  assert.notEqual(latest.find((s) => s.id === 's1')!.revokedAt, null);
  assert.deepEqual(sink.statuses, ['Session revoked.']);
});

test('a failed revoke reports the error and does not claim success', async () => {
  const mock = createMockClient([session('s1')]);
  mock.failRevoke(new Error('Session not found'));
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });

  await ctrl.load();
  await ctrl.revokeSession('s1');

  assert.deepEqual(sink.errors, ['Session not found']);
  assert.deepEqual(sink.statuses, [], 'no success message on failure');
  assert.equal(mock.listCalls, 1, 'no reload after a failed revoke');
});

/**
 * `onPending` disables the buttons, but the flag has to travel through a callback and into the DOM.
 * A second click landing in the same tick would otherwise issue a second DELETE for a state change
 * that happens once — and produce a second audit record on the server for it.
 */
test('a second revoke of the same id while one is in flight is dropped', async () => {
  const mock = createMockClient([session('s1')]);
  const gate = deferred<void>();
  mock.gateRevoke(gate.promise);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });
  await ctrl.load();

  const first = ctrl.revokeSession('s1');
  const second = ctrl.revokeSession('s1');
  gate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(mock.revokeCalls, ['s1'], 'exactly one request left the client');
});

test('a different session may still be revoked while one is in flight', async () => {
  const mock = createMockClient([session('s1'), session('s2')]);
  const gate = deferred<void>();
  mock.gateRevoke(gate.promise);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });
  await ctrl.load();

  const a = ctrl.revokeSession('s1');
  const b = ctrl.revokeSession('s2');
  gate.resolve();
  await Promise.all([a, b]);

  assert.deepEqual(mock.revokeCalls.sort(), ['s1', 's2']);
});

test('pending is announced true then false around a revoke', async () => {
  const mock = createMockClient([session('s1')]);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });

  await ctrl.load();
  await ctrl.revokeSession('s1');

  assert.deepEqual(sink.pending, [true, false]);
});

// --- Disposal: what the SPA route lifecycle depends on -----------------------

test('a load resolving after disposal publishes nothing', async () => {
  const gate = deferred<SessionView[]>();
  const slow = { auth: { sessions: () => gate.promise } } as unknown as GambitClient;
  const sink = collector();
  const ctrl = new SessionsController({ client: slow, callbacks: sink.callbacks });

  const inFlight = ctrl.load();
  ctrl.dispose();
  gate.resolve([session('s1')]);
  await inFlight;

  assert.equal(sink.sessions.length, 0, 'no state update after disposal');
  assert.deepEqual(sink.errors, []);
});

test('a revoke resolving after disposal publishes neither status nor reload', async () => {
  const mock = createMockClient([session('s1')]);
  const gate = deferred<void>();
  mock.gateRevoke(gate.promise);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });
  await ctrl.load();

  const inFlight = ctrl.revokeSession('s1');
  ctrl.dispose();
  gate.resolve();
  await inFlight;

  assert.deepEqual(sink.statuses, [], 'no status announced into a disposed route');
  assert.equal(mock.listCalls, 1, 'no reload triggered after disposal');
});

test('load and revoke are inert after disposal', async () => {
  const mock = createMockClient([session('s1')]);
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });

  ctrl.dispose();
  await ctrl.load();
  await ctrl.revokeSession('s1');

  assert.equal(mock.listCalls, 0);
  assert.deepEqual(mock.revokeCalls, []);
  assert.equal(sink.sessions.length, 0);
});

test('dispose is idempotent', () => {
  const mock = createMockClient();
  const sink = collector();
  const ctrl = new SessionsController({ client: mock.client, callbacks: sink.callbacks });

  ctrl.dispose();
  ctrl.dispose();
  ctrl.dispose();

  assert.deepEqual(sink.errors, []);
});

/**
 * `reset` is the sign-out path, not the teardown path: the controller stays usable, but a response
 * already in flight for the previous account must not paint that account's devices and IPs onto the
 * next one's screen.
 */
test('reset drops an in-flight load and clears the snapshot', async () => {
  const gate = deferred<SessionView[]>();
  const slow = { auth: { sessions: () => gate.promise } } as unknown as GambitClient;
  const sink = collector();
  const ctrl = new SessionsController({ client: slow, callbacks: sink.callbacks });

  const inFlight = ctrl.load();
  ctrl.reset();
  gate.resolve([session('s1')]);
  await inFlight;

  assert.equal(sink.sessions.length, 0, 'the previous account\'s sessions are not published');
  assert.deepEqual(ctrl.currentSessions, []);
});
