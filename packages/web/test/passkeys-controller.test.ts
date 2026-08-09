/**
 * Tests for PasskeysController.
 *
 * Verifies passkey list loading, registration, deletion, pending states,
 * error handling, authoritative reloads, and disposal / stale-load suppression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PasskeysController } from '../src/app/passkeys-controller.js';
import type { PasskeyView, WebAuthnRegisterOptions, WebAuthnRegisterVerifyRequest, WebAuthnLoginOptions, WebAuthnLoginVerifyRequest } from '../src/api/models.js';
import type { WebAuthnAdapter } from '../src/ports/webauthn.js';
import type { GambitClient } from '../src/api/client.js';

class FakeWebAuthnAdapter implements WebAuthnAdapter {
  supported = true;
  creationResponse: WebAuthnRegisterVerifyRequest = {
    id: 'cred-new',
    rawId: 'cred-new',
    type: 'public-key',
    response: { clientDataJSON: 'cd', attestationObject: 'att' },
  };
  requestResponse: WebAuthnLoginVerifyRequest = {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key',
    response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
  };

  isSupported(): boolean {
    return this.supported;
  }

  async createCredential(_options: WebAuthnRegisterOptions): Promise<WebAuthnRegisterVerifyRequest> {
    if (!this.supported) throw new Error('Not supported');
    return this.creationResponse;
  }

  async getCredential(_options: WebAuthnLoginOptions): Promise<WebAuthnLoginVerifyRequest> {
    if (!this.supported) throw new Error('Not supported');
    return this.requestResponse;
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createMockClient(passkeys: PasskeyView[] = []) {
  let list = [...passkeys];
  let listCalls = 0;
  const deleteCalls: string[] = [];
  let registerOptionsCalls = 0;
  const verifyRegisterCalls: WebAuthnRegisterVerifyRequest[] = [];

  const mockAuth = {
    listPasskeys: async () => {
      listCalls++;
      return list;
    },
    deletePasskey: async (id: string) => {
      deleteCalls.push(id);
      list = list.filter((p) => p.id !== id);
    },
    registerPasskeyOptions: async () => {
      registerOptionsCalls++;
      return {
        challenge: 'ch1',
        rp: { name: 'Gambit', id: 'localhost' },
        user: { id: 'u1', name: 'alice', displayName: 'alice' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
      } as WebAuthnRegisterOptions;
    },
    verifyPasskeyRegister: async (body: WebAuthnRegisterVerifyRequest) => {
      verifyRegisterCalls.push(body);
      const newCred: PasskeyView = { id: body.id, name: 'Passkey', createdAt: '2026-01-01T00:00:00Z' };
      list.push(newCred);
      return newCred;
    },
  };

  const client = {
    auth: mockAuth,
  } as unknown as GambitClient;

  return {
    client,
    getList: () => list,
    getListCalls: () => listCalls,
    getDeleteCalls: () => deleteCalls,
    getRegisterOptionsCalls: () => registerOptionsCalls,
    getVerifyRegisterCalls: () => verifyRegisterCalls,
  };
}

test('PasskeysController.load: fetches passkeys and invokes onPasskeys callback', async () => {
  const initial: PasskeyView[] = [
    { id: 'p1', name: 'Passkey 1', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const { client } = createMockClient(initial);

  let emitted: readonly PasskeyView[] | null = null;
  const ctrl = new PasskeysController({
    client,
    callbacks: {
      onPasskeys: (items) => {
        emitted = items;
      },
      onPending: () => {},
      onError: () => {},
    },
  });

  await ctrl.load();

  assert.notEqual(emitted, null);
  assert.equal(emitted!.length, 1);
  assert.equal(emitted![0]!.id, 'p1');
  assert.equal(ctrl.currentPasskeys.length, 1);
});

test('PasskeysController.registerPasskey: runs ceremony, updates status, and performs authoritative reload', async () => {
  const { client, getVerifyRegisterCalls, getListCalls } = createMockClient([]);
  const adapter = new FakeWebAuthnAdapter();

  let pendingEvents: boolean[] = [];
  let emittedPasskeys: readonly PasskeyView[] = [];
  let statusMessage: string | null = null;

  const ctrl = new PasskeysController({
    client,
    webauthnAdapter: adapter,
    callbacks: {
      onPasskeys: (items) => {
        emittedPasskeys = items;
      },
      onPending: (pending) => {
        pendingEvents.push(pending);
      },
      onError: (msg) => {
        assert.fail(`Unexpected error: ${msg}`);
      },
      onStatus: (msg) => {
        statusMessage = msg;
      },
    },
  });

  await ctrl.registerPasskey();

  assert.deepEqual(pendingEvents, [true, false]);
  assert.equal(getVerifyRegisterCalls().length, 1);
  assert.equal(getVerifyRegisterCalls()[0]!.id, 'cred-new');
  assert.equal(statusMessage, 'Passkey registered successfully.');
  assert.equal(emittedPasskeys.length, 1);
  assert.equal(emittedPasskeys[0]!.id, 'cred-new');
  assert.equal(getListCalls(), 1);
});

test('PasskeysController.deletePasskey: deletes passkey, updates status, and performs authoritative reload', async () => {
  const initial: PasskeyView[] = [
    { id: 'p1', name: 'Passkey 1', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const { client, getDeleteCalls } = createMockClient(initial);

  let pendingEvents: boolean[] = [];
  let emittedPasskeys: readonly PasskeyView[] = initial;
  let statusMessage: string | null = null;

  const ctrl = new PasskeysController({
    client,
    callbacks: {
      onPasskeys: (items) => {
        emittedPasskeys = items;
      },
      onPending: (pending) => {
        pendingEvents.push(pending);
      },
      onError: (msg) => {
        assert.fail(`Unexpected error: ${msg}`);
      },
      onStatus: (msg) => {
        statusMessage = msg;
      },
    },
  });

  await ctrl.deletePasskey('p1');

  assert.deepEqual(pendingEvents, [true, false]);
  assert.deepEqual(getDeleteCalls(), ['p1']);
  assert.equal(statusMessage, 'Passkey deleted.');
  assert.equal(emittedPasskeys.length, 0);
});

test('an older mutation cannot clear pending while a newer mutation is still running', async () => {
  const registerOptions = deferred<WebAuthnRegisterOptions>();
  const deletion = deferred<void>();
  const client = {
    auth: {
      registerPasskeyOptions: async () => registerOptions.promise,
      deletePasskey: async () => deletion.promise,
      listPasskeys: async () => [],
    },
  } as unknown as GambitClient;
  const pendingEvents: boolean[] = [];
  const ctrl = new PasskeysController({
    client,
    webauthnAdapter: new FakeWebAuthnAdapter(),
    callbacks: {
      onPasskeys: () => {},
      onPending: (pending) => pendingEvents.push(pending),
      onError: (message) => assert.fail(`Unexpected error: ${message}`),
    },
  });

  const olderRegistration = ctrl.registerPasskey();
  const newerDeletion = ctrl.deletePasskey('p1');
  registerOptions.resolve({
    challenge: 'challenge',
    rp: { name: 'Gambit', id: 'localhost' },
    user: { id: 'u1', name: 'alice', displayName: 'alice' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60_000,
    attestation: 'none',
    authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
  });
  await olderRegistration;

  assert.deepEqual(pendingEvents, [true, true]);

  deletion.resolve();
  await newerDeletion;
  assert.deepEqual(pendingEvents, [true, true, false]);
});

test('PasskeysController: surfaces error when adapter is unsupported', async () => {
  const { client } = createMockClient([]);
  const adapter = new FakeWebAuthnAdapter();
  adapter.supported = false;

  let errorMessage: string | null = null;

  const ctrl = new PasskeysController({
    client,
    webauthnAdapter: adapter,
    callbacks: {
      onPasskeys: () => {},
      onPending: () => {},
      onError: (msg) => {
        errorMessage = msg;
      },
    },
  });

  await ctrl.registerPasskey();

  assert.equal(errorMessage, 'Passkeys are not supported in this browser.');
});

test('PasskeysController: suppresses callbacks after disposal', async () => {
  const pending = deferred<PasskeyView[]>();
  let listCalls = 0;
  const mockClient = {
    auth: {
      listPasskeys: async () => {
        listCalls++;
        return pending.promise;
      },
    },
  } as unknown as GambitClient;

  let callbackFired = false;
  const ctrl = new PasskeysController({
    client: mockClient,
    callbacks: {
      onPasskeys: () => {
        callbackFired = true;
      },
      onPending: () => {},
      onError: () => {},
    },
  });

  const loadPromise = ctrl.load();
  ctrl.dispose();
  pending.resolve([{ id: 'p1', name: 'Passkey 1', createdAt: '2026-01-01T00:00:00Z' }]);
  await loadPromise;

  assert.equal(listCalls, 1);
  assert.equal(callbackFired, false);
});

test('PasskeysController: reset clears state and invalidates pending loads', async () => {
  const pending = deferred<PasskeyView[]>();
  let listCalls = 0;
  const mockClient = {
    auth: {
      listPasskeys: async () => {
        listCalls++;
        return pending.promise;
      },
    },
  } as unknown as GambitClient;

  let callbackFired = false;
  const ctrl = new PasskeysController({
    client: mockClient,
    callbacks: {
      onPasskeys: () => {
        callbackFired = true;
      },
      onPending: () => {},
      onError: () => {},
    },
  });

  const loadPromise = ctrl.load();
  ctrl.reset();
  pending.resolve([{ id: 'p1', name: 'Passkey 1', createdAt: '2026-01-01T00:00:00Z' }]);
  await loadPromise;

  assert.equal(listCalls, 1);
  assert.equal(callbackFired, false);
  assert.equal(ctrl.currentPasskeys.length, 0);
});

test('PasskeysController: suppresses out-of-order stale loads', async () => {
  const older = deferred<PasskeyView[]>();
  const newer = deferred<PasskeyView[]>();
  let callCount = 0;
  const mockClient = {
    auth: {
      listPasskeys: async () => {
        callCount++;
        return callCount === 1 ? older.promise : newer.promise;
      },
    },
  } as unknown as GambitClient;

  const emitted: string[][] = [];
  const ctrl = new PasskeysController({
    client: mockClient,
    callbacks: {
      onPasskeys: (items) => {
        emitted.push(items.map((item) => item.id));
      },
      onPending: () => {},
      onError: () => {},
    },
  });

  const olderLoad = ctrl.load();
  const newerLoad = ctrl.load();
  newer.resolve([{ id: 'newer', name: 'Newer', createdAt: '2026-01-01T00:00:00Z' }]);
  await newerLoad;
  older.resolve([{ id: 'older', name: 'Older', createdAt: '2026-01-01T00:00:00Z' }]);
  await olderLoad;

  assert.deepEqual(emitted, [['newer']]);
  assert.equal(ctrl.currentPasskeys[0]?.id, 'newer');
});
