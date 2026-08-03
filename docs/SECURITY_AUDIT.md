# Gambit — Security Audit (M12 pen-test pass)

| Field | Value |
|---|---|
| **Date** | 2026-08-01 |
| **Commit audited** | `c4d5bc7` |
| **Scope** | REST API, WebSocket gateway, Postgres adapters, engine bridge, deploy surface, dependencies |
| **Method** | STRIDE over each trust boundary, then targeted verification against the code and, where behaviour mattered, against running containers |

This closes the last open item of Milestone 12. It is a point-in-time record: it says what was
tested, what was found, and — just as importantly — what was checked and turned out to be fine, so a
future auditor does not have to re-derive it.

---

## Trust boundaries

| # | Boundary | Untrusted input |
|---|---|---|
| 1 | REST API (`packages/api`) | request paths, query strings, JSON bodies, `Authorization`, cookies, `Origin` |
| 2 | WebSocket gateway (`services/gateway`) | upgrade requests, `Origin`, access tokens, client frames |
| 3 | Cross-node command queue (Redis lists, ADR-0010) | forwarded command envelopes from peer gateway pods |
| 4 | Postgres adapters (`packages/persistence/src/pg`) | everything above, once it reaches SQL |
| 5 | Engine subprocess (`packages/engine`) | UCI traffic to/from a Stockfish binary |
| 6 | Public web proxy (`docker/web/nginx.conf.template`) | any internet request |
| 7 | Supply chain | npm dependencies |

Assets worth protecting: password hashes, refresh tokens, email addresses, moderation verdicts
(anti-cheat and bot-detection reports), and game integrity.

---

## Findings

### SEC-1 — Prometheus registry publicly exposed (Medium) — FIXED

`docker/web/nginx.conf.template` proxied the whole of `/v1/` to the API, and `GET /v1/metrics` is a `PUBLIC`
route. The Helm Ingress routes `/` to the web service, so on any deployed Gambit the full Prometheus
registry was retrievable unauthenticated from the internet.

The API registry holds ten series: `http_requests_total{method,route,status}`,
`http_request_duration_seconds{route}`, and the five `span_export_*` counters. That is enough to
enumerate every route pattern the service exposes, read request volume and status distribution per
route — including which endpoints are returning 401, 403 or 500 — and observe latency. Because
`route` is a label, `http_requests_total{route="/v1/moderation/..."}` is a usage side channel over
moderation activity even though no moderation-specific counter exists. Maps to OWASP
**A01 Broken Access Control** and **A05 Security Misconfiguration**.

**Fix:** `location ~ ^/v1/metrics/?$ { return 404; }` ahead of the `/v1/` prefix block.
Prometheus scrapes the API Service directly inside the cluster, so nothing legitimate went through
the public proxy.

**The trailing slash matters, and the first fix got it wrong.** `splitPath` in `router.ts` is
`path.split('/').filter((s) => s.length > 0)`, so `/v1/metrics/` resolves to *the same route* and
serves the registry. An exact-match `location = /v1/metrics` therefore left a working bypass. The
first round of probing forwarded that form to the upstream and recorded it as "does not over-block"
— a bypass written down as correct behaviour, because the probe stopped at the proxy instead of
asking what the API did next. `/?$` anchors the regex so `/v1/metricsfoo` still proxies.

**Verified against a running nginx**, not by reading the config — `location` precedence is not
obvious enough to trust by eye:

| Request | Result | Meaning |
|---|---|---|
| `/v1/metrics` | 404 | blocked |
| `/v1/metrics/` | 404 | the bypass, now closed |
| `/v1//metrics`, `/v1//metrics//`, `/v1/./metrics`, `/v1/foo/../metrics` | 404 | nginx normalises before matching |
| `/v1/metrics?x=1` | 404 | query does not affect matching |
| `/V1/metrics` | SPA index | never reaches the API |
| `/v1/health`, `/v1/metricsfoo`, `/v1/metrics/sub` | proxied | the block does not over-reach |
| `/v1/metrics%20` | proxied → API 404 | safe, see below |

`/v1/metrics%20` is the only metrics-shaped request that still reaches the API, and it 404s there:
`new URL(...).pathname` preserves percent-encoding, and `router.ts` calls `decodeURIComponent` only
on `:param` captures (line 143), never on literal segments.

Regression guards, at both layers:
- `packages/api/test/observability.test.ts` asserts the API-side route equivalence that makes the
  proxy rule's shape load-bearing — `/v1/metrics/` serves, `/v1/metrics%20` does not.
- `scripts/smoke-test.mjs` asserts 404 on **both** `/v1/metrics` and `/v1/metrics/` through the real
  proxy, rejects any 404 body containing Prometheus text, and checks `/v1/health` still routes.

---

## Checked and found sound

Recorded so the next audit can start here rather than repeating the work.

**Injection (A03).** Every Postgres adapter parameterises its values. The interpolated fragments in
`repositories.ts`, `search-backfill.ts`, `search.ts` and `semantic-search.ts` are constant column
lists, pre-built `$N` placeholders, or clause strings whose values are all bound — no user data
reaches a SQL string. Full-text search uses `plainto_tsquery`/`phraseto_tsquery` (which treat input
as literal text, unlike `to_tsquery`), and jsonb filters pass a `JSON.stringify`'d object as a single
bound parameter, so neither the filter key nor its value can break out. The pgvector adapter binds
the query vector, and that vector is only ever produced by an embedder, never supplied by a client.

**Authorization (A01).** 47 routes: 24 `PUBLIC`, 16 `AUTHED`, 1 `ADMIN`, 6 `MODERATION`. All six
`/v1/moderation/**` endpoints — the ones exposing anti-cheat and bot verdicts and able to trigger
analysis — require `moderator` or `admin`. The `PUBLIC` set is health, readiness, OpenAPI, the auth
entry points, and read-only public chess data (profiles, ratings, leaderboards, search, seeks,
games, tournaments), which is appropriate for a public chess server.

**Gateway authorization.** Anonymous sockets are permitted deliberately, for spectating. They cannot
act: an invalid or expired token is rejected outright, a client that has not joined is rejected, and
a joined non-player is rejected with `spectators cannot issue commands`. Commands route by the
server-side membership record, never by a client-supplied user id.

**Authentication (A07).** Passwords use scrypt with a per-user random salt and `timingSafeEqual`
comparison. Refresh tokens are `randomBytes` and stored hashed. Email-verification and
password-reset tokens are `randomBytes(32)` — 256 bits — stored as SHA-256 hashes. Login, register,
refresh, password-reset-request, and both WebAuthn flows are rate limited per IP and per handle
against a durable Postgres bucket store (ADR-0013).

`password-reset/confirm` and `email/verify` are not rate limited. With 256-bit tokens this is not
exploitable — it is a defence-in-depth gap, not a vulnerability, and is recorded here rather than
raised as a finding.

**Security misconfiguration (A05).** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy`,
`Cross-Origin-Resource-Policy: same-origin`, and optional HSTS are all emitted. CORS is an explicit
origin allowlist defaulting to empty (no `Access-Control-Allow-Origin` header at all); credentials
are never combined with a wildcard, and an allowed origin is reflected verbatim rather than as `*`.

**Information disclosure.** Only `HttpError` messages — deliberately authored strings — reach a
response body. Unexpected errors are logged with their stack and answered with a generic 500. Span
attributes are restricted to the `BOUNDED_SPAN_ATTRS` allowlist, and a test asserts that no game id,
user id or move payload reaches span keys or values (ADR-0062).

**Command injection.** The engine subprocess is spawned with `shell: false` and a fixed argv; the
binary path comes from an environment variable, which is a trusted input in this threat model.

**Cross-node envelopes.** Forwarded commands are validated by a type guard before use, and the game
id is bound as `$1::uuid` — a malformed value fails the cast rather than reaching the query.

**Secrets.** No secrets are committed. Only `.env.example` is tracked; the sole credential-shaped
strings in the tree are test passwords inside Playwright specs.

**Supply chain (A06).** `npm audit --omit=dev` reports **0 vulnerabilities**. One authoritative
lockfile at the workspace root; CI installs with `npm ci`.

---

## Not covered by this pass

Stated plainly so the coverage is not overread:

- **No runtime fuzzing or automated DAST.** Findings come from code review plus targeted probes.
- **No load or resource-exhaustion testing.** DoS resistance is untested; M14's 100k-user load and
  chaos validation remains deferred.
- **No review of the web frontend's client-side code** beyond confirming the API sets correct
  headers. React's default escaping is assumed, not audited.
- **No cryptographic review** of the WebAuthn implementation beyond checking that challenges are
  `randomBytes(32)` and that the User Verification flag is enforced.
- **No infrastructure review** of a live cluster — TLS termination, network policies, and RBAC are
  deployment concerns outside this repository.
