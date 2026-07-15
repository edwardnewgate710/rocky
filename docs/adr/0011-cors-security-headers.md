# ADR-0011 — CORS policy and security response headers for the API

| Field      | Value                        |
|------------|------------------------------|
| **Status** | Accepted                     |
| **Date**   | 2026-07-15                   |
| **Scope**  | `packages/api` (HTTP layer)  |

---

## Context

The Gambit REST API is a JSON-only service consumed by the web frontend (same
origin in production, cross-origin in local dev and staging) and eventually by
third-party clients. As of M12 increment 1, it had no CORS policy and no
security response headers. Two categories of risk exist:

1. **Clickjacking / content-type sniffing / framing.** Without
   `X-Content-Type-Options`, `X-Frame-Options`, and a `Content-Security-Policy`
   `frame-ancestors` directive, browsers may be tricked into rendering API JSON
   as HTML or framing the API in an `<iframe>`.

2. **Cross-origin data theft.** Without an explicit CORS policy, browsers apply
   the same-origin restriction by default — which is safe for simple requests
   but leaves the API with no explicit allowlist for credentialed cross-origin
   access. A later M12 increment will move the refresh token to an `httpOnly`
   cookie, which requires a credentials-aware CORS allowlist on the server.

---

## Decision

### Security response headers

The following headers are added to **every** response (success, 404, 405, 422,
500 alike) via a `withSecurity` middleware in `packages/api/src/http/security.ts`:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `frame-ancestors 'none'` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (configurable) |

The `Server` header (Node fingerprinting) is suppressed.

**Why `frame-ancestors 'none'` (CSP) *and* `X-Frame-Options: DENY`?**
`frame-ancestors` supersedes `X-Frame-Options` in browsers that support CSP
Level 2. Both are emitted for defence in depth (legacy browser support).

**Why HSTS is configurable (`enableHsts`):**
TLS is terminated at the proxy (nginx, cloud load balancer). The API process
itself may listen on plain HTTP in the internal network. HSTS over plain HTTP is
a no-op (browsers ignore it) but is harmless. The flag allows local/dev
environments to disable it without confusion (`enableHsts: false` in
`docker-compose` overrides).

### CORS policy

**Design principle: credentials-aware allowlist, never `*`.**

The refresh-token cookie planned for M12 increment 2 requires
`Access-Control-Allow-Credentials: true`, which is incompatible with
`Access-Control-Allow-Origin: *`. To stay forward-compatible, the CORS
implementation *never* emits `*` — it always reflects the exact allowed origin.

| Scenario | Behaviour |
|----------|-----------|
| Request `Origin` in allowlist | Reflect exact origin in ACAO; set ACAC if configured; add `Vary: Origin` |
| Request `Origin` not in allowlist | Emit **no** ACAO (browser blocks cross-origin access) |
| No `Origin` header (same-origin) | Emit no CORS headers; security headers still applied |
| `OPTIONS` preflight from allowed origin | 204; ACAO + ACAC + Vary + ACAM + ACAH + ACMA; **no inner handler called** |
| `OPTIONS` preflight from disallowed origin | 204; **no CORS headers**; security headers applied |

**`Vary: Origin` is mandatory** whenever the origin is conditionally reflected,
so CDN and browser caches do not serve a response with one ACAO to a request
from a different origin.

**Config:**

```ts
// ApiConfig
cors: {
  allowedOrigins: ['https://app.gambit.example.com'],
  allowCredentials: true,
},
enableHsts: true,
```

Safe default: `allowedOrigins: []` — no cross-origin access (no ACAO emitted).

**Where is the middleware composed?**

`withSecurity` wraps the `router.toListener(...)` result inside
`createApiServer` (the single composition root). Route handlers are never aware
of CORS or security headers; the middleware is the only place they are set.

**Why not in the router itself?**
The router already has responsibilities (dispatch, auth, body, errors). Security
headers and CORS are orthogonal cross-cutting concerns. Keeping them in a
separate, independently testable wrapper makes both easier to reason about and
test in isolation.

---

## Consequences

- Every API response now carries the security header set above.
- Cross-origin requests from origins not in the allowlist receive no ACAO header
  (browser blocks them), which is the desired behaviour.
- The CORS allowlist is config-driven, making it deployable without code changes
  across local, staging, and production environments.
- The implementation is dependency-free (Node built-ins only), matching the
  project's zero-runtime-dep constraint for domain packages.
- A future M12 increment can add `httpOnly` cookie support without touching the
  CORS logic — just set `allowCredentials: true` in config.

---

## Alternatives considered

1. **`*` wildcard origin.** Rejected: incompatible with `allow-credentials: true`
   and the planned cookie-based refresh token.
2. **Adding CORS logic inside the router.** Rejected: violates separation of
   concerns; the router has enough responsibilities.
3. **External npm middleware (e.g., `cors`).** Rejected: the project has a
   zero-runtime-dep philosophy for the API domain package; the required behaviour
   is simple enough to implement in ~100 lines of typed Node code.
