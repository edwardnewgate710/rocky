/**
 * @packageDocumentation
 * Stateless access tokens signed with HMAC-SHA256 (a compact JWS/`HS256`
 * structure) and helpers for opaque refresh tokens. Access tokens are
 * self-contained — the router verifies them with no database round-trip — so the
 * API scales horizontally. Refresh tokens are opaque random strings; only their
 * SHA-256 hash is ever stored (see {@link ../auth/refresh}).
 *
 * We implement the HS256 envelope directly on `node:crypto` rather than pulling
 * in a JWT library: the surface we need (sign, constant-time verify, `exp`) is
 * small and security-sensitive, and the minimal-dependency philosophy keeps the
 * audited attack surface tiny.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from '@chess-platform/persistence';
import type { Identity } from '../http/context';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';

/** Claims embedded in an access token. Times are Unix seconds. */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  readonly sub: string;
  readonly handle: string;
  readonly roles: readonly Role[];
  readonly iat: number;
  readonly exp: number;
  /** Token id (jti) for correlation/audit. */
  readonly jti: string;
}

/** Why a token failed verification. */
export type TokenFailure = 'malformed' | 'bad_signature' | 'expired' | 'unsupported_alg';

/** Result of {@link AccessTokenService.verify}. */
export type VerifyResult =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: TokenFailure };

const HEADER = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

/** Issues and verifies HMAC-SHA256 access tokens. */
export class AccessTokenService {
  private readonly secret: Buffer;
  private readonly ttlSec: number;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(opts: {
    secret: string | Buffer;
    ttlSec: number;
    clock: Clock;
    ids: IdGenerator;
  }) {
    const secret = typeof opts.secret === 'string' ? Buffer.from(opts.secret, 'utf8') : opts.secret;
    if (secret.length < 32) {
      throw new Error('access token secret must be at least 32 bytes');
    }
    if (!Number.isInteger(opts.ttlSec) || opts.ttlSec <= 0) {
      throw new Error('access token ttlSec must be a positive integer');
    }
    this.secret = secret;
    this.ttlSec = opts.ttlSec;
    this.clock = opts.clock;
    this.ids = opts.ids;
  }

  /** Sign a token for a principal. Returns the compact token and its claims. */
  issue(principal: {
    userId: string;
    handle: string;
    roles: readonly Role[];
  }): { token: string; claims: AccessTokenClaims } {
    const iat = Math.floor(this.clock.now() / 1000);
    const claims: AccessTokenClaims = {
      sub: principal.userId,
      handle: principal.handle,
      roles: [...principal.roles],
      iat,
      exp: iat + this.ttlSec,
      jti: this.ids.next(),
    };
    const payload = base64url(Buffer.from(JSON.stringify(claims)));
    const signingInput = `${HEADER}.${payload}`;
    const sig = this.sign(signingInput);
    return { token: `${signingInput}.${sig}`, claims };
  }

  /** Verify a compact token: structure, HS256 signature, and expiry. */
  verify(token: string): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [header, payload, sig] = parts as [string, string, string];
    if (header !== HEADER) return { ok: false, reason: 'unsupported_alg' };

    const expected = this.sign(`${header}.${payload}`);
    if (!constantTimeEquals(sig, expected)) return { ok: false, reason: 'bad_signature' };

    let claims: AccessTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessTokenClaims;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!validClaims(claims)) return { ok: false, reason: 'malformed' };

    const nowSec = Math.floor(this.clock.now() / 1000);
    if (nowSec >= claims.exp) return { ok: false, reason: 'expired' };

    return { ok: true, claims };
  }

  /** Verify and project into an {@link Identity}, or null when invalid. */
  identify(token: string): Identity | null {
    const result = this.verify(token);
    if (!result.ok) return null;
    const { sub, handle, roles, jti } = result.claims;
    return { userId: sub, handle, roles, tokenId: jti };
  }

  private sign(input: string): string {
    return base64url(createHmac('sha256', this.secret).update(input).digest());
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function validClaims(c: unknown): c is AccessTokenClaims {
  if (typeof c !== 'object' || c === null) return false;
  const r = c as Record<string, unknown>;
  return (
    typeof r['sub'] === 'string' &&
    typeof r['handle'] === 'string' &&
    Array.isArray(r['roles']) &&
    r['roles'].every((x) => typeof x === 'string') &&
    typeof r['iat'] === 'number' &&
    typeof r['exp'] === 'number' &&
    typeof r['jti'] === 'string'
  );
}
