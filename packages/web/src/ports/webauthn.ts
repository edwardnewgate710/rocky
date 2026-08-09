/**
 * WebAuthn / Passkeys port and browser adapter.
 *
 * Wraps native browser WebAuthn L3 JSON APIs (`PublicKeyCredential.parseCreationOptionsFromJSON`,
 * `navigator.credentials.create`, `PublicKeyCredential.parseRequestOptionsFromJSON`,
 * `navigator.credentials.get`, and `credential.toJSON`).
 */
import type {
  WebAuthnRegisterOptions,
  WebAuthnRegisterVerifyRequest,
  WebAuthnLoginOptions,
  WebAuthnLoginVerifyRequest,
} from '../api/models.js';

export interface WebAuthnAdapter {
  isSupported(): boolean;
  createCredential(options: WebAuthnRegisterOptions): Promise<WebAuthnRegisterVerifyRequest>;
  getCredential(options: WebAuthnLoginOptions): Promise<WebAuthnLoginVerifyRequest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isObjectOrFunction(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function hasParseCreationOptions(
  pkc: unknown,
): pkc is { parseCreationOptionsFromJSON: (options: unknown) => PublicKeyCredentialCreationOptions } {
  return isObjectOrFunction(pkc) && typeof pkc.parseCreationOptionsFromJSON === 'function';
}

function hasParseRequestOptions(
  pkc: unknown,
): pkc is { parseRequestOptionsFromJSON: (options: unknown) => PublicKeyCredentialRequestOptions } {
  return isObjectOrFunction(pkc) && typeof pkc.parseRequestOptionsFromJSON === 'function';
}

function hasToJson(
  cred: unknown,
): cred is { toJSON: () => Record<string, unknown> } {
  return isRecord(cred) && typeof cred.toJSON === 'function';
}

export class NativeWebAuthnAdapter implements WebAuthnAdapter {
  isSupported(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (window.isSecureContext === false) return false;
    if (!navigator.credentials || typeof navigator.credentials.create !== 'function' || typeof navigator.credentials.get !== 'function') {
      return false;
    }
    if (typeof PublicKeyCredential === 'undefined') return false;
    return hasParseCreationOptions(PublicKeyCredential) && hasParseRequestOptions(PublicKeyCredential);
  }

  async createCredential(options: WebAuthnRegisterOptions): Promise<WebAuthnRegisterVerifyRequest> {
    if (!this.isSupported()) {
      throw new Error('Passkeys are not supported in this browser.');
    }
    if (typeof PublicKeyCredential === 'undefined' || !hasParseCreationOptions(PublicKeyCredential)) {
      throw new Error('PublicKeyCredential.parseCreationOptionsFromJSON is not available.');
    }

    const parsedOptions = PublicKeyCredential.parseCreationOptionsFromJSON(options);
    const credential = await navigator.credentials.create({ publicKey: parsedOptions });

    if (!credential) {
      throw new Error('Passkey registration returned null.');
    }

    if (!hasToJson(credential)) {
      throw new Error('Credential.toJSON is not supported in this browser.');
    }

    const json = credential.toJSON();
    if (
      !isRecord(json) ||
      typeof json.id !== 'string' ||
      typeof json.rawId !== 'string' ||
      json.type !== 'public-key' ||
      !isRecord(json.response) ||
      typeof json.response.clientDataJSON !== 'string' ||
      typeof json.response.attestationObject !== 'string'
    ) {
      throw new Error('Invalid credential JSON response.');
    }

    return json as unknown as WebAuthnRegisterVerifyRequest;
  }

  async getCredential(options: WebAuthnLoginOptions): Promise<WebAuthnLoginVerifyRequest> {
    if (!this.isSupported()) {
      throw new Error('Passkeys are not supported in this browser.');
    }
    if (typeof PublicKeyCredential === 'undefined' || !hasParseRequestOptions(PublicKeyCredential)) {
      throw new Error('PublicKeyCredential.parseRequestOptionsFromJSON is not available.');
    }

    const parsedOptions = PublicKeyCredential.parseRequestOptionsFromJSON(options);
    const credential = await navigator.credentials.get({ publicKey: parsedOptions });

    if (!credential) {
      throw new Error('Passkey authentication returned null.');
    }

    if (!hasToJson(credential)) {
      throw new Error('Credential.toJSON is not supported in this browser.');
    }

    const json = credential.toJSON();
    const userHandle = isRecord(json.response) ? json.response.userHandle : undefined;
    if (
      !isRecord(json) ||
      typeof json.id !== 'string' ||
      typeof json.rawId !== 'string' ||
      json.type !== 'public-key' ||
      !isRecord(json.response) ||
      typeof json.response.clientDataJSON !== 'string' ||
      typeof json.response.authenticatorData !== 'string' ||
      typeof json.response.signature !== 'string' ||
      (userHandle !== undefined && userHandle !== null && typeof userHandle !== 'string')
    ) {
      throw new Error('Invalid credential JSON assertion.');
    }

    if (userHandle === null) delete json.response.userHandle;
    return json as unknown as WebAuthnLoginVerifyRequest;
  }
}
