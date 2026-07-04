# Gambit — Project State (Engineering Handover)

> Living handover document. Anyone (human or AI) joining the project should be able
> to read **only this file** and continue immediately. Updated after every
> milestone and every significant architectural step.

_Last updated: 2026-07-04 — by the incoming Principal Software Architect, at the
start of Milestone 4._

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

## 7. Next milestone — M4 (API & identity, REST)

**Immediate gate (in progress):** `docs/DATABASE.md` authored and submitted for
approval. **No DB code until approved.**

**Planned build order once approved:**
1. `packages/persistence`: migration runner + schema, `EventStore`
   (`InMemory` + `Postgres`), repositories (users, sessions, ratings, games,
   seeks), Glicko-2. Integration tests on ephemeral Postgres incl. the
   authority→store→`fromEvents` round-trip.
2. Wire the optional `EventStore` into `GameAuthority` (non-breaking).
3. `packages/api`: identity (argon2id, passkeys, session/refresh rotation, RBAC),
   users/profiles/seeks/ratings/leaderboards, published **OpenAPI** spec.
4. Address tech-debt items 1–3 above.

**M4 acceptance (from roadmap):** authZ-matrix tests; Glicko-2 verified vs
reference; OpenAPI published; DB integration tests (ephemeral Postgres); game
persistence round-trip identical to live state.

## 8. How to build & test today

```bash
npm install                 # workspaces root
npm run build               # builds core → game → realtime-gateway
npm test                    # runs all package test suites (node --test)
```
Per package: `cd packages/<pkg> && npm install && npm run build && npm test`.
