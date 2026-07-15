/**
 * @packageDocumentation
 * Dependency-free cookie helpers for the refresh-token httpOnly cookie.
 *
 * Two operations:
 *  - {@link parseCookies} — parse an incoming `Cookie` request header into a
 *    simple name→value map.
 *  - {@link buildRefreshCookie} / {@link clearRefreshCookie} — build `Set-Cookie`
 *    response header values with the security attributes required by ADR-0012.
 *
 * Node built-ins only; no new npm dependencies.
 *
 * @see docs/adr/0012-httponly-refresh-cookie.md
 */

/** Cookie attributes shared by set and clear operations. */
export interface RefreshCookieOptions {
  /** Emit the `Secure` attribute. Default `true`; set `false` for local/dev over HTTP. */
  readonly secure: boolean;
}

/** Name of the refresh-token cookie. */
export const REFRESH_COOKIE_NAME = 'gambit_refresh';

/** Path scope for the refresh-token cookie — auth routes only (CSRF surface reduction). */
export const REFRESH_COOKIE_PATH = '/v1/auth';

/**
 * Parse a `Cookie` request header into a name→value map.
 *
 * Handles the standard `name=value; name2=value2` format. Whitespace around
 * names and values is trimmed. If the header is absent or empty, returns an
 * empty record. Duplicate names keep the **first** occurrence (browser
 * behavior for identical paths).
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue; // ignore bare names without values
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(name in result)) result[name] = value;
  }
  return result;
}

/**
 * Build a `Set-Cookie` header value that stores the refresh token.
 *
 * Attributes (per ADR-0012):
 *  - `HttpOnly` — not readable by JavaScript (XSS mitigation).
 *  - `SameSite=Strict` — not sent on cross-site requests (CSRF mitigation).
 *  - `Path=/v1/auth` — scoped to auth routes only (reduces CSRF surface).
 *  - `Max-Age=<ttl>` — matches the refresh-token lifetime.
 *  - `Secure` — only sent over HTTPS (configurable for local/dev).
 */
export function buildRefreshCookie(
  token: string,
  ttlSec: number,
  opts: RefreshCookieOptions,
): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${REFRESH_COOKIE_PATH}`,
    `Max-Age=${ttlSec}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build a `Set-Cookie` header value that **clears** the refresh cookie.
 *
 * Uses the same name, path, and attributes as {@link buildRefreshCookie} but
 * sets `Max-Age=0` and an empty value so the browser discards it immediately.
 */
export function clearRefreshCookie(opts: RefreshCookieOptions): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${REFRESH_COOKIE_PATH}`,
    'Max-Age=0',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
