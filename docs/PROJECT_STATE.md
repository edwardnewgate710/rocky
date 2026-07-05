# Gambit — Project State (Engineering Handover)

> Living handover document. Anyone (human or AI) joining the project should be able
> to read **only this file** and continue immediately. Updated after every
> milestone and every significant architectural step.

_Last updated: 2026-07-05 — Principal Software Architect. **Milestone 6 IN PROGRESS (increment 3C):**
the REST + WebSocket clients are wired into the app composition root and game view
end-to-end. The `App` class (`packages/web/src/app.ts`) composes the `GambitClient`
(REST, auth/session), `WsClient` (WebSocket, reconnect, heartbeat), `GameSync`
(game state sync, optimistic moves), and `CoreMoveOracle` (local legality via
`@chess-platform/core`) into a single injectable root. `main.ts` is now a thin
bootstrap that instantiates `App`. The `CoreMoveOracle` adapter lives at
`packages/web/src/ports/core-oracle.ts` and is the only place the web package
imports `@chess-platform/core`. The server remains authoritative; the client sends
intents and reconciles from authoritative snapshots/broadcasts. No lobby/
matchmaking/profile UI yet. Web suite 115 tests green (strict-TS + lint clean,
production build passes). Prior context below. **Milestone 5 COMPLETE.**_

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
| **M2** ✅ | `@chess-platform/game` | Event-sourced `Game` aggregate + deterministic clocks; exact reconstruction via `Game.fromEvents` (~1.17ms/game) | 18/18 |
| **M3** ✅ | `@chess-platform/realtime-gateway` | Server-authoritative WS protocol, `GameAuthority`, rooms/presence/fanout, resume, latency comp; `PubSub`/`Transport` seams | 26/26 |
| **M4a** ✅ | `@chess-platform/persistence` | Durable append-only event store (in-memory + Postgres), migrations, repositories, Glicko-2, UUIDv7 | 14/14 (+2 DB-gated) |
| **M4b** ✅ | `@chess-platform/api` | Stateless REST + identity (scrypt/`PasswordHasher`, HMAC access tokens, rotating refresh tokens, RBAC), seeks/ratings/games, published OpenAPI 3.1 | 45/45 |
| **M5** ✅ | `@chess-platform/engine` | Provider-agnostic UCI engine bridge: `AnalysisProvider`/`EngineManager`/`EnginePool`/`EngineInstance`/`EnginePlugin`/`AnalysisCache`/`EngineTransport`; capability discovery, priority scheduler, watchdog/cancellation, crash→hot-replacement, circuit breaker, graceful drain, health | 51/51 |

**Whole-repo total: 170 tests pass (2 Postgres-gated skips).** Strict TS, zero errors, lint clean.

## 3. Milestone 6 — status & next steps

**Status: IN PROGRESS (increment 3C landed).**

The web frontend (`@chess-platform/web`) now has: 
- **Increment 1:** dependency-free view core (board geometry, premove queue, chess clock, FEN placement) — 21 tests.
- **Increment 2:** interactive board (drag & drop, click-to-move, highlighting, promotion UI, premove application) — 54 tests.
- **Increment 3A:** REST networking foundation (HttpTransport port, HttpClient, typed GambitClient, session/auth) — 94 tests.
- **Increment 3B:** WebSocket foundation + gameplay synchronization (WsClient, wire protocol, GameSync) — 115 tests.
- **Increment 3C (this commit):** App composition root wiring REST + WS + GameSync + CoreMoveOracle; main.ts is now a thin bootstrap; `@chess-platform/core`/`api`/`realtime-gateway` added as workspace dependencies.

**Immediate next: Increment 4** — lobby/matchmaking UI, profile page, Playwright e2e tests, Lighthouse a11y ≥95 gate.

### Exact next step for the next agent
**Milestone 6 is now at increment 3C.** The composition root is wired. The recommended next tracks (choose per product priority):
1. **Increment 4** — Lobby/matchmaking UI, profile page, Playwright e2e tests, Lighthouse a11y ≥95 gate.
2. **M4 identity-hardening pass** — WebAuthn/passkeys (§5).
3. **Begin the M14 wiring** of `@chess-platform/engine` in the deployable service.

---

## 4. Architecture summary (as-built)

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
- **Web frontend is framework-independent.** The `App` composition root wires
  transport ports, the typed REST client, WS client, GameSync, and CoreMoveOracle
  together. The DOM is only touched in `main.ts` and `board-view.ts`.

## 5. Known tech debt

- CI workflow is staged at `docs/ci/ci.yml` (needs `workflow` scope to activate).
- Stray root `chess` file needs `git rm`.
- Committed lockfiles are inconsistent.
- **Identity hardening:** WebAuthn/passkeys, rate-limited login, email verification,
  CORS policy, security headers, and body-shape strictness (reject unknown fields — schemas already
  declare `additionalProperties: false`; validators currently ignore extras).
- **Authority ↔ EventStore wiring:** connect `GameAuthority` to the durable
  `EventStore` — **deferred to the deployable service in M14** per DATABASE.md §3.3;
  the seam is ready.
- **Core (M1):** per-variant perft suites; threefold repetition via position-hash
  history; Chess960 castling-by-file; PGN parser.
- **Game (M2):** threefold-repetition in the aggregate; per-variant timeout rules.
- **Realtime (M3):** ship `ws` + Redis production adapters (M14); MessagePack
  binary frames; per-user connection quotas / backpressure (M12).
- **Engine (M5):** the `cache` port is in-memory by default; a durable
  analysis cache remains a future **ADR-0003** (would amend `DATABASE.md`).

## 6. How to build & test today

```bash
npm install                   # workspaces root
npm run build                 # core → game → realtime-gateway → persistence → api → engine
npm test                      # runs all package test suites (node --test)
npm run lint                  # strict typecheck across packages
```
Per package: `cd packages/<pkg> && npm install && npm run build && npm test`.
Postgres-gated tests need `DATABASE_URL`; everything else (incl. the engine suite) is hermetic.
