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

**Known follow-ups (tracked):** perft suites for each variant; Chess960
castling-by-file; PGN parser. (Threefold repetition: ✅ implemented in the
M2 `Game` aggregate — see Milestone 2.)

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

**Follow-ups (tracked):** per-variant timeout material rules.

**✅ Threefold repetition (implemented):** Position-hash history in the `Game`
aggregate (the aggregate owns history; `core` stays stateless), emitting
`GameEnded('threefold')` on the third occurrence. The repetition key uses the
first four FEN fields (piece placement, side to move, castling rights, en-passant
square) — halfmove/fullmove counters are excluded. The history is part of
`GameState` and survives `Game.fromEvents` replay. Automatic termination on the
3rd occurrence is the accepted scope (a claim-based flow like FIDE OTB is out of
scope). 23/23 tests pass (0 skips); the formerly skipped acceptance test now
passes. En-passant and castling-rights differences correctly do **not** count as
repeats.

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

## ✅ Milestone 6 — Web frontend (playable)

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
- 🚧 **Increment 3F landed:** lobby controller (`packages/web/src/app/lobby-controller.ts`) — a pure, DOM-free orchestrator that manages the seek list lifecycle (fetch, create, cancel) via the new `SeeksApi`; client-side router (`packages/web/src/app/router.ts`) with typed `Route` parsing for `/`, `/game/{id}`, `/profile`, `/profile/{handle}`; `SeeksApi` added to `GambitClient` (list/create/cancel seeks); `SeekView`, `CreateSeekRequest`, `TimeControl` types added to API models. 20 new `node --test` tests (lobby controller 7, router 11), strict-TS + lint clean. Next: wire lobby UI to DOM in bootstrap, profile page, PWA, a11y, light/dark, then Playwright e2e + Lighthouse gate.
- 🚧 **Milestone 4G landed:** lobby UI wiring — `LobbyController` connected to DOM (seek list rendering, create-seek button, cancel via event delegation); profile controller (`packages/web/src/app/profile-controller.ts`) with profile/ratings/games display; theme toggle (`packages/web/src/app/theme-toggle.ts`) with light/dark switching persisted to localStorage; client-side routing via `parseRoute` driving view selection (lobby/game/profile); updated `index.html` with nav, lobby, profile, and theme-toggle DOM elements; lobby/profile/theme CSS. 18 new tests (profile controller 6, theme toggle 8), web suite now 197 tests. Next: PWA, a11y audit, Playwright e2e + Lighthouse gate.
- 🚧 **Milestone 4H landed:** PWA infrastructure (manifest.webmanifest, service worker with app-shell caching), a11y tests (13 tests validating ARIA structure, skip link, semantic HTML, keyboard navigation), Playwright e2e setup (config + smoke tests for app load, board visibility, nav, theme toggle, skip link), main.ts updated with SPA routing (pushState + popstate) and service worker registration. 13 new a11y tests, web suite now 210 tests. M6 is feature-complete pending full Playwright e2e + Lighthouse gate with running backends.
- 🚧 **Review #04 fixes applied:** C1 router compile fix, C2 SW rework (no API caching, network-first nav), C3 PWA icons, C4 @playwright/test + acceptance specs + auth controller, M2 session-gated lobby, m1-m4 minor fixes. M6 remains 🚧 pending full Playwright + Lighthouse acceptance.
- ✅ **M6 acceptance gate PASSED (merged in PR #4):** both acceptance specs play full games through **real DOM clicks** — vs-human plays a complete Fool's Mate to checkmate with the terminal state asserted in both players' UIs, and vs-bot plays real moves with the bot replying and resigning (via the `botResignsAfterPlies` harness lever). Driven by the `@chess-platform/e2e-harness` package (real in-memory API + gateway + bot) so the specs exercise genuine HTTP + WebSocket flows. Lighthouse a11y: **0.95** (≥ 0.95 gate). The gate exercise surfaced and fixed two real product bugs: the session token was never passed into the WS join, and session/theme storage was never wired into the real app (both invisible to unit tests, caught only by driving the real UI). CI verified green (Node 22 + 24 + Postgres + Playwright/Lighthouse). **M6 complete.**

## ✅ Milestone 7 — AI orchestration layer

- Provider adapters (OpenAI-compatible HTTP adapter covering OpenAI, DeepSeek, OpenRouter,
  Ollama; Anthropic adapter), routing, benchmarking, engine-grounded prompts, caching, rate limits.
- **Voting/ensemble deferred to M8** (AI features) — ensemble behavior belongs with concrete
  AI feature use cases, not the orchestration framework.
- **Acceptance:** failover test (kill a provider mid-request); benchmark report;
  grounded move-explanation cited against engine eval.
- 🚧 **Implementation in progress:** `@chess-platform/ai-orchestrator` — provider-agnostic
  AI orchestration layer with `AiProvider` interface (complete/stream/embed),
  `AiOrchestrator` (routing + failover + cache + rate limit + health), `ProviderRegistry`
  (plugin-oriented, capability-based), `RoutingStrategy` (priority/weighted/round-robin),
  `ResponseCache` port (InMemoryLruCache), `RateLimiter` (per-user + global), `HealthTracker`
  (rolling window + circuit breaker with explicit half-open transition), `BenchmarkRunner`
  (curated chess tasks → report), engine-grounded prompting (`EngineGrounding` → provider-agnostic
  system messages), `FakeProvider` for deterministic testing.
  **HTTP adapters:** `OpenAiCompatibleAdapter` (covers OpenAI, DeepSeek, OpenRouter, Ollama via
  configurable baseUrl) and `AnthropicAdapter` (Anthropic Messages API). Both use global `fetch`
  (no SDK dependencies). Env-gated integration tests skip without API keys.
  **Engine grounding:** `engineResultsToGrounding()` bridges `@chess-platform/engine` analysis
  results into `EngineGrounding` for LLM prompts. Hermetic test using simulated engine results.
  **Voting/ensemble deferred to M8** (AI features) — ensemble behavior belongs with concrete
  AI feature use cases. ADR-0005 accepted.
- ✅ **M7 complete (merged in PR #5):** clean-tree `npm ci` → build → test → lint verified green; `@chess-platform/ai-orchestrator` adds 114 tests (2 env-gated real-API integration tests skip without keys). CI verified green on Node 22 + 24 + Postgres after fixing the Lighthouse Chrome-launch step (point Lighthouse at Playwright's Chromium via `CHROME_PATH`; environmental launch failures warn-and-pass, genuine a11y regressions still fail). Whole repo now 8 packages.

## ✅ Milestone 8 — AI features

Coach, Move Explanation, Opening/Endgame Trainer, Puzzle Generator, Tournament
Commentator, Voice Coach, Study Partner, Opening Explorer, Mistake Predictor —
each a task over M5 + M7.

M8 ships as a sequence of small, independently reviewable increments — one
feature per PR. Architecture recorded in
[ADR-0006](docs/adr/0006-ai-features.md).

### Increment 1: Move Explanation ✅

`MoveExplainer` — given a position (FEN) and a played (or candidate) move
(UCI), produces a natural-language explanation grounded in real engine
analysis. The explanation cites the engine's eval (cp/mate) and best line as a
distinct, testable `EngineCitation` field — not prose the test has to parse.

- New package `@chess-platform/ai-features` (`packages/ai-features`), depending
  on `@chess-platform/engine` + `@chess-platform/ai-orchestrator` only.
- Everything behind ports: `AnalysisProvider` (M5) + `AiProvider` (M7) are
  constructor-injected. Fully testable hermetically with `FakeEngineTransport`
  + `FakeProvider` — no keys, no binary, no network.
- Engine grounding path: `AnalysisProvider.analyze()` →
  `engineResultsToGrounding()` → `buildGroundedMessages()` →
  `AiProvider.complete()`.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite drives `MoveExplainer` end-to-end with
    `FakeEngineTransport` + `FakeProvider`, asserting the explanation carries
    the correct grounded eval and best-line citation for a known position.
  - One env-gated integration test (skips without an API key, exactly like M7's
    adapter tests) runs the real path against a real provider.
  - Package added to root build/test/lint/clean chains and CI workflow test
    matrix.
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ADR-0006 recording the M8 feature architecture and why Move Explanation is
    the template.
  - Regenerated `package-lock.json` committed in the same commit as the new
    package.

### Increment 2: Puzzle Generator ✅

`PuzzleGenerator` — given a position (FEN), determines whether it contains a
sharp tactical puzzle and, if so, produces a structured puzzle. Puzzle validity
is an objective, testable engine fact: the generator runs the engine with
`multiPv: N` and a position qualifies when the best line's eval exceeds the
second-best by a configurable threshold (default 200 cp) or the best line is
mate and the second-best is not. The LLM never decides whether a puzzle is real.

- Follows the established template (ADR-0006): ports injected, engine-verified
  structured fields, hermetic tests with fakes.
- The puzzle's correctness fields (solution move, eval gap, best line) come
  entirely from the engine. The AI provider's role is only the human-facing
  flavour (theme/hint) — additive, never load-bearing. If no AI provider is
  supplied, the generator still returns a fully valid puzzle.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: sharp position → `Puzzle` with correct
    engine-derived solution/gap/best-line; quiet position → `PuzzleRejection`
    with measured gap; mate-vs-non-mate → qualifies; AI omitted → valid puzzle
    with engine fields and no LLM text.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ROADMAP updated; ADR-0006 unchanged (follows the established template).

### Increment 3: Mistake Predictor ✅

`MistakePredictor` — given a position (FEN) and a candidate move the player is
considering, determines whether that move is a mistake and how severe. Mistake
severity is an engine-measured delta, not an LLM judgment: the predictor
analyses the original position (`evalBefore`), applies the candidate move with
`@chess-platform/core`'s `Position.play()`, analyses the resulting position
(`evalAfter`), normalises the eval to the mover's perspective (negating the
sign since it is now the opponent's turn), and computes
`centipawnLoss = evalBefore − evalAfterMoverPerspective`. Classification uses
standard thresholds (inaccuracy ≥ 50 cp, mistake ≥ 100 cp, blunder ≥ 300 cp,
configurable). A move that walks into a forced mate is always a blunder.

- Follows the established template (ADR-0006): ports injected, engine-verified
  structured fields, hermetic tests with fakes.
- The verdict's correctness fields (evalBefore, evalAfter, cp loss, better
  move) come entirely from the engine. The AI provider's role is only the
  human-facing coaching text — additive, never load-bearing. If no AI provider
  is supplied, the predictor returns a fully valid verdict.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: clear blunder → `blunder` with correct cp
    loss and better move; good move → `ok`; inaccuracy and mistake at threshold
    boundaries; sign-correctness test proving the perspective flip; move into
    mate → `blunder`; AI omitted → valid verdict with engine fields and no LLM
    text.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ROADMAP updated; ADR-0006 unchanged (follows the established template).

### Increment 4: Opening Explorer ✅

`OpeningExplorer` — given a game's move sequence (from the start), identifies
the opening and explains the position. This is the first M8 feature whose
primary facts are not engine evals: opening identification comes from an
`OpeningDatabase` port backed by a small, curated, original bundled dataset
(Ruy Lopez, Sicilian Najdorf, Queen's Gambit, etc.). The explorer finds the
deepest matching opening (longest known line), returns ECO code, name,
continuations, and optional stats. A non-book sequence returns a clean "no
known opening" result — never a fabricated one.

- Introduces a **new port type** (`OpeningDatabase`) — the first non-engine
  data source in M8. Sets the pattern for future data-backed features
  (endgame tablebase, etc.). ADR-0006 updated to record this.
- Optionally enriches with the engine (M5): if an `AnalysisProvider` is
  supplied, evaluates the current position. Optional — the explorer returns a
  valid result from the opening DB alone.
- The AI provider's role is only the human-facing narrative — additive, never
  load-bearing. If no AI provider is supplied, the result is fully valid.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: known opening → correct ECO/name/continuations;
    prefix-then-diverge → deepest match with `outOfBook: true`; non-book
    sequence → clean "no known opening"; engine omitted → DB fields only;
    AI omitted → valid result with no LLM text.
  - Bundled dataset is original, compact, documented, and unit-tested for
    internal consistency (every entry's move sequence is legal).
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: `rm -rf node_modules packages/*/dist packages/*/dist-test && npm ci && npm run build && npm test && npm run lint` — all green.
  - ADR-0006 updated with the new port type and bundled-dataset decision.
  - ROADMAP updated; M8 remains 🚧.

### Increment 5: Endgame Trainer ✅

`EndgameTrainer` — serves a training endgame and, given a learner's attempted
move, evaluates it against the engine's solution and coaches. Pairs naturally
with Opening Explorer (increment 4) and reuses two established patterns: a
bundled-dataset port (`EndgameDatabase` / `BundledEndgameDatabase`) for the
training positions, and engine analysis with perspective-flip logic (from
Mistake Predictor, increment 3) for the solution and move evaluation.

- Two entry points: `nextPosition(request)` selects a training position and
  returns it with the engine-verified solution; `evaluateAttempt(request)`
  judges the learner's move (optimal / acceptable / throws_result) and whether
  the goal (mate / win / draw) is preserved.
- The dataset supplies the position and goal; the engine judges; the LLM
  provides only the teaching narrative. All correctness fields come from the
  engine — the LLM never decides whether a move is correct.
- Bundled dataset: ~20 classic instructive endgames (K+Q vs K, K+R vs K,
  K+P vs K, Lucena, Philidor, opposition, K+BB vs K, K+BN vs K, etc.).
  Original, compact, documented, unit-tested for internal consistency.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: `nextPosition` returns goal + engine solution;
    optimal move → `optimal`, goal preserved; move that throws away the win →
    `throws_result`, goal lost; sign/perspective test proving the flip;
    mate distance surfaced correctly; AI omitted → valid results, no LLM text.
  - Bundled dataset original, compact, documented, unit-tested.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: all green.
  - ADR-0006: follows established patterns (bundled-dataset port + perspective
    flip), short note added.
  - ROADMAP updated; M8 remains 🚧.

### Increment 6: Coach ✅

`Coach` — a composition layer that orchestrates the five existing feature
classes (`MoveExplainer`, `MistakePredictor`, `PuzzleGenerator`,
`OpeningExplorer`, `EndgameTrainer`) into a unified coaching response. Given a
position (FEN) and optionally a move, the Coach decides which features are
relevant, calls them, and aggregates their structured outputs.

- Introduces the **composition/orchestration pattern**: a feature built from
  features. The Coach calls the underlying features; it does NOT re-implement
  their logic. Study Partner and Tournament Commentator will follow the same
  shape. ADR-0006 updated to record this.
- Every fact in the response is traceable to a feature's engine-verified
  output. The Coach's synthesized narrative is additive; if no AI provider is
  supplied, the Coach returns all structured feature results with no narrative.
- Degrades gracefully: if a feature reports "not applicable" (no opening match,
  not a puzzle, not an endgame, move is fine), the Coach omits that section —
  it never fabricates a lesson.
- Stateless — no session, no conversation memory (Study Partner will add that).
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: blunder → MistakePredictor + MoveExplainer;
    in-book → OpeningExplorer; sharp → puzzle; endgame → guidance; quiet
    non-book non-tactical non-endgame → NO fabricated lessons; AI omitted →
    structured results, no narrative; spy test proving the Coach calls the
    underlying features.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: all green.
  - ADR-0006 updated with the composition/orchestration pattern.
  - ROADMAP updated; M8 remains 🚧.

### Increment 7: Study Partner ✅

`StudyPartner` — a stateful multi-step learning session that tracks the
learner's progress across several positions/moves. This is the first M8 feature
with session state.

- Introduces the **stateful-session pattern**: a `StudySessionStore` port
  (create / load / save / end) with an `InMemoryStudySessionStore` default
  adapter. Session state is explicit and serializable (plain data object: id,
  topic, turns, progress metrics). No hidden mutable state on the class
  instance. ADR-0006 updated to record this.
- The Study Partner orchestrates the Coach; it does not re-implement analysis.
  Each turn, it uses the `Coach` to analyze, records the outcome, and advances
  the learning plan. Verified chess facts still originate from the engine via
  the features.
- Three entry points: `startSession` (create + first step), `submitTurn` (run
  Coach + append + update progress), `endSession` (mark complete + summary).
- Progress metrics are computed by a pure function (`computeProgress`) from the
  recorded turns — making accounting testable without running the full session.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite: startSession creates + persists; submitTurn
    runs Coach + appends + updates progress (assert metrics = exactly what
    turns imply); session isolation (two sessions don't corrupt each other);
    endSession summary consistent; non-existent session → clean error; AI
    omitted → valid sessions with no narrative; spy test proving the Study
    Partner calls the Coach.
  - One env-gated integration test (skips without API key).
  - Clean-tree verification: all green.
  - ADR-0006 updated with the stateful-session pattern.
  - ROADMAP updated; M8 remains 🚧.

### Increment 8: Voice Coach ✅

`VoiceCoach` — turns coaching output into speech-ready text. The Voice
Coach composes the `Coach` (it does not re-implement analysis); its real,
tested contribution is the **verbalization logic**: converting a
`CoachingResponse` and chess moves into natural spoken English.

- Introduces the **speech-ports pattern** — the pattern for any future
  device/IO-bound feature. Voice is split into **logic** (built now,
  hermetic) and **delivery** (deferred to the deployment layer via ports).
  `SpeechSynthesizer` (text → audio) and `SpeechRecognizer` (audio →
  text/command) ports are defined with fake/text-based default adapters
  for hermetic testing. A real TTS/STT adapter implements these same
  ports in the deployment layer (M13/M14) without touching this feature.
  ADR-0006 updated to record this decision.
- The core engineering idea: **chess notation is not speakable**, and that
  transformation is pure, deterministic, and exhaustively unit-testable.
  `Nxe5` → "Knight takes e five"; `O-O` → "castles kingside"; `e8=Q` →
  "e eight, promotes to queen"; `+` → "check"; `#` → "checkmate";
  `Qd1` → "Queen to d one". Coordinates spoken as "e five", not "e5".
  Uses `@chess-platform/core`'s `Position.toSan` to get standard notation,
  then transforms it to the spoken form via `verbalizeSan` / `verbalizeUci`.
- All chess facts still come from the Coach/features (engine-verified).
  The Voice Coach only reshapes text for speech; it invents no
  assessments. If no AI provider is supplied, it still verbalizes the
  structured engine facts — the move-to-speech transform needs no LLM;
  the LLM, if present, only smooths the connective narrative.
- Returns a structured `SpokenCoaching`: an ordered list of `SpokenSegment`
  objects (each a short natural-language string with a `kind` tag for
  optional prosody), plus the underlying `CoachingResponse` for
  traceability. Sentences are kept short and clearly segmented so a
  synthesizer can pace them.
- **Acceptance criteria (met):**
  - Hermetic `node --test` suite:
    - **Exhaustive move-to-speech table test**: piece moves, captures
      (`Nxe5` → "Knight takes e five"), both castlings, promotion
      (`e8=Q`), check (`+`), checkmate (`#`), pawn moves, pawn captures,
      disambiguated moves (`Nbd7`, `R1e2`, `Qh4e1`) — assert each spoken
      form. A verbalizer that reads `Nxe5` literally as "N-x-e-5" is
      broken.
    - Full `verbalize(coachingResponse)` producing an ordered segment
      list from a coaching response with a blunder + better move → assert
      the segments say the right things in speakable form.
    - The Coach is actually called (spy/fake), not re-implemented.
    - AI provider omitted → valid spoken segments from engine facts, no
      LLM narrative.
    - The fake `SpeechSynthesizer`/`SpeechRecognizer` ports are exercised,
      proving the seam works.
  - One env-gated integration test (skips without `OPENAI_API_KEY` /
    `ANTHROPIC_API_KEY`) for the narrative-smoothing path.
  - Clean-tree verification: `rm -rf node_modules packages/*/dist
    packages/*/dist-test && npm ci && npm run build && npm test && npm
    run lint` — all green.
  - ADR-0006 updated with the speech-ports + deferred-delivery decision.
  - ROADMAP updated; **M8 ✅ complete**.

### M8 completion

**M8 is complete.** 8 features delivered: Move Explanation, Puzzle
Generator, Mistake Predictor, Opening Explorer, Endgame Trainer, Coach,
Study Partner, Voice Coach. 1 feature explicitly deferred: **Tournament
Commentator** is deferred to M9 because it requires live-tournament
infrastructure (tournament state, game feeds, broadcast integration) that
does not exist yet. The deferral is honest and explicit — 8 features
delivered, 1 deferred with a reason.

## ✅ Milestone 9 — Tournaments & broadcast

Arena + Swiss + round-robin, pairings, tiebreaks, live broadcast multiplexing.

**M9 is complete** (12 increments, ADR-0014 → ADR-0024): a pure tournament
domain package (`@chess-platform/tournament`) with round-robin (Berger
circle method), Swiss (deterministic Monrad/Dutch-lite with backtracking
match), and Arena (continuous pairing, streak scoring, fixed duration);
Sonneborn-Berger/Buchholz standings; snapshot persistence (in-memory +
Postgres); a REST API with `tournament_director` authorization; a durable
game launcher (deterministic game ids, idempotent per
`(tournamentId, matchId, attempt)`); realtime result recording via PubSub;
live broadcast multiplexing + `GET /v1/tournaments/:id/live`; and the
Tournament Commentator AI feature deferred from M8. Full FIDE Dutch pairing
remains deferred (ADR-0015).

## ⬜ Milestone 10 — Social & learning

Teams/communities, forums, messaging, friends/followers, achievements; lessons,
courses, video library, PGN import, studies (collaborative), opening/endgame
encyclopedias, master game explorer. **GraphQL read layer** introduced here (and
extended in M11) for the nested, client-driven reads these features need.

## 🚧 Milestone 11 — Search

Keyword + semantic (pgvector/Meilisearch) over games, openings, players, studies;
natural-language query parsing.

- **Increment 1 complete (ADR-0049):** pure-domain keyword search core (`@chess-platform/search`): `tokenize`, `parseSearchQuery` (terms, phrases, `[-]field:value` filters), and in-memory `search` AND matcher + ranker.
- **Increment 2 complete (ADR-0050):** `SearchRepository` port + in-memory paginated adapter (`InMemorySearchRepository`, `SearchOptions`, `SearchPage`).
- **Increment 3 complete (ADR-0051):** natural-language query normalization (`parseNaturalQuery`, `NATURAL_VOCABULARY`, `NATURAL_STOP_WORDS`).
- **Increment 4 complete (ADR-0052):** async `SearchRepository` port (`Promise`-returning signatures) enabling I/O-backed adapters (Postgres full-text search) to implement the interface.
- **Increment 5 complete (ADR-0053):** Postgres full-text adapter `PgSearchRepository` in `@chess-platform/persistence` (`/pg` subpath) + migration `0013_search_documents.sql` (`tsvector` 'simple' column + GIN index, jsonb field filters, parameterized SQL queries, `ts_rank` scoring).




## 🚧 Milestone 12 — Security hardening & anti-cheat

Engine-correlation scoring, bot detection, fraud/DDoS, audit, pen-test pass.

**Increments 1–3 complete:** CORS policy + security response headers
(ADR-0011), httpOnly refresh-token cookie (ADR-0012), rate limiting for
sensitive auth endpoints with a durable Postgres bucket store (ADR-0013).
**Anti-cheat Increments 1–7 complete:** pure domain engine-correlation scoring (ADR-0029), per-player account-level aggregation (ADR-0030), `EngineBackedEvaluator` adapter (ADR-0031), `AntiCheatService`/`AntiCheatReportRepository` ports (ADR-0032), Postgres persistence with atomic `saveBatch` transactions and read-only moderation REST API (ADR-0033), on-demand analysis-trigger pipeline (ADR-0034), and automated auto-analysis worker (ADR-0035).
**Bot Detection Increments 1–6 complete:** pure domain behavioral move-time analyzer (ADR-0036), cross-game behavioral aggregation (ADR-0037), move-timing extraction (ADR-0038), service + report repository (ADR-0039), Postgres persistence + moderation REST API (ADR-0040), and automatic auto-analysis worker + gateway hosting (ADR-0041). Bot detection is now feature-complete; the pen-test pass remains.
**Anti-Cheat Correctness Hardening complete (ADR-0042):** engine-correlation correctness follow-ups landed (identical white/black player ID guard in `AntiCheatService.analyzeAndStore` and deterministic `listByPlayer` ordering via `game_id` tie-breaker + migration `0012`).
**Anti-Cheat Increment 8 complete (ADR-0043):** anti-cheat auto-analyzer gateway hosting with a real engine landed (`createEngineProviderFromEnv`, `createEngineBackedAnalysisService`, `serve.ts` `ANTICHEAT_AUTO_ANALYZE=1` hosting block and graceful engine shutdown). Anti-cheat is now fully production-hostable end-to-end.



## 🚧 Milestone 13 — Observability & SRE

OpenTelemetry, Prometheus, Grafana, alerting, SLOs, runbooks, chaos tests.
- **Increment 1 complete (ADR-0028):** Zero-dependency `Logger` (`JsonLogger`) & `Metrics` (`InMemoryMetrics`) ports, Prometheus text exposition (`GET /v1/metrics`), W3C `traceparent` parsing, bounded HTTP route metric labels, PII redaction.
- **Increment 2 complete (ADR-0045):** Dependency-free `Tracer` / `Span` port (`NullTracer`, `RecordingTracer`, `InMemorySpanRecorder`), `http.server` span emission in `router.ts`, `alwaysOnSampler` and `probabilitySampler`, outbound W3C `traceparent` header propagation, and structured log span emission in production.
- **Increment 3 complete (ADR-0046):** `SpanExporter` seam, `LoggingSpanExporter`, `MultiSpanExporter` composite fan-out, pure `toResourceSpans` OTLP/JSON mapping, `OtlpJsonSpanExporter` with `SpanTransport`, `OTEL_EXPORTER_OTLP_ENDPOINT` environment gate, and `FetchSpanTransport` boundary adapter.
- **Increment 4 complete (ADR-0047):** `BatchSpanProcessor` decorator buffering finished spans and exporting in batches (`maxQueueSize = 2048`, `maxExportBatchSize = 512`, 5s flush delay), `Scheduler` seam with unref'd `intervalScheduler` default, bounded queue with oldest-drop policy and drop counter, wrapping OTLP exporter in bootstrap.
- **Increment 5 complete (ADR-0048):** Span-export pipeline self-instrumentation (`BatchSpanProcessor` emits `span_export_received_total`, `span_export_dropped_total`, `span_export_exported_total`, and `span_export_batches_total` counters to `InMemoryMetrics` for scraping at `GET /v1/metrics`).

## 🚧 Milestone 14 — Deployment & scale

Docker, Kubernetes, Terraform, GitHub Actions, blue/green + canary, rollback,
secrets management, 100k-user load + chaos validation.

### Increment 1: Local runnable stack 🚧

`docker compose up` brings the entire platform live on a developer's machine
with real Postgres, API, WebSocket gateway, and web frontend — the first time
the services run together as an integrated system.

- **Postgres 16** (compose) with schema auto-migrated on API startup via the
  existing `@chess-platform/persistence` migration runner.
- **API service** — multi-stage Dockerfile building and running the API
  against Postgres via `api/src/bootstrap.ts` (the real, non-fake composition
  root). Config via env vars (`DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `PORT`).
- **Gateway service** — multi-stage Dockerfile running a WebSocket server
  wrapping `RealtimeGateway`, with shared-secret token verification (the
  `TokenVerifier` port from ADR-0004) using the same `ACCESS_TOKEN_SECRET`
  as the API. In-memory pub/sub for single-node; Redis pub/sub is a later
  increment. ADR-0007 records this decision.
- **Web service** — multi-stage Dockerfile building the SPA with `vite build`
  and serving via nginx, with proxies for `/v1` → API and `/ws` → gateway.
- **`docker-compose.yml`** at the repo root with health-gated startup
  (`depends_on` + healthchecks: Postgres → API → gateway → web).
- **12-factor config:** everything via env vars, `.env.example` documents them,
  no secrets committed.
- **Smoke test** (`scripts/smoke-test.mjs`): waits for health, registers a
  user over the real API, creates a seek, opens a WS connection with the auth
  token, and confirms the token is verified — proving the stack actually
  serves end-to-end.
- **`docs/RUNNING.md`** documents the one-command flow and env vars.
- **Acceptance criteria:**
  - `docker compose up` from a clean checkout brings the full stack live;
    `docs/RUNNING.md` documents the flow.
  - Smoke test proves the stack serves: health, register, seek, WS auth.
  - Existing 8-package test suite passes unchanged (clean-tree verification).
  - No secrets in the repo; `.env.example` only.
  - ADR-0007 records the shared-secret token verification and single-node
    pub/sub decisions.
  - ROADMAP updated; M14 marked 🚧.

### Increment 2: Durable game authority (EventLog port + Postgres) ✅

The game authority persists and rehydrates game state exactly from its event
log via a durable `EventLog` port, with a Postgres adapter in the service layer
— mirroring the `EventStore`/`persistence` pattern. The domain package stays
dependency-free; the Postgres binding lives in the deployable service.

### Increment 3: Redis pub/sub for multi-node fanout ✅

`RedisPubSub` adapter implements the existing `PubSub` interface, backed by
Redis pub/sub for cross-node broadcast fanout. Key design:

- **Two Redis connections**: one for SUBSCRIBE (blocked), one for PUBLISH
  (Redis protocol requirement).
- **Origin node-id tagging + self-delivery skip**: each published message
  carries the publishing node's id; nodes skip their own messages to prevent
  double-fanout.
- **Ref-counted subscribe/unsubscribe**: one Redis SUBSCRIBE per channel per
  node, regardless of how many local subscribers the node has.
- **`RedisLike` interface in the domain package**: the `realtime-gateway`
  package depends only on a minimal `RedisLike` abstraction — the concrete
  `ioredis` binding lives in `services/gateway/src/redis-pubsub.ts` (the
  infrastructure seam, not the dependency-free domain package).
- **`REDIS_URL` env gate**: when set, the gateway uses `RedisPubSub`; when
  absent, falls back to `InMemoryPubSub` (single-node). Zero-config local dev
  preserved.
- **Docker Compose**: Redis 7 service with healthcheck and AOF persistence.
- **9 hermetic tests** using a `FakeRedis` bus: cross-node delivery,
  self-delivery skip, ref-counted subscribe/unsubscribe, multi-channel
  independence, subscriberCount, close cleanup, three-node fanout, malformed
  payload safety.
- ADR-0008 records the decision.

### Increment 4: Kubernetes manifests + Helm chart ✅

Package the existing stack (postgres, redis, api, gateway, web) as a Helm chart
so it deploys to a Kubernetes cluster — the next step after docker-compose. This
is infrastructure/packaging: no application source changes.

- **`deploy/helm/gambit/`** Helm chart with `Chart.yaml`, `values.yaml`, and
  templates for api (Deployment + Service + migration init container), gateway
  (Deployment replicas=1 + Service, WS port + health port), web (Deployment +
  Service + Ingress), and bundled postgres + redis as StatefulSets with PVCs.
- **Bundled vs. external datastores:** postgres + redis are gated behind
  `postgres.enabled` / `redis.enabled` (default true for self-contained install
  / kind). When disabled, `DATABASE_URL` / `REDIS_URL` come from
  `externalDatabaseUrl` / `externalRedisUrl` values.
- **Config split:** ConfigMap for non-secret env (PORT, HOST, NODE_ENV, ports),
  Secret for `ACCESS_TOKEN_SECRET` + `POSTGRES_PASSWORD`. No real secrets
  committed — placeholder defaults with `helm --set` / external-secrets note.
- **Gateway replica constraint (as shipped in inc 4; superseded by inc 5):** at
  inc 4 the gateway Deployment defaulted to `replicas: 1` and could not be scaled
  beyond 1 without sticky per-game routing or sharded authority, because
  game-command ownership was not coordinated across replicas. **Increment 5**
  lifted this: a Redis-based ownership registry + command forwarding (ADR-0010)
  now coordinates ownership across replicas, so the gateway defaults to
  `replicas: 2` (`REDIS_URL` required when > 1). The api and web are stateless and
  default to 2 replicas.
- **NODE_ID via downward API:** the gateway's `NODE_ID` is the pod name via
  `fieldRef: metadata.name`, mirroring compose's `NODE_ID: gateway-${HOSTNAME}`.
- **Migrations as init container:** the API runs
  `npm run migrate --workspace @chess-platform/persistence` in an init container
  before starting. The gateway's init container waits for the API health endpoint.
- **Liveness/readiness probes** hitting existing health endpoints (api
  `GET /v1/health`, gateway `GET :{PORT+1}/health`, web `GET /`).
- **CI job** added to `.github/workflows/ci.yml`: `helm lint` +
  `helm template | kubeconform` for both default and external-datastore values.
- **Snapshot test** (`scripts/helm-snapshot-test.sh`): verifies gateway
  replicas == 1, api+gateway share the same DATABASE_URL source, gateway gets
  REDIS_URL + NODE_ID from pod name, secrets come from the Secret.
- **Docs:** `docs/DEPLOYING.md` (Helm install flow, values, single-gateway-
  replica constraint), `docs/adr/0009-kubernetes-helm.md` (topology decisions).
- **Acceptance criteria:**
  - `helm lint deploy/helm/gambit` passes.
  - `helm template deploy/helm/gambit` renders for both default and
    external-datastore override.
  - Every rendered manifest validates with `kubeconform -strict` (zero invalid).
  - Snapshot test proves key wiring (gateway replicas, shared DATABASE_URL,
    REDIS_URL + NODE_ID, secrets from Secret).
  - CI job added; existing jobs intact.
  - Existing app gate stays green (no source changes).
  - ADR-0009 records the topology decisions.
  - ROADMAP + PROJECT_STATE updated.

### Increment 5: Safe horizontal scaling for WebSocket gateway (ADR-0010) ✅

Redis-based ownership registry and command forwarding allowing gateway scaling (`replicas: 2`).

### Increment 6: External-secrets integration (ADR-0044) ✅

External Secrets Operator (`external-secrets.io/v1`) integration for the Gambit Helm chart.
Renders an `ExternalSecret` custom resource syncing `ACCESS_TOKEN_SECRET` and `POSTGRES_PASSWORD` from a backing SecretStore / ClusterSecretStore.

### Deferred (later M14 increments)

- Terraform IaC for cloud provisioning
- Blue/green + canary deployment strategy
- GitHub Actions CI/CD pipeline with deploy gates
- 100k-user load testing + chaos validation
- Sharded game authority with durable state
- Sticky per-game routing for horizontal gateway scaling

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

