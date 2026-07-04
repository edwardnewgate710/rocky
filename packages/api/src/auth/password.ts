/**
 * @packageDocumentation
 * Password hashing behind a provider-agnostic {@link PasswordHasher} abstraction.
 * The default {@link ScryptPasswordHasher} uses Node's built-in `scrypt`
 * (memory-hard, no third-party dependency). Deployments that prefer argon2id or
 * a managed KMS can implement {@link PasswordHasher} and inject it via
 * `createApiServer` without touching any service code — the stored `secret_hash`
 * column is an opaque, self-describing string.
 *
 * Encoded format (self-describing so parameters can evolve safely):
 *   `scrypt$N=<cost>,r=<block>,p=<par>$<saltB64>$<hashB64>`
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Verify (and, when needed, produce) password hashes. */
export interface PasswordHasher {
  /** Produce an opaque, self-describing encoded hash for storage. */
  hash(password: string): Promise<string>;
  /**
   * Constant-time verify a plaintext password against a stored encoded hash.
   * Returns false (never throws) for an unrecognized or malformed encoding.
   */
  verify(password: string, encoded: string): Promise<boolean>;
}

/** Tunable scrypt parameters. Defaults follow current OWASP guidance. */
export interface ScryptParams {
  /** CPU/memory cost (must be a power of two). */
  readonly N: number;
  /** Block size. */
  readonly r: number;
  /** Parallelization. */
  readonly p: number;
  /** Derived key length in bytes. */
  readonly keylen: number;
  /** Salt length in bytes. */
  readonly saltBytes: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 16_384,
  r: 8,
  p: 1,
  keylen: 32,
  saltBytes: 16,
};

/** Node-`crypto` scrypt implementation of {@link PasswordHasher}. */
export class ScryptPasswordHasher implements PasswordHasher {
  private readonly params: ScryptParams;

  constructor(params: Partial<ScryptParams> = {}) {
    this.params = { ...DEFAULT_SCRYPT_PARAMS, ...params };
  }

  async hash(password: string): Promise<string> {
    assertPassword(password);
    const { N, r, p, keylen, saltBytes } = this.params;
    const salt = randomBytes(saltBytes);
    const derived = await scrypt(password, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
    return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parseEncoded(encoded);
    if (!parsed) return false;
    const { N, r, p, salt, hash } = parsed;
    let derived: Buffer;
    try {
      derived = await scrypt(password, salt, hash.length, { N, r, p, maxmem: maxmemFor(N, r) });
    } catch {
      return false;
    }
    return derived.length === hash.length && timingSafeEqual(derived, hash);
  }
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  if (password.length > 1024) {
    throw new Error('password must be at most 1024 characters');
  }
}

function maxmemFor(N: number, r: number): number {
  // scrypt needs ~128*N*r bytes; give generous headroom so large N never throws.
  return Math.max(64 * 1024 * 1024, 256 * N * r);
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseEncoded(encoded: string): ParsedHash | null {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const params = parseParams(parts[1]!);
  if (!params) return null;
  try {
    const salt = Buffer.from(parts[2]!, 'base64');
    const hash = Buffer.from(parts[3]!, 'base64');
    if (salt.length === 0 || hash.length === 0) return null;
    return { ...params, salt, hash };
  } catch {
    return null;
  }
}

function parseParams(spec: string): { N: number; r: number; p: number } | null {
  const map: Record<string, number> = {};
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=');
    if (!k || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    map[k] = n;
  }
  if (map['N'] === undefined || map['r'] === undefined || map['p'] === undefined) return null;
  return { N: map['N'], r: map['r'], p: map['p'] };
}
