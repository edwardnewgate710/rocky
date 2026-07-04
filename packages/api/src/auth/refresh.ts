/**
 * @packageDocumentation
 * Opaque refresh tokens. A refresh token is high-entropy random data given to
 * the client; the server persists only its SHA-256 hash (so a database leak
 * cannot be replayed). Tokens are single-use: each refresh rotates to a new
 * token and revokes the presenting session. Presenting an already-rotated token
 * signals theft and triggers chain revocation (handled in the auth service).
 */

import { createHash, randomBytes } from 'node:crypto';

/** Entropy of a refresh token in bytes (256 bits). */
export const REFRESH_TOKEN_BYTES = 32;

/** Generate a new opaque refresh token (URL-safe base64, no padding). */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * Hash a refresh token for storage/lookup. SHA-256 is appropriate here (unlike
 * passwords) because the input is already high-entropy random data, so there is
 * nothing to brute-force.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64');
}
