# Gambit — Project State (Engineering Handover)

> Living handover document. Anyone (human or AI) joining the project should be able
> to read **only this file** and continue immediately. Updated after every
> milestone and every significant architectural step.

_Last updated: 2026-07-04 — Principal Software Architect. Milestone 4 in progress:
`persistence` package shipped and green; `api` package is next._

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
| **M1** ✅ | `@chess-platform/core` | Variant-aware, perft-verified rules engine (0x88, immutable `Position`, FEN/UCI/SAN, 8 variants, terminal detection) | 14/14 |
| **M2** ✅ | `@chess-platform/game` | Event-sourced `Game` aggregate + deterministic clocks; exact reconstruction via `Game.fromEvents` (~1.17ms/game) | 18/18 |
| **M3** ✅ | `@chess-platform/realtime-gateway` | Server-authoritative WS protocol, `GameAuthority`, rooms/presence/fanout, resume, latency comp; `PubSub`/`Transport` seams | 26/26 (p99<50ms @ 5k subs / 50k idle) |

## 3. Architecture summary (as-built)

- **Dependency arrow points at the domain:** `core` ← `game` ← `realtime-gateway`.
  Domain packages have zero runtime deps; infra (WebSocket, Redis) enters via
  documented seams (`transport.ts`, `pubsub.ts`), not domain code.
- **Server is the authority.** Clients send intents (`{gameId, uci, clientSeq}`);
  the authority validates via the core engine, appends to an event log, and
  broadcasts authoritative frames. Illegal/stale intents get a `reject`.
- **Event sourcing.** A game is an append-only `GameEvent[]`; state is a pure fold.
  `GameEvent` union = `GameCreated | MovePlayed | DrawOffered | DrawDeclined |
  GameEnded`. Only `MovePlayed` carries a chess `ply`.
- **Current durability gap:** `GameAuthority` stores each game's events **in memory
  only** (`GameRecord.events`). Nothing survives a restart. Closing this gap is the
  core of M4.

## 4. Key engineering decisions (log)

1. **REST-first for M4; GraphQL deferred to M10–M11** (commit `15d6bb1`). Rationale:
   shipping REST+GraphQL together doubles security/ops surface for no near-term
   gain; real-time gameplay is already the WS gateway's job.
2. **M4 split into two packages:** `persistence` (durable data) and `api`
   (stateless REST). DB architecture gated on `docs/DATABASE.md` approval before any
   DB code.
3. **DB engine = PostgreSQL** as single system of record for both the event log and
   relational projections (one ACID boundary for event + projection). See
   `docs/DATABASE.md`.
4. **Event-store ordering = per-game append `seq`**, not chess `ply` (non-move
   events have no ply). `ply` lives in the `MovePlayed` payload. See DATABASE.md §3.
5. **EventStore is a seam** with `InMemoryEventStore` + `PostgresEventStore`,
   mirroring the M3 pub/sub pattern; the M3 authority takes it as an *optional*
   dependency so all existing tests keep passing unchanged.

## 5. Deferred work / follow-ups (tracked, not lost)

- **Core (M1):** per-variant perft suites; threefold repetition via position-hash
  history; Chess960 castling-by-file; PGN parser.
- **Game (M2):** threefold-repetition in the aggregate; per-variant timeout
  material rules.
- **Realtime (M3):** ship `ws` + Redis production adapters (M14); binary
  (MessagePack) move frames; per-user connection quotas / backpressure (M12).

## 6. Technical debt found during onboarding (status)

These are small maintenance tasks handled alongside M4; they do **not** change the
roadmap or interrupt milestone work.

1. **`LICENSE` — ✅ DONE.** AGPL-3.0-or-later was declared everywhere but the license
   text was missing. Added verbatim GNU AGPL-3.0 (`LICENSE`, commit `d295ad2`).
2. **CI — ✅ STAGED, activation pending.** README referenced a `.github/workflows/`
   CI that did not exist. A complete workflow (install → build → typecheck → test
   on Node 20 & 22, build-before-lint/test for the core-types dependency) is
   written. It could **not** be committed to `.github/workflows/` because the push
   credential lacks the GitHub **`workflow`** scope (API returns *"does not have the
   correct permissions to execute CreateCommitOnBranch"* for workflow paths only).
   The workflow is staged at **`docs/ci/ci.yml`** with activation instructions in
   **`docs/CI_SETUP.md`** (commit `4a0db4f`). **Action for a maintainer:** `git mv
   docs/ci/ci.yml .github/workflows/ci.yml` and push with a `workflow`-scoped
   credential (or paste via the Actions UI). Then add a root `package-lock.json`
   and switch `npm install` → `npm ci`, and add a CI badge to the README.
3. **Stray root file `chess` — confirmed unreferenced, removal pending.** Contents
   are just `#chess`. Verified it is referenced **nowhere**: no `bin`/`main`, no
   imports, no README/docs/build reference, not in `.gitignore`. It is safe to
   delete. The connected GitHub integration exposes **no delete-file operation**
   (only create/update), so it could not be removed programmatically. **Action for
   a maintainer:** `git rm chess && git commit -m "Remove stray root chess file"`.

## 7. Milestone 4 — API & identity (REST): status & next steps

**DB design:** APPROVED (`docs/DATABASE.md`, refinements in ADR-0001).

**✅ Done — `packages/persistence` (`@chess-platform/persistence`):**
- `EventStore` seam: `InMemoryEventStore` (dependency-free) + `PostgresEventStore`
  (append-only, optimistic concurrency on `(game_id, seq)`, `event_version` +
  upcaster path). Exposed pg-free from the root entry; Postgres impls under the
  `/pg` subpath so consumers (e.g. the gateway) needn't pull in `pg`.
- `migrations/0001_init.sql`: event log (+append-only trigger), identity/RBAC,
  Glicko-2 ratings, seeks, games projection, audit log with
  `request_id/trace_id/ip/user_agent`. Lookup tables (`variants`, `terminations`)
  + CHECK, not native ENUM. Forward-only checksum-verified migration runner + CLI.
- `ids.ts` UUIDv7 (app-side, monotonic within a ms); `glicko2.ts` verified against
  Glickman's worked example; typed repositories (users/credentials/roles,
  sessions w/ security metadata, ratings, games, seeks).
- **Tests: 14 pass** under `node --test` (ids, glicko2, in-memory event store,
  play→store→`Game.fromEvents` round-trip). Postgres integration tests (migrations
  idempotency, pg round-trip + concurrency) **skip without `DATABASE_URL`** — run
  them in CI with a Postgres service. Strict TS, zero errors.
- Root `package.json` build/test/lint/clean now include `persistence`.

**⬜ Next — build order:**
1. `packages/api`: identity (argon2id, passkeys, session/refresh rotation, RBAC),
   users/profiles/seeks/ratings/leaderboards, published **OpenAPI** spec. Consumes
   `@chess-platform/persistence` (repositories + Glicko-2) and `/pg` for wiring.
2. Wire the optional `EventStore` into `GameAuthority` (non-breaking) — **deferred
   to the deployable service in M14** per DATABASE.md §3.3; the seam is ready now.
3. Tech-debt items 1–3 in §6 (CI activation needs the `workflow` scope; stray file
   needs a manual `git rm`).

**Remaining M4 acceptance:** authZ-matrix tests + OpenAPI published (in `api`).
Glicko-2-vs-reference and the store→`fromEvents` round-trip are **already done** in
`persistence`; DB integration tests exist and run in CI with Postgres.

**Verification note for the next engineer:** to run the gated integration tests,
set `DATABASE_URL` to a Postgres 16 instance and run
`npm test -w @chess-platform/persistence` (the runner applies `0001_init.sql`).

## 8. How to build & test today

```bash
npm install                 # workspaces root
npm run build               # builds core → game → realtime-gateway
npm test                    # runs all package test suites (node --test)
```
Per package: `cd packages/<pkg> && npm install && npm run build && npm test`.
