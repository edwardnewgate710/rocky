# Gambit — Project State (Engineering Handover)

> Living handover document. Anyone (human or AI) joining the project should be able
> to read **only this file** and continue immediately. Updated after every
> milestone and every significant architectural step.

_Last updated: 2026-07-12 — M14 increment 4 (Kubernetes Helm chart). **M7, M8, M14 inc 1–4 complete.** Prior: Review #03 fixes applied:
the authoritative `legalMoves` map from the server snapshot is now surfaced through `GameSync`
state (populated from each `StateView`, stale after a live move broadcast, empty once the game ends)
and a new `AuthoritativeMoveOracle` adapter implements the existing `LegalMoveOracle` port, fed by
the `GameSync` state's `legalMoves` map — no chess rules in the client, no `@chess-platform/core`
import in `web`. This is step 2 of the server-backed `LegalMoveOracle` (ADR-0003, Option 2). Prior
context below. **Increment 3C-2A (prior):**
the authoritative realtime `StateView` now carries a typed `legalMoves` map (origin square →
legal destinations for the side to move), **computed server-side by the perft-verified core engine**
in the realtime-gateway `GameAuthority` and empty once a game is over; the WS protocol and its web
mirror (`ws-protocol.ts`) are extended in lockstep, with the frontend consuming the contract only
(no chess rules in the client, no `@chess-platform/core` import in `web`). This is step 1 of the
server-backed `LegalMoveOracle` (ADR-0003, Option 2 — legal moves embedded in the authoritative
state). Prior context below. **Increment 3C-1:**
the web frontend's application **composition root** landed — a single `packages/web/src/app/`
layer (`createApp` + `resolveConfig` + `mountBoard` + `bootstrap`) that assembles the object graph
via dependency injection: the REST stack (`GambitClient` = `HttpClient` + `SessionManager`), the
realtime `WsClient`, and a per-game `GameSync` factory, with browser adapters (`fetch` / `WebSocket`
/ `localStorage`) as defaults and fakes injected in tests. `main.ts` is now a thin DOM entry and the
UI stays separate from infrastructure (the board module composes UI + core only). This increment is
**wiring only**: no connection is opened, no gameplay synchronization or server-backed move oracle is
implemented. Web suite 121 tests green (strict-TS + lint clean, production build passes). Prior context
below. **Increment 3B (prior):**
the web frontend's WebSocket foundation + gameplay synchronization landed — a `WebSocketConnection`
port + browser adapter, a typed `WsClient` (connection state machine, automatic reconnect with
exponential backoff + jitter, ping/pong heartbeat with silent-link detection), hand-authored
wire-protocol models mirroring `packages/realtime-gateway/src/protocol.ts` with a JSON codec, and a
`GameSync` synchronization layer (join/resume lifecycle, authoritative snapshot + live move ledger,
optimistic move tracking with `clientSeq`-based confirm/rollback, ply-gap resync, presence/ended/
draw-offer state). Framework-independent, networking kept separate from UI; no lobby/matchmaking/
profile UI yet. Web suite 115 tests green (strict-TS + lint clean, production build passes). Prior
context below. **Milestone 5 COMPLETE:** the
`@chess-platform/engine` package is implemented, tested (51/51), and reviewed. ADR-0002 is
**Accepted**. Whole repo now 170 tests green. This commit ships the engine bridge and updates
the handover. Base commit before this one: `c465fba` ("docs: refine M5 engine-bridge design"). The
prior refinement note (kept for history): a ten-point review adding an `EngineManager` orchestrator,
a plugin + capability-discovery model, an `AnalysisProvider` abstraction above UCI, a cache **port**
(reversing the earlier durable-Postgres choice), and reliability seams (isolation, hot
replacement, graceful shutdown, health). **No engine code is written until the gate is
approved.** Base commits: `f7c588e` (M4 api) → `cb19dec` + `4703f23` (M5 gate opened)._

---

## 1. Snapshot

- **Product:** *Gambit* — AGPL-3.0 open-source chess platform aiming at feature
  parity with Lichess/Chess.com plus a first-class AI layer. Intended to be a
  commercial product scaling to millions of users.
- **Repo model:** npm-workspaces monorepo, Node ≥20, **strict TypeScript**,
  dependency-free domain packages, tests via the built-in `node --test` runner.
- **Method (applied every milestone):** build to explicit acceptance criteria with
  tests → self-critique loop → multi-perspective review (distributed-systems,
  performance, security, chess-server maintainer) → advance only when clean.

## 2. Completed milestones

| M | Package | Result | Tests |
|---|---|---|---|
| **M1** ✅ | `@chess-platform/core` | Variant-aware, perft-verified rules engine (0x88, immutable `Position`, FEN/UCI/SAN, 8 variants, terminal detection) | 16/16 |
| **M2** ✅ | `@chess-platform/game` | Event-sourced `Game` aggregate + deterministic clocks; threefold repetition; exact reconstruction via `Game.fromEvents` (~1.17ms/game) | 23/23 |
| **M3** ✅ | `@chess-platform/realtime-gateway` | Server-authoritative WS protocol, `GameAuthority`, rooms/presence/fanout, resume, latency comp; `PubSub`/`Transport` seams; token-based auth (`TokenVerifier` port, ADR-0004); durable `EventLog` port + Redis `PubSub` (M14) | 56/56 |
| **M4a** ✅ | `@chess-platform/persistence` | Durable append-only event store (in-memory + Postgres), migrations, repositories, Glicko-2, UUIDv7 | 14/14 (+2 DB-gated) |
| **M4b** ✅ | `@chess-platform/api` | Stateless REST + identity (scrypt/`PasswordHasher`, HMAC access tokens, rotating refresh tokens, RBAC), seeks/ratings/games, published OpenAPI 3.1 | 48/48 |
| **M5** ✅ | `@chess-platform/engine` | Provider-agnostic UCI engine bridge: `AnalysisProvider`/`EngineManager`/`EnginePool`/`EngineInstance`/`EnginePlugin`/`AnalysisCache`/`EngineTransport`; capability discovery, priority scheduler, watchdog/cancellation, crash→hot-replacement, circuit breaker, graceful drain, health | 50/50 |
| **M6** ✅ | `@chess-platform/web` | Playable web frontend: interactive board (drag/click, premoves, promotion), REST + WS client, GameSync, lobby, profile, theme, PWA, a11y; Playwright e2e + Lighthouse gate passed | 239 |
| **M7** ✅ | `@chess-platform/ai-orchestrator` | Provider-agnostic AI orchestration: `AiProvider`/`AiOrchestrator`/`ProviderRegistry`/`RoutingStrategy`/`ResponseCache`/`RateLimiter`/`HealthTracker`/`BenchmarkRunner`; OpenAI + Anthropic adapters; engine grounding | 114 |
| **M8** ✅ | `@chess-platform/ai-features` | 8 AI features: Move Explainer, Puzzle Generator, Mistake Predictor, Opening Explorer, Endgame Trainer, Coach, Study Partner, Voice Coach; Tournament Commentator deferred to M9 | 137 (16 key-gated) |
| **M14** 🚧 | Deployable services | Docker Compose local stack (inc 1), durable EventLog + Postgres (inc 2), Redis pub/sub multi-node fanout (inc 3), Kubernetes Helm chart (inc 4); Terraform/blue-green/load-test deferred | — |

**Whole-repo total: 701 tests, 0 failures, across 10 packages + the gateway service** (skips: 2 Postgres-gated + 18 API-key-gated). Strict TS, zero errors, lint clean. CI active — 5 jobs: build+typecheck+test on Node 22/24, Postgres integration, M6 Playwright + Lighthouse acceptance, helm lint + kubeconform.

## 3. Architecture summary (as-built)

- **Dependency arrow points at the domain:**
  `core ← game ← realtime-gateway`, and `core, game ← persistence ← api`. Domain
  packages have zero runtime deps; infra (WebSocket, Redis, Postgres) enters via
  documented seams, never domain code.
- **Server is the authority.** Clients send intents; the authority validates via
  the core engine, appends to an event log, and broadcasts authoritative frames.
- **Event sourcing.** A game is an append-only `GameEvent[]`; state is a pure fold.
  The `persistence` event store makes this durable and reconstructable.
- **`api` is stateless.** Access tokens are self-contained (HMAC-SHA256), so any
  instance can serve any request with no shared session store; refresh tokens and
  identity live in Postgres via `persistence` repositories.
- **Realtime wire protocol (as of Review #03):** The `JoinMessage` now carries a
  `token` (not a client-asserted `userId`); the gateway derives identity exclusively
  from the token via a `TokenVerifier` port (ADR-0004). When the token is absent, the
  connection joins as an anonymous spectator; when present but invalid, the join is
  rejected with `unauthorized`. The `MoveBroadcast` now carries a `legalMoves` map
  (origin square → legal destinations for the side to move), computed server-side by
  the core engine — clients never derive legality themselves (ADR-0003, Option 2).

### `api` package design (this milestone)

- **HTTP:** Node built-in `http` + a **typed router** (`src/http/router.ts`).
  Routes couple their OpenAPI contract, auth policy, and handler. Handlers take a
  `RequestContext`, return a `HandlerResult`; the router is the only code that
  touches the socket. Standard JSON error envelope `{ error: { code, message,
  requestId, details? } }` with `X-Request-Id` on every response.
- **DI:** `createApiServer(deps)` is the composition root (`src/server.ts`). Deps =
  `{ repos, hasher, tokens, clock, ids, config }`. No module-level singletons.
- **Passwords:** `PasswordHasher` abstraction (`src/auth/password.ts`); default
  `ScryptPasswordHasher` (Node `crypto.scrypt`, self-describing encoding
  `scrypt$N=..,r=..,p=..$salt$hash`, timing-safe). Argon2id/KMS = drop-in, no data
  migration. Login runs a decoy verify for unknown handles (anti-enumeration).
- **Access tokens:** `AccessTokenService` (`src/auth/tokens.ts`), compact HS256
  JWS, constant-time verify, `exp` enforced against the injected `Clock`. Only the
  exact pinned header is accepted (no alg-confusion / `alg:none`).
- **Refresh tokens:** opaque 256-bit random, stored only as SHA-256 hash,
  **single-use with rotation** (`rotated_from` chain). Replaying a rotated token is
  treated as **theft** and revokes the whole chain (audited `auth.refresh.reuse`).
- **RBAC:** enforced declaratively per route (`AuthPolicy.anyRole`) and re-checked
  in handlers where ownership matters (seek cancellation).
- **Ports (injectable seams):** `Clock`, `IdGenerator` (UUIDv7), and an
  `AuditRepository` extension (`src/ports/`). In-memory fakes for every repository
  live in `src/fakes.ts`; the Postgres bootstrap is isolated behind
  `@chess-platform/api/pg` (`src/bootstrap.ts`, includes `PgAuditRepository`).
- **OpenAPI 3.1:** generated from the live route table (`src/openapi/`), served at
  `GET /v1/openapi.json` and published to `packages/api/openapi.json` via
  `npm run openapi`. A test asserts every `$ref` resolves and every route is
  documented, so the spec can never drift from the served contract.
- **Minimal dependencies:** everything is `node:crypto`/`node:http`. Root entry has
  no third-party runtime dep; `pg` only enters through the `/pg` subpath.

## 4. Key engineering decisions (log)

1. **REST-first for M4; GraphQL deferred to M10–M11** (commit `15d6bb1`).
2. **M4 split:** `persistence` (durable data) then `api` (stateless REST).
3. **DB engine = PostgreSQL** — one ACID boundary for event log + projections.
4. **Event-store ordering = per-game append `seq`**, not chess `ply`.
5. **EventStore / repositories are seams** (in-memory + Postgres), mirroring M3.
6. **`api` uses scrypt behind `PasswordHasher`** rather than a hard argon2id
   dependency: keeps the domain dependency-free and lets deployments choose the KDF
   without touching service code. The DB column stores an opaque, self-describing
   hash, so the choice is reversible.
7. **Access = stateless HMAC token, refresh = opaque rotating token.** Access
   tokens scale horizontally (no DB read on the hot path); refresh tokens give
   server-side revocation + theft detection. This is the standard split.
8. **Repository interface extension:** added `SeeksRepository.findById` to
   `persistence` (needed for seek-ownership checks) and defined an `AuditRepository`
   port in `api` (write side of the existing `audit_log` table). Additive only;
   all existing persistence tests stay green.

## 5. Deferred work / follow-ups (tracked, not lost)

- **Identity (M4 → hardening pass):** **WebAuthn/passkeys** are NOT implemented yet.
  The `webauthn_credentials` table exists in the schema; add a `WebAuthnRepository`
  + registration/assertion ceremonies. Also: password-reset + email verification
  flows, and per-account login rate limiting / lockout.
- **API hardening (M12):** request rate limiting / quotas, CORS policy, security
  headers, and body-shape strictness (reject unknown fields — schemas already
  declare `additionalProperties: false`; validators currently ignore extras).
- **Authority ↔ EventStore wiring:** connect `GameAuthority` to the durable
  `EventStore` — **deferred to the deployable service in M14** per DATABASE.md §3.3;
  the seam is ready.
- **Core (M1):** per-variant perft suites; Chess960 castling-by-file; PGN parser.
- **Game (M2):** per-variant timeout rules.
- **Realtime (M3):** ship `ws` + Redis production adapters (M14); MessagePack
  frames; per-user connection quotas / backpressure (M12).
- **Token-storage tradeoff (web):** Refresh tokens currently persist in
  `localStorage` on the client. This is acceptable for development but is not
  secure against XSS exfiltration. The plan for the M12 hardening pass is to
  move the refresh token to an `httpOnly` cookie (set by the API on login/refresh)
  and keep the short-lived access token in memory only (never persisted to
  `localStorage` or a cookie). This eliminates the XSS-exposable refresh token
  while preserving the stateless access-token hot path.

## 6. Technical debt (status)

1. **`LICENSE` — ✅ DONE** (AGPL-3.0, commit `d295ad2`).
2. **CI — ✅ ACTIVE.** `.github/workflows/ci.yml` runs five jobs on every push/PR
   to `main`: build + typecheck + test on Node 22.x/24.x, the Postgres
   integration job (persistence against a real database), the M6 acceptance
   gate (Playwright full-game e2e + Lighthouse a11y ≥ 0.95), and the M14 Helm
   job (`helm lint` + `helm template | kubeconform` for both the bundled and
   external-datastore renders). The formerly staged copies (`docs/ci/ci.yml`,
   `deploy/helm/ci.yml`) have been merged into the live workflow and deleted.
3. **Lockfile — ✅ DONE.** The root `package-lock.json` is committed and CI
   installs with `npm ci` for reproducible builds.

## 7. Milestone 4 — status & next steps

**Status: COMPLETE.** Both packages shipped, green, and reviewed.

**✅ `packages/api` (`@chess-platform/api`):** see §3 for the design. Endpoints
(v1): `health`, `openapi.json`, `auth/{register,login,refresh,logout,sessions}`,
`users/me`, `users/:handle` (+ `/ratings`, `/games`), `users/:userId/roles`
(admin), `leaderboard/:variant`, `seeks` (list/create/delete), `games/:id`.
45 tests: auth flows, **authZ matrix**, token/scrypt units, router edge cases,
resources, OpenAPI self-consistency.

**Acceptance criteria status (M4):**
- authZ-matrix tests — ✅ (`packages/api/test/authz.test.ts`).
- Glicko-2 vs reference — ✅ (`persistence`).
- OpenAPI published — ✅ (`packages/api/openapi.json`, served at `/v1/openapi.json`).
- DB integration tests (ephemeral Postgres) — ✅ gated on `DATABASE_URL`.
- Game persistence round-trip — ✅ (`persistence`).

**Verification note:** gated integration tests need `DATABASE_URL` (Postgres 16);
`npm test -w @chess-platform/persistence` applies `0001_init.sql`. The `api` suite
needs no database — it runs against in-memory fakes.

### Files likely to change next
- `packages/persistence/migrations/000X_*.sql` + a `WebAuthnRepository`
  (passkeys), and pg impls, when identity hardening starts.
- `packages/api/src/routes.ts` / `src/openapi/schemas.ts` when new endpoints land.
- `packages/realtime-gateway/src/gateway.ts` + `services/gateway` when sticky
  per-game routing / sharded authority lands (unlocks gateway replicas > 1).
- `deploy/helm/gambit/*` + `.github/workflows/ci.yml` as later M14 increments
  (Terraform, CI/CD deploy gates, secrets management) arrive.
  (The durable EventStore wiring and CI activation are done — see §6.)

### Open technical decisions
- **Passkey library vs. hand-rolled WebAuthn.** Minimal-dependency philosophy vs.
  the risk of hand-rolling attestation/assertion. Leaning toward a single, audited,
  well-scoped dependency here (crypto correctness matters more than zero-deps).
- **Rate-limiting store.** In-process token bucket (simple, per-instance) vs. Redis
  (accurate across instances). Likely Redis, reusing the M3 pub/sub adapter seam.
- **Refresh-rotation UX.** Chain-burn on reuse can log out a legitimate client that
  retried after a dropped response. Acceptable now; consider a short grace window
  keyed on the rotated-from id if it proves noisy in practice.

### Known issues
- Session create + old-session revoke on refresh are two repository calls, not one
  transaction; a crash between them could briefly leave two active sessions. Wrap in
  a transaction when a `UnitOfWork`/tx seam is added to `persistence`.
- `additionalProperties: false` is documented in the OpenAPI request schemas but the
  runtime validators don't yet reject unknown fields (they ignore them).
- A user's ratings profile issues one `RatingsRepository.get` per variant (≤8);
  fine now, but add a bulk `ratingsForUser` query before it's hot.

### Milestone 5 — IMPLEMENTED (`@chess-platform/engine` shipped)
**Status: implemented, 51/51 tests green, strict TS + lint clean.** Gate docs:
`docs/ENGINE_BRIDGE.md` + `docs/adr/0002-engine-bridge.md` (ADR Status: **Accepted**). The
ten-point refinement (all adopted) is realised in code as these seams:

- **EngineManager** orchestrator over `EnginePool` over `EngineInstance` — adopted.
- **Plugin-oriented engines** + **capability discovery** (no engine-name conditionals) — adopted.
- **AnalysisProvider** abstraction above UCI (future non-UCI/AI providers drop in) — adopted.
- **Engine version negotiation** (min-version floor + fingerprint + advertised-option-only) — adopted.
- **Cache abstraction** (`AnalysisCache` port; in-process LRU default) — adopted; this
  **reverses ADR-0002 v1's durable-Postgres decision**, so M5 no longer touches the approved
  `DATABASE.md` contract. A durable cache is deferred to a future **ADR-0003** + DB addendum.
- **Failure isolation** (process bulkhead + per-pool circuit breaker), **hot worker replacement**,
  **graceful shutdown/recovery**, and **health-monitoring interfaces** — all adopted.

No item was rejected; each is a seam within the new `@chess-platform/engine` package and none
changes the platform architecture, service map, or milestone plan. **Additional ADR evaluation:**
only ADR-0002 is required now; ADR-0003 (durable cache) is flagged for later.

**As-built (`packages/engine`, dependency-free domain, native processes behind seams):**
- `src/provider.ts` — `AnalysisProvider` (the contract every caller depends on).
- `src/manager.ts` — `EngineManager`: registry, capability-based routing, cache + FEN boundary,
  health aggregation, graceful shutdown (also `AnalysisProvider` + `AsyncDisposable`).
- `src/pool.ts` — `EnginePool`: warm workers, autoscale by queue depth, crash→hot-replacement,
  per-pool circuit breaker, graceful drain.
- `src/instance.ts` — `UciEngineInstance`: UCI state machine, per-search watchdog, cooperative
  (`stop`) + hard cancellation, crash detection, version floor.
- `src/plugin.ts` — `EnginePlugin` + built-in Stockfish / Fairy-Stockfish descriptors.
- `src/transport.ts` — `EngineTransport` seam + deterministic `FakeEngineTransport`;
  `src/child-process-transport.ts` — hardened native `ChildProcessTransport`.
- `src/cache.ts` — `AnalysisCache` port + `InMemoryLruCache`/`NullCache` (durable backend deferred).
- `src/queue.ts` — priority scheduler (aging + backpressure); `src/capabilities.ts` — discovery,
  fingerprint, version negotiation; `src/uci/protocol.ts` — pure UCI codec; `src/bootstrap.ts` —
  `createEngineManager` composition root + `BinaryResolver`.

**Deferred (tracked, not lost):** real-engine golden test (env-gated, needs a pinned binary in CI),
live-infra autoscaling, distributed remote workers, and wiring the bot/analysis path into the M3
`GameAuthority` + M4 `EventStore` — all land with the deployable service in **M14**. A durable
analysis cache remains a future **ADR-0003** (would amend `DATABASE.md`).

### Exact next step for the next agent

**Milestones M1–M8 complete; M14 increments 1–4 landed.** The platform has:
- 10 packages (core, game, realtime-gateway, persistence, api, engine, web, e2e-harness, ai-orchestrator, ai-features) + 3 deployable services (api, gateway, web).
- 701 tests, 0 failures (see §2 for the per-package breakdown); strict TS + lint clean; CI active.
- Docker Compose local stack with Postgres, Redis, API, gateway, and web.
- Durable game authority (EventLog port + Postgres wiring).
- Redis pub/sub for multi-node gateway fanout (RedisPubSub adapter, origin tagging, ref-counted subscribe).
- Kubernetes Helm chart (`deploy/helm/gambit/`) with bundled/external datastores, migration init container, single gateway replica (ownership not coordinated across replicas — sticky routing or sharded authority is a later increment), ConfigMap/Secret split, health probes, and CI validation (helm lint + kubeconform).

**Gateway replica constraint (M14 inc 4):** The gateway Deployment defaults to `replicas: 1`. Game-command ownership is NOT coordinated across gateway replicas. Scaling beyond 1 requires sticky per-game routing or sharded authority — a later M14 increment. See `docs/adr/0009-kubernetes-helm.md`.

**Next priorities (in order):**
1. **M4 identity hardening:** WebAuthn/passkeys (table exists), password reset + email verification, login rate limiting/lockout.
2. **Small deferred correctness:** PGN parser, per-variant timeout rules.
3. **M9 Tournaments & broadcast:** Arena + Swiss + round-robin, pairings, tiebreaks, live broadcast.
4. **Remaining M14:** Terraform, blue/green, CI/CD pipeline, 100k-user load testing, secrets management (external-secrets), sticky per-game routing / sharded authority for horizontal gateway scaling.

Read `docs/AI_HANDOVER.md` for the quickstart and guardrails.

## 8. How to build & test today

```bash
npm install                 # workspaces root
npm run build               # core → game → realtime-gateway → persistence → api → engine
npm test                    # runs all package test suites (node --test)
npm run openapi -w @chess-platform/api   # regenerate packages/api/openapi.json
```
Per package: `cd packages/<pkg> && npm install && npm run build && npm test`.

