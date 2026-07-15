/**
 * @packageDocumentation
 * Security middleware for the Gambit API. Wraps any Node `http`
 * {@link RequestListener} and adds:
 *
 * 1. **Security response headers** on every response (200, 204, 4xx, 5xx):
 *    `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
 *    `Content-Security-Policy` (frame-ancestors), `Cross-Origin-Resource-Policy`,
 *    and optionally `Strict-Transport-Security`.
 *
 * 2. **CORS policy** — a config-driven origin allowlist with credentials support
 *    and proper `OPTIONS` preflight short-circuit. Details in {@link CorsConfig}.
 *
 * Design constraints:
 * - Zero new npm dependencies (Node built-ins only).
 * - Strict TypeScript; no `any`, no non-null abuse.
 * - Handlers never see `OPTIONS` preflight requests (short-circuited here).
 * - Security headers are applied *before* the inner listener writes its status,
 *   so they appear on every response including 404/405/500 from the router.
 *
 * @see docs/adr/0011-cors-security-headers.md
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * CORS configuration.
 *
 * Safe default: `allowedOrigins: []` (no cross-origin access — no ACAO header
 * is ever emitted). Set `allowedOrigins` explicitly in each deployment env.
 *
 * `allowCredentials` must be `false` when `allowedOrigins` is empty or `['*']`.
 * When `true`, each allowed origin is reflected verbatim (never `*`) to stay
 * forward-compatible with `httpOnly` refresh-token cookies (planned M12 inc 2).
 */
export interface CorsConfig {
  /**
   * Exact origins permitted to make cross-origin requests, e.g.
   * `["https://gambit.example.com"]`. Empty array = deny all cross-origin
   * requests (no ACAO header emitted).
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Whether to include `Access-Control-Allow-Credentials: true`.
   * Must be `false` (or omitted) when credentials are not required.
   */
  readonly allowCredentials: boolean;
}

/**
 * Security-header configuration.
 */
export interface SecurityConfig {
  /** CORS policy. */
  readonly cors: CorsConfig;
  /**
   * Emit `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
   * TLS is terminated at the proxy; HSTS is a no-op over plain HTTP but
   * harmless in production. Disable in local/dev environments. Default: `true`.
   */
  readonly enableHsts: boolean;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Headers that are always set on every response. */
const FIXED_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Frame-Options', 'DENY'],
  // JSON API only — no HTML frames. `frame-ancestors` supersedes X-Frame-Options
  // for browsers that support CSP Level 2.
  ['Content-Security-Policy', "frame-ancestors 'none'"],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];

const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * Methods and headers advertised in CORS preflight responses.
 * `Authorization` is required for bearer-token auth;
 * `Content-Type` is needed for JSON request bodies.
 */
const PREFLIGHT_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const PREFLIGHT_ALLOW_HEADERS = 'Authorization, Content-Type, X-Request-Id';
const PREFLIGHT_MAX_AGE = '600'; // seconds browsers may cache the preflight

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Apply the fixed security headers (and optionally HSTS) to `res`. Must be
 * called before the inner listener, because `writeHead` flushes headers.
 */
function applySecurityHeaders(res: ServerResponse, enableHsts: boolean): void {
  for (const [name, value] of FIXED_HEADERS) {
    res.setHeader(name, value);
  }
  if (enableHsts) {
    res.setHeader('Strict-Transport-Security', HSTS_VALUE);
  }
  // Remove server fingerprinting header added by Node's `http` module.
  res.removeHeader('Server');
}

/**
 * Return the single `Origin` header value, or `undefined` when absent or
 * multi-valued (multi-valued Origin is invalid per RFC 6454 — treat as absent).
 */
function requestOrigin(req: IncomingMessage): string | undefined {
  const raw = req.headers['origin'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return undefined; // malformed; ignore
  return raw;
}

/**
 * Apply CORS response headers for an allowed origin. Called for both actual
 * requests and preflights after the origin has been validated.
 */
function applyCorsHeaders(
  res: ServerResponse,
  origin: string,
  cors: CorsConfig,
): void {
  // Reflect the exact origin (never `*`) to stay credentials-compatible.
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (cors.allowCredentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // `Vary: Origin` is mandatory whenever we conditionally reflect the origin,
  // so caches (CDN, browser) do not serve a response with one origin's ACAO
  // header to a request from a different origin.
  res.setHeader('Vary', 'Origin');
}

/**
 * Return `true` when `origin` is in the allowlist.
 */
function isAllowedOrigin(origin: string, cors: CorsConfig): boolean {
  return cors.allowedOrigins.includes(origin);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wrap `inner` with security response headers and CORS enforcement.
 *
 * Behaviour summary:
 * - Security headers are added to **every** response before the inner listener
 *   is called.
 * - `OPTIONS` preflight from an allowed origin → 204, no inner listener called.
 * - `OPTIONS` preflight from a disallowed origin → 204, **no** CORS headers.
 * - Actual request from an allowed origin → ACAO/ACAC/Vary added.
 * - Actual request from a disallowed or absent origin → no CORS headers.
 *
 * @example
 * ```ts
 * const handler = withSecurity(router.toListener(runtime), {
 *   cors: { allowedOrigins: ['https://app.example.com'], allowCredentials: true },
 *   enableHsts: true,
 * });
 * createServer(handler).listen(port);
 * ```
 */
export function withSecurity(inner: RequestListener, config: SecurityConfig): RequestListener {
  const { cors, enableHsts } = config;

  return (req: IncomingMessage, res: ServerResponse): void => {
    // 1. Apply security headers unconditionally.
    applySecurityHeaders(res, enableHsts);

    // 2. Resolve the request origin (may be absent for same-origin requests).
    const origin = requestOrigin(req);
    const allowed = origin !== undefined && isAllowedOrigin(origin, cors);

    // 3. Apply CORS headers only for allowed origins.
    if (allowed) {
      applyCorsHeaders(res, origin, cors);
    }

    // 4. Short-circuit OPTIONS preflight before auth / body parsing.
    const method = (req.method ?? '').toUpperCase();
    if (method === 'OPTIONS') {
      if (allowed) {
        res.setHeader('Access-Control-Allow-Methods', PREFLIGHT_ALLOW_METHODS);
        // Reflect the requested headers or fall back to the sane allowlist.
        const requestedHeaders = req.headers['access-control-request-headers'];
        const allowHeaders =
          typeof requestedHeaders === 'string' && requestedHeaders.trim().length > 0
            ? requestedHeaders
            : PREFLIGHT_ALLOW_HEADERS;
        res.setHeader('Access-Control-Allow-Headers', allowHeaders);
        res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // 5. Delegate to the inner listener for all non-OPTIONS requests.
    inner(req, res);
  };
}
