import * as crypto from 'node:crypto';
import { decodeFirst } from './cbor';

export class WebAuthnError extends Error {
  constructor(message: string) {
    super(`WebAuthn Error: ${message}`);
    this.name = 'WebAuthnError';
  }
}

export interface ParsedAuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Buffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function validateExtensionData(extensionData: Buffer): void {
  if (extensionData.length === 0) {
    throw new WebAuthnError('Extensions flag is set but extension data is missing');
  }

  let decoded;
  try {
    decoded = decodeFirst(extensionData);
  } catch (error: unknown) {
    throw new WebAuthnError(`Failed to decode authenticator extensions: ${errorMessage(error)}`);
  }

  if (!(decoded.value instanceof Map)) {
    throw new WebAuthnError('Authenticator extensions are not a CBOR map');
  }
  if (decoded.offset !== extensionData.length) {
    throw new WebAuthnError('Trailing bytes in authenticator extensions');
  }
}

export function parseAuthenticatorData(authData: Buffer): ParsedAuthenticatorData {
  if (authData.length < 37) {
    throw new WebAuthnError('Authenticator data is too short');
  }

  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32]!;
  const signCount = authData.readUInt32BE(33);

  const hasAttestedCredentialData = (flags & 0x40) !== 0;
  const hasExtensions = (flags & 0x80) !== 0;

  if (!hasAttestedCredentialData) {
    const extensionData = authData.subarray(37);
    if (hasExtensions) {
      validateExtensionData(extensionData);
    } else if (extensionData.length > 0) {
      throw new WebAuthnError('Unexpected trailing bytes without extensions flag');
    }
    return { rpIdHash, flags, signCount };
  }

  if (authData.length < 55) {
    throw new WebAuthnError('Attested credential data is missing or truncated');
  }

  const credentialIdLength = authData.readUInt16BE(53);
  if (authData.length < 55 + credentialIdLength) {
    throw new WebAuthnError('Credential ID is truncated');
  }

  const credentialId = authData.subarray(55, 55 + credentialIdLength);
  const coseKeyAndExtensions = authData.subarray(55 + credentialIdLength);

  let decoded;
  try {
    decoded = decodeFirst(coseKeyAndExtensions);
  } catch (error: unknown) {
    throw new WebAuthnError(`Failed to decode COSE key: ${errorMessage(error)}`);
  }

  if (!(decoded.value instanceof Map)) {
    throw new WebAuthnError('COSE key is not a CBOR map');
  }

  const publicKeyBytes = coseKeyAndExtensions.subarray(0, decoded.offset);
  const extensionData = coseKeyAndExtensions.subarray(decoded.offset);

  if (hasExtensions) {
    validateExtensionData(extensionData);
  } else if (extensionData.length > 0) {
    throw new WebAuthnError('Unexpected trailing bytes without extensions flag');
  }

  return { rpIdHash, flags, signCount, credentialId, publicKey: publicKeyBytes };
}

/**
 * Extracts an ES256 public key from a COSE CBOR map and returns a node:crypto KeyObject.
 * Explicitly rejects any other kty, alg, or crv.
 */
export function extractPublicKey(cosePublicKey: Buffer): crypto.KeyObject {
  let map;
  try {
    const decoded = decodeFirst(cosePublicKey);
    if (decoded.offset !== cosePublicKey.length) {
      throw new WebAuthnError('Trailing bytes in COSE key');
    }
    if (!(decoded.value instanceof Map)) {
      throw new WebAuthnError('COSE key is not a CBOR map');
    }
    map = decoded.value;
  } catch (error: unknown) {
    if (error instanceof WebAuthnError) throw error;
    throw new WebAuthnError(`Failed to decode COSE key: ${errorMessage(error)}`);
  }

  const kty = map.get(1);
  const alg = map.get(3);
  const crv = map.get(-1);
  const x = map.get(-2);
  const y = map.get(-3);

  // Enforce ES256 only
  // kty: 2 (EC2)
  // alg: -7 (ES256)
  // crv: 1 (P-256)
  if (kty !== 2) throw new WebAuthnError(`Unsupported key type (kty): ${kty}`);
  if (alg !== -7) throw new WebAuthnError(`Unsupported algorithm (alg): ${alg}`);
  if (crv !== 1) throw new WebAuthnError(`Unsupported curve (crv): ${crv}`);

  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    throw new WebAuthnError('Missing or invalid x/y coordinates in COSE key');
  }

  return crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: x.toString('base64url'),
      y: y.toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Verifies a WebAuthn signature over authenticatorData || SHA-256(clientDataJSON).
 * WebAuthn signatures are DER-encoded ECDSA, which node:crypto accepts natively.
 */
export function verifyWebAuthnSignature(
  publicKey: crypto.KeyObject,
  authenticatorData: Buffer,
  clientDataJSON: Buffer,
  signature: Buffer
): boolean {
  const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
  const signedData = Buffer.concat([authenticatorData, clientDataHash]);

  const verify = crypto.createVerify('SHA256');
  verify.update(signedData);
  verify.end();

  return verify.verify(publicKey, signature);
}
