# Gambit — Milestone Roadmap

Each milestone ships **real, tested code** and has explicit acceptance criteria.
We do not advance until a milestone's criteria are met and it passes a
self-critique + multi-perspective review. This is deliberately incremental: the
full platform is a multi-year effort, and correctness compounds.

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## ✅ Milestone 1 — Rules engine core (`@chess-platform/core`)

The correctness-critical foundation everything else depends on.

- ✅ 0x88 board, immutable `Position`, FEN parse/serialize, UCI + SAN.
- ✅ Legal move generation: castling, en passant, promotion, pins, checks.
- ✅ Variants: Chess960 scaffolding, King of the Hill, Atomic, Crazyhouse
  (drops + pockets), Three-Check, Horde, Racing Kings.
- ✅ Terminal detection: checkmate, stalemate, insufficient material, fifty-move,
  variant win/draw conditions.
- ✅ **Acceptance:** `perft` matches published reference node counts for 5
  positions (startpos d4=197,281; Kiwipete d3=97,862; +3 edge cases). 14/14 tests
  pass; strict TypeScript with zero errors.

**Known follow-ups (tracked):** perft suites for each variant; threefold
repetition via position-hash history; Chess960 castling-by-file; PGN parser.

---

## ✅ Milestone 2 — Game Authority + event sourcing

- ✅ Deterministic clock model (`clock.ts`): Fischer increment, Bronstein/US
  delay, sudden-death, unlimited; flag detection; speed classification.
- ✅ Event-sourcing types (`events.ts`): `GameCreated`, `MovePlayed`,
  `DrawOffered`/`DrawDeclined`, `GameEnded`.
- ✅ `Game` aggregate (`game.ts`): server-authoritative legality via
  `@chess-platform/core`; commands (`playMove`, `resign`, `offerDraw`,
  `acceptDraw`, `declineDraw`, `claimFlag`, `abort`); pure reducer;
  `Game.fromEvents` reconstructs any game exactly.
- ✅ Terminal handling: checkmate, stalemate, timeout (with insufficient-material
  → draw), resignation, agreement, variant win/draw, abort.
- ✅ **Acceptance met:** 18/18 tests pass. Clock math property tests; a game is
  reconstructed byte-for-byte (FEN, ply, clocks, SAN) from its event log; a
  2,000-game reconstruction runs at ~1.17ms/game (headroom for high
  concurrency). Strict TypeScript, zero errors.

**Follow-ups (tracked):** threefold-repetition via position-hash history in the
aggregate; per-variant timeout material rules.

## ✅ Milestone 3 — Realtime Gateway (`@chess-platform/realtime-gateway`)

The real-time edge that turns the event-sourced authority into a live,
multi-client game surface.

- ✅ Server-authoritative wire protocol (`protocol.ts`): join, move (with
  `clientSeq`), resign/draw/flag/abort, resume, ping — plus authoritative
  `joined`/`state`/`move`/`ended`/`presence`/`resumed`/`reject`/`pong` frames
  and a default JSON codec (MessagePack seam documented).
- ✅ Game Authority (`authority.ts`): owns live games, validates every command
  via `@chess-platform/game`, appends to an append-only event log, and publishes
  authoritative broadcasts. Commands are **serialized per game** (race-free).
- ✅ Rooms + presence + fanout (`room.ts`, `gateway.ts`): players and spectators
  join a room; moves fan out to all members; presence tracks seats + spectators.
- ✅ Pub/sub fanout seam (`pubsub.ts`): `InMemoryPubSub` for one process; a Redis
  adapter (same interface) documented for multi-node fanout.
- ✅ Transport seam (`transport.ts`): `InMemoryConnection` for deterministic
  tests; a `ws` adapter documented for real sockets.
- ✅ Optimistic-move reconciliation: illegal / out-of-turn / stale-`clientSeq`
  moves return a `reject` referencing the seq so clients roll back.
- ✅ Reconnect/resume from `lastPly`; latency compensation via `ping`/`pong`
  server timestamps + pure client-side clock interpolation (`latency.ts`).
- ✅ **Acceptance met:** 26/26 tests pass, including a reconnection integration
  test and a fanout load test asserting **p99 < 50ms** broadcasting to 5,000
  active subscribers with 50,000 idle connections registered (observed p99
  ~16ms in CI). Strict TypeScript, zero errors. Full-scale network load is
  validated by infra load tests on the deployable service (M14).

**Follow-ups (tracked):** ship the `ws` + Redis production adapters in the
deployable gateway service (M14); binary (MessagePack) move frames; per-user
connection quotas / backpressure (hardened in M12).

## ✅ Milestone 4 — API & identity (REST)

> **Gate status:** The database architecture in [`docs/DATABASE.md`](DATABASE.md)
> is **APPROVED** (see [`docs/adr/0001-persistence-data-modeling.md`](adr/0001-persistence-data-modeling.md)).
> Both packages are shipped: **`persistence`** and **`api`**. See
> [`docs/PROJECT_STATE.md`](PROJECT_STATE.md) for the live handover.

Split into two new packages: `persistence` (durable data: schema, migrations,
repositories, the game event store) and `api` (the stateless REST service).
The database architecture is defined and approved in
[`docs/DATABASE.md`](DATABASE.md) **before any DB code is written**.

- ✅ **`persistence` package (`@chess-platform/persistence`).** Append-only
  `EventStore` (in-memory + Postgres) keyed by per-game `seq` with optimistic
  concurrency and `event_version`; forward-only checksum-verified migration runner
  + `0001_init.sql` (event log, identity/RBAC, Glicko-2 ratings, seeks, games
  projection, observability-rich audit log; lookup tables + CHECK, not ENUM);
  UUIDv7 ids; verified Glicko-2; typed repositories (users/credentials/roles,
  sessions with security metadata, ratings, games, seeks). 14 tests pass
  (Postgres integration tests gated on `DATABASE_URL`); the play→store→
  `Game.fromEvents` round-trip is verified. Strict TS, zero errors.
- ✅ REST API + published **OpenAPI** spec (GraphQL deferred — see note below).
  Node built-in HTTP + a typed router with DI (`createApiServer`); OpenAPI 3.1
  generated from the live route table and committed to `packages/api/openapi.json`.
- ✅ Identity: **`PasswordHasher` abstraction with a scrypt default** (argon2id is
  a drop-in — the stored hash is self-describing), session + **refresh-token
  rotation with revocation and reuse (theft) detection**, RBAC
  (user/coach/tournament-director/moderator/admin). *WebAuthn/passkeys deferred*
  (the `webauthn_credentials` table exists; the flow lands in a later hardening
  pass — see PROJECT_STATE §5).
- ✅ Users, profiles, seeks/lobby, **Glicko-2 ratings per variant**, leaderboards
  (rating math implemented in `persistence`, surfaced by `api`).
- ✅ Durable **event store** for games so the M3 authority can persist and
  rehydrate game state exactly from its log (authority wiring lands with the
  deployable service in M14).
- **Acceptance:** ✅ authZ-matrix tests (in `api`); ✅ rating updates verified
  against a Glicko-2 reference (in `persistence`); ✅ OpenAPI published
  (`packages/api/openapi.json`, served at `/v1/openapi.json`); ✅ DB integration
  tests (ephemeral Postgres, gated on `DATABASE_URL`); ✅ game persistence
  round-trip (store → `Game.fromEvents` → identical state, in `persistence`).

> **Roadmap decision (M4):** GraphQL is intentionally deferred. Shipping REST +
> GraphQL together doubles the security/ops surface (query-cost limiting,
> persisted queries) for no near-term gain — gameplay real-time is already the
> WebSocket gateway's job. A GraphQL read layer is introduced with the
> features that justify nested, client-driven reads (studies, master-game
> explorer, social graph) in **M10–M11**.

## ✅ Milestone 5 — Engine bridge (`@chess-platform/engine`)

> **Gate:** APPROVED — design in [`docs/ENGINE_BRIDGE.md`](ENGINE_BRIDGE.md); decisions in
> [`docs/adr/0002-engine-bridge.md`](adr/0002-engine-bridge.md) (Status: Accepted). The package
> is **implemented and green**; a real-engine golden test and the authority↔bot wiring are
> env-gated / deferred to M14, mirroring the M3/M4 scope split.

Provider-agnostic UCI engine bridge behind clean seams (`AnalysisProvider`, `EngineManager`,
`EnginePool`, `EngineInstance`, `EnginePlugin`, `AnalysisCache`, `EngineTransport`) driving
analysis, hints, eval bars, and rating-calibrated bots — never in the gameplay legality path.

- ✅ Dependency-free domain; native processes and any client isolated behind seams.
- ✅ Multi-engine, capability-discovery routing (Stockfish + Fairy-Stockfish + future engines);
  no engine-name conditionals; engine version negotiation + build fingerprinting.
- ✅ Worker lifecycle: warm pool, autoscale by queue depth, crash detection + hot replacement,
  per-pool circuit breaker, graceful drain, health interfaces.
- ✅ Priority scheduler (bot > live analysis > batch > background) with aging + backpressure;
  cooperative + hard (watchdog) cancellation.
- ✅ `AnalysisCache` port with in-process LRU default (durable backend deferred — future ADR-0003,
  so M5 does not touch the approved `DATABASE.md` contract).
- ✅ **Acceptance (in-package, deterministic):** 51/51 tests pass against a `FakeEngineTransport`
  — info/multi-PV parsing, pool autoscaling under queue pressure, crash → hot-replacement with no
  job loss, circuit-breaker trip, graceful drain, cancellation, watchdog kill, version-floor
  enforcement, cache correctness, and a full scripted bot game. Strict TypeScript, lint clean.
- ⬜ **Deferred to M14 (deployable service):** real-engine golden test (env-gated; needs a pinned
  binary in CI), live-infra autoscaling, distributed remote workers, and wiring the bot/analysis
  path into the M3 `GameAuthority` + M4 `EventStore`.

## 🚧 Milestone 6 — Web frontend (playable)

- Board UI (animation, premoves, drag + click), clock, game view, lobby,
  profile; PWA; a11y; light/dark.
- **Acceptance:** e2e (Playwright) plays a full game vs. bot and vs. human;
  Lighthouse a11y ≥ 95.
- 🚧 **Increment 1 landed:** `@chess-platform/web` scaffold + dependency-free view core (board geometry, premove queue, chess clock, FEN placement) with 21 passing `node --test` tests, strict-TS + lint clean. Next: interactive board, REST/WS client seam, Playwright e2e, Lighthouse gate.
- 🚧 **Increment 2 landed:** interactive board — drag & drop, click-to-move, selection/legal-destination/last-move/premove highlighting, promotion UI, and premove application; legality behind a `LegalMoveOracle` port (server authoritative) + view-only optimistic mover. 54 `node --test` tests green, strict-TS + lint clean. Next: REST/WS client seam.
- 🚧 **Increment 3A landed:** REST networking foundation — a `fetch`-based `HttpTransport` port, an `HttpClient` (per-request timeout, safe-method retry with exponential backoff + jitter, JSON, and a typed error taxonomy), hand-authored request/response models mirroring `packages/api/openapi.json`, the typed `GambitClient` (health, auth/session, users/profile, ratings, leaderboard, game summaries), and a session/auth abstraction (pluggable token store + proactive, single-flight token refresh with 401 replay). Framework-independent, UI kept separate from networking; no WebSocket / lobby / gameplay sync yet. 94 `node --test` tests green, strict-TS + lint clean, production build passes. Next (3B): WS game stream + core/server-backed move oracle, wired into the app/game view.
- 🚧 **Increment 3B landed:** WebSocket foundation + gameplay synchronization — a `WebSocketConnection` port + browser adapter, a typed `WsClient` (connection state machine, automatic reconnect with exponential backoff + jitter, ping/pong heartbeat with silent-link detection), hand-authored wire-protocol models mirroring `packages/realtime-gateway/src/protocol.ts` with a JSON codec, and a `GameSync` synchronization layer (join/resume lifecycle, authoritative snapshot + live move ledger, optimistic move tracking with `clientSeq`-based confirm/rollback, ply-gap resync, presence/ended/draw-offer state). Framework-independent, networking kept separate from UI; no lobby/matchmaking/profile UI yet. 115 `node --test` tests green, strict-TS + lint clean, production build passes. Next: wire the REST + WS clients into the app composition root and game view.
- 🚧 **Increment 3C-1 landed:** application composition root — a single `src/app/` layer (`createApp` + `resolveConfig` + `mountBoard` + `bootstrap`) that wires the REST stack (`GambitClient` = `HttpClient` + `SessionManager`), the realtime `WsClient`, and a per-game `GameSync` factory via **dependency injection**, with browser adapters (`fetch` / `WebSocket` / `localStorage`) as defaults and fakes injected in tests; `main.ts` is reduced to a thin DOM entry, and the UI is kept separate from infrastructure (the board module composes UI + core only, importing no networking). **Wiring only** — no connection is opened, no gameplay synchronization, and no server-backed move oracle. 121 `node --test` tests green, strict-TS + lint clean, production build passes. Next (3C-2): connect the board/game view to `WsClient` + `GameSync` and a server-backed move oracle.
- 🚧 **Increment 3C-2A landed:** the authoritative `StateView` now carries a typed `legalMoves` map (origin square → legal destination squares) for the side to move, **computed server-side by the perft-verified core engine** in the realtime-gateway `GameAuthority` (empty once the game is over); the WS protocol and its web mirror (`ws-protocol.ts`) are extended in lockstep. The frontend consumes the contract only — no chess rules in the client, no `@chess-platform/core` import in `web`. Tests green (gateway +3, web +1), strict-TS + lint clean, production build passes. This is the first of three steps toward the server-backed `LegalMoveOracle` (ADR-0003, Option 2). Next (3C-2B): surface `legalMoves` through `GameSync` and implement the `LegalMoveOracle` adapter behind its port; then (3C-2C) wire it into the composition root.
- 🚧 **Increment 3C-2B landed:** `legalMoves` is now surfaced through `GameSync` state — populated from each authoritative `StateView` snapshot, stale (empty) after a live move broadcast until the next snapshot/resync, and empty once the game ends. A new `AuthoritativeMoveOracle` adapter (`packages/web/src/net/authoritative-oracle.ts`) implements the existing `LegalMoveOracle` port, reading the `legalMoves` map from `GameSync` state via an injected getter — no chess rules in the client, no `@chess-platform/core` import in `web`. 131 `node --test` tests green (web +9), strict-TS + lint clean, production build passes. This is the second of three steps toward the server-backed `LegalMoveOracle` (ADR-0003, Option 2). Next (3C-2C): wire the `AuthoritativeMoveOracle` into the composition root / board.
- 🚧 **Increment 3C-2C landed:** the `AuthoritativeMoveOracle` is now wired into the composition root — `createApp` exposes `createGameOracle(gameSync)` which builds an `AuthoritativeMoveOracle` reading the live `legalMoves` from `GameSync` state, and `mountBoard` accepts an optional `LegalMoveOracle` (defaulting to `NullMoveOracle`) so the board's legal-move highlights reflect the server's authoritative state. The offline `StaticMoveOracle` placeholder is removed. 133 `node --test` tests green (web +2), strict-TS + lint clean, production build passes. The three-step server-backed `LegalMoveOracle` (ADR-0003, Option 2) is complete.
- 🚧 **Increment 3D landed:** a pure, DOM-free `GameController` (`packages/web/src/app/game-controller.ts`) bridges `GameSync` state to the board UI — it subscribes to state changes, projects the current FEN from the snapshot + move ledger via the view-only mover, exposes callbacks for position/turn/clock/status updates, and forwards move submissions to `GameSync`. 9 `node --test` tests green (web +9), strict-TS + lint clean, production build passes. Next: wire the controller callbacks to the DOM `BoardView` in `bootstrap.ts`, then lobby/profile/PWA/a11y/light-dark.
- 🚧 **Increment 3E landed:** the full live game view wiring — `bootstrap.ts` now assembles the complete game view graph (GameSync + GameController + AuthoritativeMoveOracle + mountBoard with oracle and onMove callback), connecting the controller's callbacks to the DOM BoardView (position, last-move highlight, turn, clock display, status text) and forwarding user moves through the controller to GameSync. `mountBoard` exposes `setPosition`/`setLastMove`/`setTurn` on the `MountedBoard` handle and accepts an `onMove` callback for server-authoritative mode. `extractGameId` parses the game ID from the URL path; `formatClock` formats ms as M:SS. Clock display CSS added. 17 new `node --test` tests green (web +17, 159 total), strict-TS + lint clean, production build passes. Next: lobby UI, profile, PWA, a11y, light/dark, then Playwright e2e + Lighthouse gate.

## ⬜ Milestone 7 — AI orchestration layer

- Provider adapters (OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Ollama),
  routing, benchmarking, voting, engine-grounded prompts, caching, rate limits.
- **Acceptance:** failover test (kill a provider mid-request); benchmark report;
  grounded move-explanation cited against engine eval.

## ⬜ Milestone 8 — AI features

Coach, Move Explanation, Opening/Endgame Trainer, Puzzle Generator, Tournament
Commentator, Voice Coach, Study Partner, Opening Explorer, Mistake Predictor —
each a task over M5 + M7.

## ⬜ Milestone 9 — Tournaments & broadcast

Arena + Swiss + round-robin, pairings, tiebreaks, live broadcast multiplexing.

## ⬜ Milestone 10 — Social & learning

Teams/communities, forums, messaging, friends/followers, achievements; lessons,
courses, video library, PGN import, studies (collaborative), opening/endgame
encyclopedias, master game explorer. **GraphQL read layer** introduced here (and
extended in M11) for the nested, client-driven reads these features need.

## ⬜ Milestone 11 — Search

Keyword + semantic (pgvector/Meilisearch) over games, openings, players, studies;
natural-language query parsing.

## ⬜ Milestone 12 — Security hardening & anti-cheat

Engine-correlation scoring, bot detection, fraud/DDoS, audit, pen-test pass.

## ⬜ Milestone 13 — Observability & SRE

OpenTelemetry, Prometheus, Grafana, alerting, SLOs, runbooks, chaos tests.

## ⬜ Milestone 14 — Deployment & scale

Docker, Kubernetes, Terraform, GitHub Actions, blue/green + canary, rollback,
secrets management, 100k-user load + chaos validation.

---

## Working method (applied every milestone)

1. **Build** the milestone to its acceptance criteria with tests.
2. **Self-critique loop:** review for architectural mistakes, perf bottlenecks,
   security issues, poor abstractions, duplication, race conditions, API
   inconsistencies, UX gaps — then refactor.
3. **Multi-perspective review:** evaluate from the viewpoints of a distributed-
   systems engineer, a performance engineer, a security engineer, and a chess-
   server maintainer; merge and apply feedback.
4. Advance only when no critical issue remains.
