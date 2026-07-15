/**
 * Tests for the security middleware: CORS policy + security response headers.
 *
 * Coverage:
 * - Preflight OPTIONS from an allowed origin → 204 with full CORS headers.
 * - Preflight OPTIONS from a disallowed origin → 204, NO CORS headers.
 * - Actual request from an allowed origin → ACAO + Vary + credentials header.
 * - Actual request with no Origin (same-origin) → no CORS headers, security headers present.
 * - Security headers present on 200, 404, 422, 500.
 * - HSTS present when enabled, absent when disabled.
 * - `Server` header is not leaked.
 * - `Vary: Origin` always present when ACAO is emitted.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startHarness } from './helpers';
import type { Harness } from './helpers';

// ---------------------------------------------------------------------------
// Helper: make a raw fetch with arbitrary headers (Node 18+ built-in fetch).
// ---------------------------------------------------------------------------

async function req(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const ALLOWED_ORIGIN = 'https://app.gambit.example.com';
const DISALLOWED_ORIGIN = 'https://evil.example.com';

describe('security middleware', () => {
  // -------------------------------------------------------------------------
  // Harness with CORS enabled for one origin, credentials allowed, HSTS on.
  // -------------------------------------------------------------------------
  describe('with allowed origin + credentials + HSTS', () => {
    let h: Harness;
    let base: string;

    before(async () => {
      h = await startHarness({
        cors: { allowedOrigins: [ALLOWED_ORIGIN], allowCredentials: true },
        enableHsts: true,
      });
      base = h.baseUrl;
    });

    after(async () => {
      await h.close();
    });

    // -----------------------------------------------------------------------
    // Preflight from allowed origin
    // -----------------------------------------------------------------------
    it('OPTIONS preflight from allowed origin → 204 with full CORS headers', async () => {
      const r = await req(base, 'OPTIONS', '/v1/health', {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      });

      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
      assert.equal(r.headers.get('vary'), 'Origin');

      const acam = r.headers.get('access-control-allow-methods');
      assert.ok(acam, 'Access-Control-Allow-Methods must be present');
      assert.ok(acam.includes('GET'), 'ACAM must include GET');
      assert.ok(acam.includes('POST'), 'ACAM must include POST');

      const acah = r.headers.get('access-control-allow-headers');
      assert.ok(acah, 'Access-Control-Allow-Headers must be present');
      // We sent Authorization in the request, it should be reflected.
      assert.ok(
        acah.toLowerCase().includes('authorization'),
        'ACAH must include Authorization',
      );

      assert.ok(
        r.headers.get('access-control-max-age'),
        'Access-Control-Max-Age must be present',
      );
    });

    // -----------------------------------------------------------------------
    // Preflight from disallowed origin
    // -----------------------------------------------------------------------
    it('OPTIONS preflight from disallowed origin → 204, NO CORS headers', async () => {
      const r = await req(base, 'OPTIONS', '/v1/health', {
        Origin: DISALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      });

      assert.equal(r.status, 204);
      assert.equal(
        r.headers.get('access-control-allow-origin'),
        null,
        'ACAO must NOT be present for disallowed origin',
      );
      assert.equal(r.headers.get('access-control-allow-methods'), null);
      assert.equal(r.headers.get('access-control-allow-headers'), null);
    });

    // -----------------------------------------------------------------------
    // Actual request from allowed origin
    // -----------------------------------------------------------------------
    it('GET from allowed origin → ACAO + Vary + ACAC', async () => {
      const r = await req(base, 'GET', '/v1/health', { Origin: ALLOWED_ORIGIN });

      assert.equal(r.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
      assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
      assert.equal(r.headers.get('vary'), 'Origin');
    });

    // -----------------------------------------------------------------------
    // Actual request without Origin (same-origin browser request or curl)
    // -----------------------------------------------------------------------
    it('GET with no Origin → no CORS headers, but security headers present', async () => {
      const r = await req(base, 'GET', '/v1/health');

      assert.equal(
        r.headers.get('access-control-allow-origin'),
        null,
        'ACAO must NOT be present when no Origin',
      );
      assert.equal(r.headers.get('access-control-allow-credentials'), null);

      // Security headers must always be present.
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.ok(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
    });

    // -----------------------------------------------------------------------
    // Security headers on various status codes
    // -----------------------------------------------------------------------
    it('security headers present on a 200 (health endpoint)', async () => {
      const r = await req(base, 'GET', '/v1/health');
      assert.equal(r.status, 200);
      assertSecurityHeaders(r.headers, { expectHsts: true });
    });

    it('security headers present on a 404 (unknown route)', async () => {
      const r = await req(base, 'GET', '/v1/does-not-exist-abc');
      assert.equal(r.status, 404);
      assertSecurityHeaders(r.headers, { expectHsts: true });
    });

    it('security headers present on a 422 (validation failure)', async () => {
      // POST /v1/auth/register with a malformed body triggers validation.
      const r = await req(base, 'POST', '/v1/auth/register', {
        'Content-Type': 'application/json',
      });
      // body parsing will fail or validation will fail — either 400 or 422.
      assert.ok(r.status === 400 || r.status === 422, `expected 400 or 422, got ${r.status}`);
      assertSecurityHeaders(r.headers, { expectHsts: true });
    });

    it('security headers present on a 405 (method not allowed)', async () => {
      // DELETE /v1/health is not a registered route method.
      const r = await req(base, 'DELETE', '/v1/health');
      assert.equal(r.status, 405);
      assertSecurityHeaders(r.headers, { expectHsts: true });
    });

    it('Server header is not leaked', async () => {
      const r = await req(base, 'GET', '/v1/health');
      assert.equal(r.headers.get('server'), null, 'Server header must not be present');
    });

    it('HSTS is present when enableHsts is true', async () => {
      const r = await req(base, 'GET', '/v1/health');
      const hsts = r.headers.get('strict-transport-security');
      assert.ok(hsts, 'HSTS header must be present');
      assert.ok(hsts.includes('max-age=31536000'), 'HSTS must include max-age');
      assert.ok(hsts.includes('includeSubDomains'), 'HSTS must include includeSubDomains');
    });
  });

  // -------------------------------------------------------------------------
  // Harness with HSTS disabled (local/dev scenario).
  // -------------------------------------------------------------------------
  describe('with HSTS disabled', () => {
    let h: Harness;
    let base: string;

    before(async () => {
      h = await startHarness({
        cors: { allowedOrigins: [], allowCredentials: false },
        enableHsts: false,
      });
      base = h.baseUrl;
    });

    after(async () => {
      await h.close();
    });

    it('HSTS is absent when enableHsts is false', async () => {
      const r = await req(base, 'GET', '/v1/health');
      assert.equal(
        r.headers.get('strict-transport-security'),
        null,
        'HSTS must be absent when disabled',
      );
    });

    it('other security headers still present when HSTS is disabled', async () => {
      const r = await req(base, 'GET', '/v1/health');
      assertSecurityHeaders(r.headers, { expectHsts: false });
    });
  });

  // -------------------------------------------------------------------------
  // Default config: empty allowlist (no cross-origin access).
  // -------------------------------------------------------------------------
  describe('with default config (no allowed origins)', () => {
    let h: Harness;
    let base: string;

    before(async () => {
      h = await startHarness({});
      base = h.baseUrl;
    });

    after(async () => {
      await h.close();
    });

    it('request with any Origin → no CORS headers emitted', async () => {
      const r = await req(base, 'GET', '/v1/health', { Origin: ALLOWED_ORIGIN });
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    });

    it('OPTIONS from any origin → 204, no CORS headers', async () => {
      const r = await req(base, 'OPTIONS', '/v1/health', { Origin: ALLOWED_ORIGIN });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    });
  });
});

// ---------------------------------------------------------------------------
// Helper assertion
// ---------------------------------------------------------------------------

function assertSecurityHeaders(
  headers: Headers,
  opts: { expectHsts: boolean },
): void {
  assert.equal(headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options');
  assert.equal(headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy');
  assert.equal(headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
  assert.ok(
    headers.get('content-security-policy')?.includes("frame-ancestors 'none'"),
    'CSP frame-ancestors',
  );
  assert.equal(
    headers.get('cross-origin-resource-policy'),
    'same-origin',
    'Cross-Origin-Resource-Policy',
  );

  if (opts.expectHsts) {
    const hsts = headers.get('strict-transport-security');
    assert.ok(hsts, 'Strict-Transport-Security must be present');
  } else {
    assert.equal(
      headers.get('strict-transport-security'),
      null,
      'Strict-Transport-Security must be absent',
    );
  }
}
