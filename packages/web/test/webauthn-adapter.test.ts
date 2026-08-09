/**
 * Tests for NativeWebAuthnAdapter.
 *
 * Verifies native creation/request JSON parsing and credential JSON serialization
 * calls, null credential handling, and unsupported browser detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWebAuthnAdapter } from '../src/ports/webauthn.js';
import type { WebAuthnRegisterOptions, WebAuthnLoginOptions } from '../src/api/models.js';

const REGISTER_OPTIONS: WebAuthnRegisterOptions = {
  challenge: 'ch123',
  rp: { name: 'Gambit', id: 'localhost' },
  user: { id: 'u1', name: 'alice', displayName: 'alice' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 60_000,
  attestation: 'none',
  authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
};

const LOGIN_OPTIONS: WebAuthnLoginOptions = {
  challenge: 'ch456',
  timeout: 60_000,
  rpId: 'localhost',
  userVerification: 'required',
};

async function withGlobals(globals: Record<string, unknown>, fn: () => Promise<void> | void): Promise<void> {
  const originalDescriptors: Record<string, PropertyDescriptor | undefined> = {};
  for (const key of Object.keys(globals)) {
    originalDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value: globals[key],
      configurable: true,
      writable: true,
    });
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(globals)) {
      const desc = originalDescriptors[key];
      if (desc) {
        Object.defineProperty(globalThis, key, desc);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

test('NativeWebAuthnAdapter.isSupported: returns false in Node environment without globals', () => {
  const adapter = new NativeWebAuthnAdapter();
  assert.equal(adapter.isSupported(), false);
});

test('NativeWebAuthnAdapter.isSupported: returns false outside a secure context', async () => {
  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON() { return {}; }
    static parseRequestOptionsFromJSON() { return {}; }
  }

  await withGlobals(
    {
      window: { isSecureContext: false },
      PublicKeyCredential: FakePublicKeyCredential,
      navigator: {
        credentials: {
          create: async () => null,
          get: async () => null,
        },
      },
    },
    () => {
      assert.equal(new NativeWebAuthnAdapter().isSupported(), false);
    },
  );
});

test('NativeWebAuthnAdapter.createCredential: invokes parseCreationOptionsFromJSON, credentials.create, and credential.toJSON', async () => {
  let parseOptionsCalledWith: unknown = null;
  let credentialsCreateCalledWith: unknown = null;
  let toJSONCalled = false;

  const mockParsedOptions = { challenge: new Uint8Array([1, 2, 3]) };
  const mockCredentialJSON = {
    id: 'cred-123',
    rawId: 'cred-123',
    type: 'public-key',
    response: {
      clientDataJSON: 'clientData',
      attestationObject: 'attestation',
    },
  };

  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON(options: unknown) {
      parseOptionsCalledWith = options;
      return mockParsedOptions;
    }
    static parseRequestOptionsFromJSON() {
      return {};
    }
  }

  const fakeNavigator = {
    credentials: {
      create: async (options: unknown) => {
        credentialsCreateCalledWith = options;
        return {
          toJSON: () => {
            toJSONCalled = true;
            return mockCredentialJSON;
          },
        };
      },
      get: async () => null,
    },
  };

  await withGlobals(
    {
      window: {},
      PublicKeyCredential: FakePublicKeyCredential,
      navigator: fakeNavigator,
    },
    async () => {
      const adapter = new NativeWebAuthnAdapter();
      assert.equal(adapter.isSupported(), true);

      const res = await adapter.createCredential(REGISTER_OPTIONS);

      assert.equal(parseOptionsCalledWith, REGISTER_OPTIONS);
      assert.deepEqual(credentialsCreateCalledWith, { publicKey: mockParsedOptions });
      assert.equal(toJSONCalled, true);
      assert.equal(res.id, 'cred-123');
    },
  );
});

test('NativeWebAuthnAdapter.getCredential: invokes parseRequestOptionsFromJSON, credentials.get, and credential.toJSON', async () => {
  let parseOptionsCalledWith: unknown = null;
  let credentialsGetCalledWith: unknown = null;
  let toJSONCalled = false;

  const mockParsedOptions = { challenge: new Uint8Array([4, 5, 6]) };
  const mockCredentialJSON = {
    id: 'cred-123',
    rawId: 'cred-123',
    type: 'public-key',
    response: {
      clientDataJSON: 'clientData',
      authenticatorData: 'authData',
      signature: 'sig',
      userHandle: 'u1',
    },
  };

  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON() {
      return {};
    }
    static parseRequestOptionsFromJSON(options: unknown) {
      parseOptionsCalledWith = options;
      return mockParsedOptions;
    }
  }

  const fakeNavigator = {
    credentials: {
      create: async () => null,
      get: async (options: unknown) => {
        credentialsGetCalledWith = options;
        return {
          toJSON: () => {
            toJSONCalled = true;
            return mockCredentialJSON;
          },
        };
      },
    },
  };

  await withGlobals(
    {
      window: {},
      PublicKeyCredential: FakePublicKeyCredential,
      navigator: fakeNavigator,
    },
    async () => {
      const adapter = new NativeWebAuthnAdapter();
      assert.equal(adapter.isSupported(), true);

      const res = await adapter.getCredential(LOGIN_OPTIONS);

      assert.equal(parseOptionsCalledWith, LOGIN_OPTIONS);
      assert.deepEqual(credentialsGetCalledWith, { publicKey: mockParsedOptions });
      assert.equal(toJSONCalled, true);
      assert.equal(res.id, 'cred-123');
    },
  );
});

test('NativeWebAuthnAdapter.getCredential: accepts a null user handle and omits it from the API request', async () => {
  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON() { return {}; }
    static parseRequestOptionsFromJSON() { return {}; }
  }

  const fakeNavigator = {
    credentials: {
      create: async () => null,
      get: async () => ({
        toJSON: () => ({
          id: 'cred-123',
          rawId: 'cred-123',
          type: 'public-key',
          response: {
            clientDataJSON: 'clientData',
            authenticatorData: 'authData',
            signature: 'sig',
            userHandle: null,
          },
        }),
      }),
    },
  };

  await withGlobals(
    {
      window: {},
      PublicKeyCredential: FakePublicKeyCredential,
      navigator: fakeNavigator,
    },
    async () => {
      const response = await new NativeWebAuthnAdapter().getCredential(LOGIN_OPTIONS);
      assert.equal(response.response.userHandle, undefined);
      assert.equal(Object.hasOwn(response.response, 'userHandle'), false);
    },
  );
});

test('NativeWebAuthnAdapter: handles null credential from create or get', async () => {
  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON() { return {}; }
    static parseRequestOptionsFromJSON() { return {}; }
  }

  const fakeNavigator = {
    credentials: {
      create: async () => null,
      get: async () => null,
    },
  };

  await withGlobals(
    {
      window: {},
      PublicKeyCredential: FakePublicKeyCredential,
      navigator: fakeNavigator,
    },
    async () => {
      const adapter = new NativeWebAuthnAdapter();

      await assert.rejects(
        async () => adapter.createCredential(REGISTER_OPTIONS),
        /Passkey registration returned null/,
      );

      await assert.rejects(
        async () => adapter.getCredential(LOGIN_OPTIONS),
        /Passkey authentication returned null/,
      );
    },
  );
});

test('NativeWebAuthnAdapter: throws unsupported error when browser APIs missing', async () => {
  const adapter = new NativeWebAuthnAdapter();

  await assert.rejects(
    async () => adapter.createCredential(REGISTER_OPTIONS),
    /Passkeys are not supported in this browser/,
  );

  await assert.rejects(
    async () => adapter.getCredential(LOGIN_OPTIONS),
    /Passkeys are not supported in this browser/,
  );
});

test('NativeWebAuthnAdapter: rejects malformed credential JSON before it reaches the API', async () => {
  let credentialJson: Record<string, unknown> = {
    id: 'credential-1',
    rawId: 'credential-1',
    type: 'public-key',
    response: { clientDataJSON: 'client-data' },
  };

  class FakePublicKeyCredential {
    static parseCreationOptionsFromJSON() { return {}; }
    static parseRequestOptionsFromJSON() { return {}; }
  }

  const fakeNavigator = {
    credentials: {
      create: async () => ({ toJSON: () => credentialJson }),
      get: async () => ({ toJSON: () => credentialJson }),
    },
  };

  await withGlobals(
    {
      window: {},
      PublicKeyCredential: FakePublicKeyCredential,
      navigator: fakeNavigator,
    },
    async () => {
      const adapter = new NativeWebAuthnAdapter();
      await assert.rejects(
        async () => adapter.createCredential(REGISTER_OPTIONS),
        /Invalid credential JSON response/,
      );

      credentialJson = {
        id: 'credential-1',
        rawId: 'credential-1',
        type: 'public-key',
        response: {
          clientDataJSON: 'client-data',
          authenticatorData: 'authenticator-data',
          signature: 'signature',
          userHandle: 42,
        },
      };
      await assert.rejects(
        async () => adapter.getCredential(LOGIN_OPTIONS),
        /Invalid credential JSON assertion/,
      );
    },
  );
});
