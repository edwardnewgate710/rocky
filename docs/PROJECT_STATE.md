# Gambit — Project State (Engineering Handover)

> Living handover document. Anyone (human or AI) joining the project should be able
> to read **only this file** and continue immediately. Updated after every
> milestone and every significant architectural step.

_Last updated: 2026-08-04 — M14 Increment 18: Direct Messaging UI (ADR-0085)._

## M14 Increment 18 — Direct Messaging UI (ADR-0085)

Exposes the direct messaging backend (M10) in the web frontend with an inbox, conversation thread view with message sending, and profile entry point.

- **Harness Wiring (`packages/e2e-harness/src/harness.ts`, `package.json`)**: Wired `InMemoryMessagingRepository` into `deps.messagingRepository` so `/v1/messages/*` endpoints do not 503 under `GAMBIT_E2E_BACKEND=1`. Added `"@chess-platform/messaging": "file:../messaging"` dependency to `e2e-harness/package.json`.
- **Types & Client (`packages/web/src/api/models.ts`, `client.ts`)**: Added `ConversationView`, `MessageView`, `ConversationSummary`, `ConversationList`, `MessageList`, and `ConversationReadState`. Added `MessagesApi` class with `listConversations`, `messages`, `send`, `markRead`, and `openWith` methods (all `auth: true`).
- **Controller & Pure Helpers (`packages/web/src/app/messages-controller.ts`, `messages-helpers.ts`)**: Built DOM-free `MessagesController` with `requestGeneration` stale-response guard, open thread polling interval (5000ms), `markRead` call on thread load (quiet failure), single-batch player handle hydration (`client.graphql.resolvePlayers(ids)`), and pure helpers for participant derivation and tombstone rendering.
- **Views (`packages/web/src/app/messages-view.ts`)**: Pure DOM render helpers (`renderInbox`, `renderThread`) using `.panel-row` inside `.panel-list` (without `role="list"`), tombstone placeholder rendering (`"[Message deleted]"`), escaped text nodes, and `renderEmpty` states.
- **Routing, Profile & Wiring (`packages/web/src/app/router.ts`, `bootstrap.ts`, `main.ts`, `index.html`)**: Added `/messages` and `/messages/:id` routes, nav link, `#messages` and `#conversation` sections with `aria-label`s and `role="alert"` errors, composer `<form>` with `.sr-only` label, profile "Message" action calling `openWith` + SPA navigation, and controller disposal in `main.ts`.
- **Styles (`packages/web/src/style.css`)**: Added CSS rules for messaging layout, message thread items, own-message styling, composer input, and coarse-pointer touch targets according to DESIGN.md.
- **Tests & ADR**: Unit tests in `packages/web/test/messages.test.ts`, client tests in `packages/web/test/api-client.test.ts`, a11y tests in `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/messages.spec.ts`, and architectural record in `docs/adr/0085-direct-messaging-ui.md`.

Prior: _Last updated: 2026-08-04 — M14 Increment 17: Playwright E2E suite stability & per-game bot RNG (ADR-0084)._

## M14 Increment 17 — Playwright E2E suite stability & per-game bot RNG (ADR-0084)

Stabilizes local E2E testing by introducing a worker concurrency ceiling and ensures bot move choice determinism across concurrent games.

- **Worker Concurrency Ceiling (`packages/web/playwright.config.ts`)**: Added `workers: Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))` to clamp worker parallelism on high-core machines. Resolves severe resource contention against the single shared `e2e-harness` process and Vite preview server (which caused global test flakiness ranging from 638ms to 200,621ms on static specs).
- **Per-Game Bot RNG (`packages/e2e-harness/src/rng.ts`, `packages/e2e-harness/src/bot.ts`)**: Added `seedFrom(seed, key)` FNV-1a helper in `rng.ts` and updated `BotPlayer` in `bot.ts` to derive a dedicated RNG stream for each registered game using `createRng(seedFrom(this.seed, gameId))`. Move selection is now isolated per game ID and no longer depends on interleaved message timing under concurrency.
- **Unit Tests (`packages/e2e-harness/test/bot.test.ts`)**: Added unit tests proving that interleaved games do not perturb each other's move sequences and that different game IDs generate distinct move streams. The stubs build real `StateView` and `ApplyResult` values with no `any`; the authority stub is still cast at the construction site (`as unknown as GameAuthority`) because `GameAuthority` is a class and the bot only calls two of its members. The interleaving test was run against the previous shared-RNG implementation and fails there, so it demonstrably catches the defect it describes.
- **Documentation & ADR**: Recorded findings, benchmarks, timing rationale, and scope bounds in `docs/adr/0084-e2e-worker-cap.md` and updated `docs/ROADMAP.md` follow-ups.

Prior: _Last updated: 2026-08-03 — M14 Increment 16: Search UI (ADR-0083)._

## M14 Increment 16 — Search UI (ADR-0083)

Exposes the search backend (M11) in the web frontend with a dedicated search interface, header search bar, mode selector, and per-result hydration.

- **Types (`packages/web/src/api/models.ts`)**: Added `SearchMode` (`'keyword' | 'semantic' | 'hybrid'`), `SearchResult` (`{ id, score }`), and `SearchResults` (`{ total, results }`).
- **Client (`packages/web/src/api/client.ts`)**: Added `SearchApi` class exposed as `readonly search` on `GambitClient` with `query({ q, mode, limit, offset })` method (`auth: 'optional'`).
- **Pure Helpers (`packages/web/src/app/search-results.ts`)**: Created `parseSearchHit` (splitting namespaced entity IDs `game:<uuid>`, `player:<uuid>`, `tournament:<uuid>` on first colon without throwing on unknown/unprefixed IDs), `parseSearchMode`, and `HydratedHit` interface.
- **Controller (`packages/web/src/app/search-controller.ts`)**: Built DOM-free `SearchController` with `requestGeneration` stale-response guard, parallel `Promise.all` hydration of tournaments and games, and single-batch player ID resolution (`client.graphql.resolvePlayers(ids)`), with per-row `shortId` fallbacks for failed hydrations.
- **Views (`packages/web/src/app/search-view.ts`)**: Pure DOM render helpers (`renderSearchResults`, `renderSearchPrompt`) using `.panel-row` inside `.panel-list` (without `role="list"`), entity type labels, resolved names, links for valid `href`s, and `renderEmpty` prompt/empty states.
- **Routing & Wiring (`packages/web/src/app/router.ts`, `bootstrap.ts`, `main.ts`, `index.html`)**: Added `/search` route, header search form with `role="search"`, `#search` section with mode selector (`.cg-seg` segmented control), SPA pushState+popstate navigation, and controller disposal lifecycle in `main.ts`.
- **Styles (`packages/web/src/style.css`)**: Added styles for `.nav-search`, `.search`, and `.sr-only` complying with DESIGN.md tokens and 320px responsiveness.
- **Tests & ADR**: Unit tests in `packages/web/test/search-results.test.ts`, updated `packages/web/test/api-client.test.ts`, `packages/web/test/tournament-routes.test.ts`, and `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/search.spec.ts`, and architectural record in `docs/adr/0083-search-ui.md`.
- **Deferred (search API enrichment)**: `GET /v1/search` returns `{ id, score }` only, so every result row costs a second call to resolve its display metadata. ADR-0083 §2 records the gap; the mitigations shipped are page size 10, parallel entity fetches, and one batched `resolvePlayers`. A response carrying entity type, title and snippet would remove the secondary lookups. The contract is intentionally unchanged in this increment. Tracked under "Known follow-ups (tracked)" in `docs/ROADMAP.md`.
- **Deferred (search test infrastructure)**: the E2E environment indexes no documents, so `packages/web/e2e/search.spec.ts` asserts navigation, deep links, prompt state and history behaviour — never that a query returns hits. ADR-0083 §7 records this. Functional result assertions need fixture indexing in the `e2e-harness` or direct seeding of the search tables; neither exists. Tracked in `docs/ROADMAP.md`.
- **Pre-existing debt observed, not caused, here**: the backend-gated Playwright game/seek specs flake on first attempt and pass on retry. Not introduced by this increment — those specs are untouched by its diff. Tracked in `docs/ROADMAP.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 15: Tournaments UI (read-only) (ADR-0082)._

## M14 Increment 15 — Tournaments UI (read-only) (ADR-0082)

Exposes the tournament system (M9) in the web frontend with a read-only interface for listing tournaments, viewing tournament details, standings, and live games broadcast.

- **Types (`packages/web/src/api/models.ts`)**: Added `TournamentFormat`, `TournamentState`, `TournamentSummary`, `TournamentDetail` (discriminated union on `format`: `ArenaTournamentDetail` | `SwissOrRoundRobinTournamentDetail`), `TournamentStanding` (union: `ArenaStanding` | `SwissOrRoundRobinStanding`), `TournamentLiveBoard`, and `TournamentLive`.
- **Client (`packages/web/src/api/client.ts`)**: Added `TournamentsApi` class beside `SeeksApi` and exposed `readonly tournaments: TournamentsApi` on `GambitClient`. Four methods (`list`, `byId`, `standings`, `live`), all `auth: 'optional'`.
- **Controller (`packages/web/src/app/tournament-controller.ts`)**: Pure DOM-free controller mirroring `ProfileController`'s `requestGeneration` stale-response guard and `LobbyController`'s injectable timer (`setInterval`/`clearInterval`). Manages `loadList`, `loadDetail` (branches on `detail.state === 'running'` to call `live` instead of redundant `/standings`), `startLive`, `stopLive`, `dispose`. Resolves player IDs using `client.graphql.resolvePlayers(ids)`.
- **Rendering (`packages/web/src/app/tournament-view.ts`, `packages/web/src/app/render-helpers.ts`)**: Pure DOM render functions (`renderTournamentList`, `renderTournamentDetail`, `renderStandings`, `renderLiveBoards`). Uses `.panel-row` rows inside `.panel-list`, extracted shared render helpers into `render-helpers.ts` to avoid circular dependencies, player names resolved with fallback to `shortId(id)`, links to `/tournaments/:id` and `/game/:gameId`, and format-specific standing column rendering ("Tiebreak", "🔥 On fire").
- **Routing & Markup (`packages/web/src/app/router.ts`, `index.html`)**: Added `/tournaments` and `/tournaments/:id` to `Route` union, `parseRoute`, and `routeToPath`. Added nav link and `#tournaments` / `#tournament` sections with proper `aria-label`s and `role="alert"` error elements (without `role="list"` on list containers).
- **Wiring & Styles (`packages/web/src/app/bootstrap.ts`, `style.css`)**: Exported `renderEmpty`, `formatClock`, `formatTimeControl`, `EmptyStateOptions` from `render-helpers.ts`. Wired section visibility (`showTournaments`/`showTournament`), heading update on detail load, and route handlers in `bootstrap.ts`. Added section layout styles in `style.css` matching design scale.
- **Tests & ADR**: Added `packages/web/test/tournament-routes.test.ts`, updated `packages/web/test/api-client.test.ts` and `packages/web/test/a11y.test.ts`, added Playwright E2E spec `packages/web/e2e/tournaments.spec.ts`. Documented design decisions in `docs/adr/0082-tournaments-ui.md` and updated `docs/ROADMAP.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 14: "Play vs Computer" in the Gambit lobby (frontend only) (ADR-0081)._

## M14 Increment 14 — "Play vs Computer" in the Gambit lobby (frontend only) (ADR-0081)

Adds a frontend UI dialog in the Gambit lobby for starting unrated games against engine computer opponents.

- **Types (`packages/web/src/api/models.ts`)**: Added `BotLevel` (`'novice' | 'club' | 'master'`) and `CreateBotGameRequest` (`level`, `variant`, `timeControl`, `color?`).
- **Client (`packages/web/src/api/client.ts`)**: Added `createVsBot(body: CreateBotGameRequest): Promise<GameSummary>` method to `GamesApi` (`POST /v1/games/bot`, `auth: true`).
- **Shared DOM Helper (`packages/web/src/app/dom.ts`)**: Extracted `el()` element creation helper from `create-game-panel.ts` into a pure shared module.
- **Pure Module (`packages/web/src/app/bot-levels.ts`)**: Defined `BotLevelOption`, `BOT_LEVELS` array (`novice`, `club`, `master`), `DEFAULT_BOT_LEVEL` (`'club'`), and `parseBotLevel(raw)` function.
- **Dialog Component (`packages/web/src/app/play-bot-dialog.ts`)**: Built native `<dialog>` component (`PlayBotDialog`) with difficulty selection (radios with hints), color choices (`♔`, `½`, `♚`), time control presets from `time-presets.ts`, unrated game notice, submit/cancel actions, error display, and auth gating (`setAuthenticated`, `setPending`).
- **Lobby Controller (`packages/web/src/app/lobby-controller.ts`)**: Added `createBotGame(params)` method calling `this.client.games.createVsBot(...)`, gated by `isAuthenticated`.
- **Wiring & Markup (`packages/web/src/app/bootstrap.ts`, `packages/web/index.html`)**: Added `#play-bot-mount` element in `index.html`. Wired `PlayBotDialog` in `bootstrap.ts` to call `createBotGame` with standard variant and navigate to `/game/${gameId}` on success. Updated auth state handlers for the play-bot button.
- **Styles (`packages/web/src/style.css`)**: Added `.pb-dialog` dialog styling reusing existing selection vocabulary (`.cg-chip`, `.cg-seg`, `.cg-field`, etc.), CSS custom properties, backdrop styling, and responsive layout.
- **Tests & ADR**: Added `packages/web/test/bot-levels.test.ts`, updated `packages/web/test/api-client.test.ts` and `packages/web/test/a11y.test.ts`, added Playwright E2E spec `packages/web/e2e/play-vs-computer.spec.ts`. Created `docs/adr/0081-play-vs-computer-ui.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 13: wire engine bridge into live play ("play vs computer") (ADR-0080)._

## M14 Increment 13 — Wire engine bridge into live play ("play vs computer") (ADR-0080)

Wires `@chess-platform/engine` into live backend play, exposing "play vs computer" against 3 engine bot levels without UI changes.

- **Bot Users DB Seed**: `packages/persistence/migrations/0021_engine_bots.sql` inserts 3 credential-less bot users (`gambit-novice`, `gambit-club`, `gambit-master`) with fixed v7 UUIDs and `flags = '{"bot": true}'::jsonb`. Security property: credentials live in a separate table, so credential-less rows can never authenticate.
- **Bot Catalogue**: `packages/api/src/bot/catalogue.ts` exports `BotLevel`, `BotAccount`, `BOT_ACCOUNTS`, `botAccountByLevel`, `botAccountByUserId`, mapping levels to ELO ratings (`novice` -> 1350, `club` -> 1750, `master` -> 2200). Re-exported via `@chess-platform/api`. Checked in `packages/api/test/bot-catalogue.test.ts`.
- **GameStarter Port**: Defined `GameStarter` in `packages/persistence/src/repositories.ts`, `PgGameStarter` in `packages/persistence/src/pg/repositories.ts` (`BEGIN...COMMIT`, returns `false` on unique violation), `InMemoryGameStarter` in `packages/api/src/fakes.ts`. Added `gameStarter` to `Repositories` interface in `deps.ts`, wired in `bootstrap.ts` and `fakes.ts`. Tested in `bot-game-route.test.ts` and `pg.integration.test.ts`.
- **REST Endpoint**: Added `POST /v1/games/bot` in `packages/api/src/routes.ts` (`AUTHED`). Validates `level`, `variant`, `timeControl`, `color`. Resolves unknown level with 400 listing valid levels. Resolves `color: 'random'` deterministically from hex parity of generated `gameId`. Sets `rated: false` unconditionally. Persists via `gameStarter.start()`, returns 409 conflict on duplicate gameId. Updated `CreateBotGameRequest` in `packages/api/src/openapi/schemas.ts` and `packages/api/openapi.json`.
- **Realtime Gateway Hook**: Added optional `onGameLoaded?: (gameId: string, state: StateView) => void` parameter to `RealtimeGateway` (`packages/realtime-gateway/src/gateway.ts`), guarded against repeat calls per game. Tested in `packages/realtime-gateway/test/gateway.test.ts`.
- **EngineBotMover**: Created `EngineBotMover` in `services/gateway/src/engine-bot.ts`. Executes bot moves via `CommandRouter.route(gameId, botUserId, cmd)` (respecting Redis multi-node sharding per ADR-0010, never `authority.apply`). 300ms think time, `JobPriority.BotMove` (priority 0). Caps in-flight `play()` to 1 per game via `Map<gameId, Promise>`. Safe error handling logs warnings and increments failure counter without crashing process. Emits `gateway_bot_moves_total`, `gateway_bot_move_failures_total`, `gateway_bot_move_seconds`. Tested in `services/gateway/test/engine-bot.test.ts`.
- **Gateway Hosting**: Wired `ENGINE_BOT === '1'` in `services/gateway/src/serve.ts`. Shares single `AnalysisProvider` instance between anti-cheat auto-analyzer and engine bot mover. Passes `onGameLoaded` callback to `RealtimeGateway`. Graceful shutdown calls `engineBotMover.stop()` and `sharedEngineProvider.shutdown()`.
- **Architectural Record**: Created `docs/adr/0080-engine-bot-opponent.md` (Date: 2026-08-03), updated `docs/ROADMAP.md` and `.env.example`/`docs/RUNNING.md`.

Prior: _Last updated: 2026-08-03 — Verification hygiene: an ADR claim-drift guard, and a flaky test that hid its own failure (ADR-0079)._

## Verification hygiene — ADR claim drift + the e2e-harness flake (ADR-0079)

M14 increment 11 found ADR-0010 §7 specifying six ownership metrics that had **never been
implemented** — ownership was unobservable in production for months because prose is not executable.
This closes the mechanical half of that gap.

- **`scripts/check-adr-claims.mjs`** (`npm run check:adr-claims`, wired into CI's `build-test` job)
  fails when an ADR names a repo-relative path, a metric, an `npm run` script, or a sibling ADR that
  does not exist. It is the check that would have caught ADR-0010 §7 on the day it was written.
- **It cannot tell you an ADR is TRUE.** ADR-0010 §6 was a false sentence with no missing identifier;
  only executing the system finds that, which is what ADR-0077's chaos suite is for. Env vars and
  bare filenames were deliberately left unchecked — the regexes match Redis commands and prose, and a
  noisy guard is one people switch off.
- **The audit found the corpus healthy**: 3 stale references across 78 ADRs, two of them created by
  our own ADR-0075 `nginx.conf` → `nginx.conf.template` rename. This is regression prevention, not
  cleanup, and the ADR says so rather than overselling it.
- **The e2e-harness flake is fixed by construction, not by luck.** The bot's `resignAfterPlies` lever
  (which the harness already had, and its own header calls a "determinism lever") is now set, bounding
  the game to 12–14 moves against a 300-move valve. Seeding the move choice removes one source of
  variance but was **not sufficient on its own** — seeded, the game still ran 109/155/186 moves across
  three runs, and that measurement is recorded beside the seed. 10 consecutive runs: 10 passed.
- The same failure also **hung the test file for 178s**, presenting as a frozen suite with the same
  signature as the known port-4175 conflict — which is how a real failure sends the next person down
  the wrong path entirely.

Prior: _Last updated: 2026-08-03 — M14 Increment 12: local owner lease tracking & fail-closed fast path (ADR-0078)._

## M14 Increment 12 — Local owner lease tracking & fail-closed fast path (ADR-0078)

### Eliminating the Redis round-trip on owner command routing

- **Local lease tracking in `OwnershipRegistry`**: Records monotonic expiration (`performance.now() + leaseTtlSec * 1000`) on successful claims and renewals. Renewals update expiry only when successful; failed renewals do not advance expiry.
- **Fast path in `RedisCommandRouter.route()`**: If `holdsValidLease(gameId)` is true, commands are processed locally immediately without calling `claim()` against Redis, skipping Redis network latency and avoiding total platform halt when Redis is unavailable.
- **Fail-closed safety property**: Derives conservative `safetyMarginMs` from `leaseTtlSec` and `renewalIntervalSec`. Closes the fast path before the Redis key expires in Redis, ensuring zero split-brain overlap. When Redis is down, renewals fail, the lease ages out, fast path closes, and fallback `claim()` rejects commands (failing closed).
- **Gateway observability metrics**: Added `gateway_ownership_renewal_failures_total` (counter) and `gateway_fast_path_commands_total` (counter). Registered in `serve.ts` and validated with `npm run check:observability`.
- **Chaos test suite & ADR-0010 §6 resolution**: Adjusted chaos suite `OWNERSHIP_LEASE_TTL_SEC=6` and `OWNERSHIP_RENEWAL_INTERVAL_SEC=2` in `docker-compose.chaos.yml`. Scenario D now asserts owner moves succeed during a Redis outage (inside lease window) and fail closed after lease expiry. Resolved `CONTRA-ADR FINDING` and cleared `KNOWN_OPEN_DEFECTS` (suite passes with exit 0).
- Detailed in `docs/adr/0078-owner-lease-fast-path.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 11: chaos & failover validation of multi-node game authority (ADR-0077)._

## M14 Increment 11 — Chaos & failover validation of multi-node game authority (ADR-0077)

### It found a real bug on its first honest run

**A node taking over a game validated commands against a stale aggregate**, so the surviving node
rejected a legal move (`not_your_turn`) after the owner was SIGKILLed — with the durable log proving
the move legal. Pub/sub delivers an owner's moves to *rooms*, never to the other node's authority, so
node 2's copy sat at ply 0 while the game advanced. This is the exact stale-authority failure ADR-0010
exists to prevent, reappearing at failover; `FakeRedis` single-process tests could not see it because
there is no second node holding a stale copy.

Fixed in `RedisCommandRouter`: a game is marked stale when `onClaimed` fires (which happens only on a
genuine ownership transition) and is evicted and rehydrated from the event log on the async command
path before `apply()`. Evicting inside the hook is not possible (it is synchronous, rehydration is
not) and evicting without reloading turns the rejection into `unknown_game` — both wrong turns were
taken and caught by this suite before the fix landed.

**Still open (reported, not papered over):** ADR-0010 §6 claims the owner can process its own commands
while Redis is down. It cannot — `route()` calls `claim()` on every command. Scenario D prints this as
a CONTRA-ADR finding instead of asserting the ADR's text.

### Multi-node gateway chaos test suite & observability

- **Observability metrics implementation**: Built the missing gateway metrics specified in ADR-0010 §7 using the existing `Metrics` port (`@chess-platform/api`): `gateway_owned_games` (gauge), `gateway_forwarded_commands_total` (counter), `gateway_forward_timeouts_total` (counter), `gateway_ownership_claims_total` (counter), `gateway_ownership_releases_total` (counter), and `gateway_forward_latency_seconds` (histogram with buckets `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]`). Updated `/health` to expose `ownedGames` count and `ownershipRegistry: 'redis' | 'local'`. Verified against `scripts/check-observability-drift.mjs` (0 errors).
- **Two-node stack override (`docker-compose.chaos.yml`)**: Added a second gateway replica (`gateway-node2`, WS port 4177, health port 4178) alongside `gateway` (WS port 4175, health port 4176), sharing Postgres, Redis, and API containers. Shortened lease TTL (`OWNERSHIP_LEASE_TTL_SEC=3`, `OWNERSHIP_RENEWAL_INTERVAL_SEC=1`) on both nodes to make failover fast and observable. Pinned `TOURNAMENT_REPORTER: "0"` and `SEARCH_INDEXER: "0"` on node 2 so exactly one instance of each runs across the stack.
- **Automated chaos test suite (`scripts/chaos-test.mjs`)**: Plain Node ESM script verifying 4 core scenarios against the real stack:
  1. *Cross-node correctness*: Two players on different gateway nodes play alternating moves; verified zero move rejections, matching position FEN hashes, and non-owner command forwarding metric increments.
  2. *Ungraceful owner loss*: SIGKILL (`docker kill`) owner container; verified surviving node claims ownership after 3s lease TTL expiry + margin, play continues cleanly, and no move is lost or duplicated.
  3. *Graceful drain*: SIGTERM (`docker stop`) owner container; verified `releaseAll()` compare-and-delete executes and successor node claims ownership immediately (< 1.5s), measurably faster than lease TTL expiry.
  4. *Redis loss & recovery*: Stop Redis (`docker stop redis`); verified non-owner command forwarding fails, identified finding that owner node commands also fail because `RedisCommandRouter.route()` evaluates `registry.claim()` on every route; verified full recovery when Redis returns.
- **Opt-in CI workflow (`.github/workflows/chaos.yml`)**: `workflow_dispatch`-only workflow running the chaos test suite on demand without burning per-PR CI minutes.
- **Stale ROADMAP corrections**: Updated M14 deferred list in `docs/ROADMAP.md` to accurately reflect that sticky routing was evaluated and rejected in ADR-0010 (retained only as optional load balancing optimization) and that single-owner authority with Redis registry and command forwarding is implemented (what is deferred is dedicated authority shards).
- Detailed in `docs/adr/0077-chaos-failover-validation.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 10: deploy-gated CI/CD pipeline, pre-flight template validation, and release/deploy workflows (ADR-0076)._

## M14 Increment 10 — Deploy-gated CI/CD pipeline (ADR-0076)

### Automated release & deploy workflows

- **Tag-triggered release workflow (`.github/workflows/release.yml`)**: Triggered on `v*` tag pushes. Runs full verification (`npm ci`, `npm run build`, `npm test`, `npm run lint`), validates that tag version matches `deploy/helm/gambit/Chart.yaml` `appVersion`, and builds + pushes three images (`api`, `gateway`, `web`) to GHCR using `docker/build-push-action@v5`. Images are tagged with exact version and commit SHA (`latest` is never published or deployed).
- **Gated deployment workflow (`.github/workflows/deploy.yml`)**: Triggered via `workflow_dispatch` or `release: [published]`. Enforces human-approval gates via GitHub `environment:` (staging/production), queues deploys sequentially per environment (`concurrency: group: deploy-${env}, cancel-in-progress: false`), verifies image existence in GHCR with error output capture, runs a pre-flight `helm template` dry-run validation using exact composed strategy arguments, applies `deploy/environments/<env>.values.yaml`, and executes `helm upgrade` with `--atomic`, `--wait`, and explicit `--timeout 5m0s`. Blue/green is expressed as two runs via `target_color` (the colour receiving this version) and `active_color` (the colour serving traffic afterwards): unequal stages the version on the standby for preview, equal cuts over. It sets only `rollout.blueGreen.colors.<target_color>.tag=$VERSION` — never `images.api.tag`/`images.web.tag`, which the other colour falls back to as its rollback target, and which if overridden make both colours resolve to the same image and the chart refuse to render. `images.gateway.tag` moves on the cutover only, since the gateway is not colour-versioned. A blue/green initial install is refused: there is no published baseline for the standby and nothing to roll back to. Rollback is split three ways: `--atomic` reverts a failed upgrade; an explicit step covers verification failing *after* a successful upgrade, rolling back to the revision recorded before the upgrade; and when that revision cannot be determined for a release that demonstrably existed, the step refuses to act and calls for an operator rather than guessing. Uses explicit `require('node:fs')` in Node history parsing scripts.
- **Environment values files (`deploy/environments/{staging,production}.values.yaml`)**: Checked-in per-environment values files passing non-secret overrides and baseline image tags for blue/green rollback targets. Credentials are referenced via `secrets.existingSecret` or ESO integration (ADR-0044).
- **Deployment gate guard (`scripts/check-deploy-gates.mjs`)**: Plain Node ESM script (`npm run check:deploy-gates`) asserting 8 workflow invariants (environment approval gate, non-cancelling queueing concurrency, atomic helm flags, `needs:` job gating, shared helper for no `:latest` tags, release image repository alignment with `values.yaml`, no hardcoded Deployment names — which vary by rollout strategy, ADR-0075, and pre-flight `helm template` validation before `helm upgrade`). Each invariant was mutation-tested by reintroducing the defect it covers and confirming the guard fails. Wired into `.github/workflows/ci.yml` under the `helm` job.
- **Workflow flag composition snapshot tests (`scripts/helm-snapshot-test.sh`)**: Added strategy flag composition snapshot tests for `rolling`, `blueGreen`, and `canary` to ensure workflow argument composition renders cleanly.
- **Image repository reconciliation**: Reconciled `deploy/helm/gambit/values.yaml` image references to `ghcr.io/senasehs19-oss/gambit-{api,gateway,web}` matching published repositories.
- **Honest status**: No physical cluster is connected to this repository, so the deployment execution path itself is unexercised in CI. The pipeline's gate structure, concurrency controls, atomic flags, strategy flag compositions, and image repository alignment are statically verified by `check-deploy-gates.mjs` and `helm-snapshot-test.sh`.
- Detailed in `docs/adr/0076-deploy-pipeline.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 9: blue/green + canary delivery, and the web proxy repair it uncovered (ADR-0075)._

## M14 Increment 9 — Blue/green + canary delivery (ADR-0075)

### The web tier had never worked in Kubernetes

`docker/web/nginx.conf` hardcoded its upstreams as the **compose** service names (`proxy_pass
http://api:8080`). The Helm chart names Services after the release (`release-name-gambit-api`), and
nginx resolves an upstream literal when it loads its config — not per request. So the web pod exited
with `[emerg] host not found in upstream "api"` before it ever listened, taking the SPA, `/v1` and
`/ws` with it, since all three arrive through that proxy. Reproduced directly against the built
image before the fix, and again after.

No gate saw it: CI proves the manifests are schema-valid and that the image builds, and neither runs
the image against the manifests. This is the third instance of one failure mode — a hand-maintained
copy of a name that lives somewhere else (see M14 inc 8's Dockerfile build order, and the runtime
`COPY` list before it).

`docker/web/nginx.conf` is now `docker/web/nginx.conf.template`, rendered by the nginx image's
envsubst entrypoint from `API_UPSTREAM` / `GATEWAY_UPSTREAM`. `Dockerfile.web` sets the compose names
as ENV defaults (so `docker compose up` is unchanged) and the chart injects the release-prefixed
Service names. `NGINX_ENVSUBST_FILTER` restricts substitution to those two variables so envsubst
cannot rewrite nginx's own `$host` / `$uri` / `$scheme`.

### Progressive delivery

- **`rollout.strategy`**: `rolling` (the unchanged default — the default render is byte-identical to
  the previous chart apart from the upstream fix), `blueGreen`, or `canary`. Applies to **api and
  web only**.
- **Blue/green**: both colors render as separate Deployments; the primary Service selects
  `gambit.dev/color: <activeColor>`. The cutover and the rollback are the same one-value upgrade and
  neither restarts a pod or pulls an image. The standby has its own Service and preview hostname so
  the incoming version can be exercised against production dependencies first.
- **Canary**: a second track behind ingress-nginx's `canary`/`canary-weight` annotations — real
  percentage routing rather than a replica ratio, which would quantise the smallest possible canary
  at 33% with two stable pods and couple the traffic decision to the capacity decision. Optional
  `canary-by-header` for deterministic opt-in; weight 0 is valid (staged, header-only).
- **Version pairing**: the api and web variant lists are parallel, so each web pod's `API_UPSTREAM`
  addresses the api variant of its own version. A canary cohort gets the canary frontend *and* the
  canary API. This is only expressible because of the upstream fix above.
- **Exclusions, deliberate**: the gateway keeps its rolling update (a flip severs every live
  WebSocket connection, and game-command ownership per ADR-0010 is keyed by game, not version — two
  versions would both be legitimate owners), and the search indexer stays pinned at one replica.
- **Fail-closed**: unknown strategy, `activeColor` outside blue/green, a preview color with no tag of
  its own, a canary with no tag, a canary with no Ingress, and a weight outside 0–100 all fail the
  render.
- **Standing constraint**: both strategies run two API versions against one database, so migrations
  in such a release must be backward compatible with the version still serving (expand/contract).
  Concurrent migration runs are already safe — `migrate()` holds a database-wide advisory lock.

### What the tests caught

32 new assertions in `scripts/helm-snapshot-test.sh` (82 total, all passing). Four real defects were
caught before merge, each by a different reviewer:

- **The flip-invariance assertion** — *a flip changes no Deployment name, image or replica count* —
  failed on the first draft: the standby was sized at `preview.replicas: 1`, so the cutover would
  have moved all production traffic onto a single pod and scaled up afterwards. The standby now
  matches the active color's count.
- **clean-code-guard** found the preview hostname and the Ingress TLS stanza duplicated across three
  Ingresses (now `gambit.previewHost` / `gambit.ingressTls`), and that `default` swallowed a
  deliberate `preview.replicas: 0`, silently giving a staged standby full capacity.
- **Qodo (2)** found that requiring an explicit tag on the *standby* color while the active one fell
  back to `images.<component>.tag` meant a release configured with only the incoming tag rendered
  fine and then failed to render **at the moment of the flip** — the newly-inactive color having no
  tag. Both colors now fall back; what is rejected is the two resolving to the same image, which is
  the condition that actually makes a preview pointless.
- **Qodo (1)** found the one that would have broken a live cluster: under `canary` the stable track kept
  the unsuffixed Deployment name while adding `gambit.dev/track: stable` to `spec.selector`, which is
  **immutable** in `apps/v1` — so `rolling` → `canary` would have been rejected on upgrade. The
  stable track is now `…-api-stable`, so every strategy owns a distinct name set and each switch is a
  replace. A new assertion holds the strategies' Deployment names disjoint.

Every guard added here was mutation-tested by reintroducing the bug it covers (`API_UPSTREAM` back to
`api:8080`; dropping the stable track label; restoring `default` on the standby count; putting the
canary's stable track back on the unsuffixed name) and confirming it fails.

**CodeRabbit produced no review verdict on this PR** — walkthrough comment only, no
`Actionable comments posted:` line. That is the known free-plan failure mode, not a clean review.

CI's helm job gained kubeconform passes for the blue/green and canary renders, which contain objects
the default render does not.

Detailed in `docs/adr/0075-progressive-delivery.md`.

Prior: _Last updated: 2026-08-02 — M10 Increment 9: social UI on the profile page (ADR-0074), the first web increment of M10._

## M10 Social Graph Increment 1 — Pure Social Graph Domain Core (ADR-0066)

Pure, dependency-free domain core for the social graph (follows, friend requests, blocks) in `@chess-platform/social` (ADR-0066):
- **Package Foundation (`@chess-platform/social`)**: Pure TypeScript package with zero runtime dependencies. All timestamps are passed in (`at: Date`), making domain operations and tests deterministic.
- **Error Taxonomy (`src/errors.ts`)**: `SocialRuleError` carrying `SocialErrorCode` (`self_relation`, `blocked`, `already_exists`, `not_found`, `invalid_transition`, `not_authorized`).
- **Relations & Equality Primitives (`src/relation.ts`)**: `PlayerId` type, `assertDistinct(a, b)` throwing `self_relation` when `a === b` (run on all public mutations), and `normalizePair(a, b)` returning sorted ID tuples for symmetric relations.
- **Follow Graph (`src/follow.ts`)**: `FollowEdge` interface and pure queries (`isFollowing`, `followersOf`, `followingOf`). Follows are directed and require no consent.
- **Friendship State Machine (`src/friendship.ts`)**: `FriendRequest` with status `pending`, `accepted`, `declined`, `cancelled`, or `ended`. `applyFriendRequestAction` validates state transitions (only `pending` can be acted on) and actor authority (`accept`/`decline` restricted to addressee, `cancel` restricted to requester). `terminateFriendship` is the single move out of `accepted`, used when a block ends a friendship — kept beside the state machine so no other module writes a status transition. `ended` is distinct from `declined` on purpose: the history must not claim the addressee refused a request they accepted. `areFriends` and `friendsOf` query symmetric friendships. Crossing friend requests (simultaneous A→B and B→A) are rejected with `already_exists`.
- **Block Graph & Precedence (`src/block.ts`)**: Directed `BlockEdge` with symmetric enforcement. `block(A, B)` atomically removes follow edges (`A→B` and `B→A`), transitions pending requests (cancels A→B, declines B→A), and ends any active friendship. While a block exists, both blocker and blocked are barred from `follow` and `sendFriendRequest`. `unblock` removes the block without restoring past relations, so the pair must re-establish them.
- **Async Repository Port & In-Memory Adapter (`src/repository.ts`)**: `SocialGraphRepository` interface with `Promise`-returning signatures and `InMemorySocialGraphRepository` adapter implementing idempotent follows, friend request actions, blocks, and teardowns.
- **Deterministic Tie-Break Pagination (`src/ordering.ts`, `src/pagination.ts`)**: Shared `paginate` helper clamping negative `limit`/`offset` to 0. All list queries sort by timestamp descending and tie-break on counterpart `PlayerId` in **code-point** order (`compareIds`), not locale collation — the two disagree on mixed-case ids, and the Postgres adapter in increment 2 must therefore order with `COLLATE "C"`.
- **Not wired to anything yet**: domain logic and an in-memory adapter only. No migration, no route, no `bootstrap.ts` change, and `build:server` deliberately untouched — increment 2 makes it reachable.
- Detailed in `docs/adr/0066-social-graph-core.md`.

Prior: _Last updated: 2026-08-01 — M13 Observability Increment 7: span-export failure visibility + bounded retry (ADR-0063)._

## M13 Observability Increment 7 — Span-Export Failure Visibility + Bounded Retry (ADR-0063)

Span-export failure visibility, HTTP status code classification, honest delivery metrics, and bounded retries in `@chess-platform/api` (ADR-0063):
- **Async Outcome Reporting (`SpanExportOutcome`)**: `SpanTransport.send(payload)` now returns `Promise<SpanExportOutcome>` (`{ ok: true }` or `{ ok: false, retryable: boolean, reason: string }`). Export callers do not await `send()`, preserving the non-blocking `export(spans): void` contract. `send()` contains all rejections and synchronous throws, resolving to `{ ok: false, retryable: true, reason: 'network' }`.
- **`FetchSpanTransport` Classification**: `FetchSpanTransport` classifies network rejections and synchronous throws as retryable (`reason: 'network'`). On `response.ok === false`, HTTP 408, 429, and 5xx are classified as retryable (`reason: 'http_<status>'`), while all other 4xx status codes (e.g. 401, 413) are classified as non-retryable. `response.ok === true` resolves to `{ ok: true }`.
- **`OtlpJsonSpanExporter` Outcome Callback**: Added optional `onOutcome?: (outcome: SpanExportOutcome, spanCount: number, spans?: readonly SpanData[]) => void` callback to `OtlpJsonSpanExporter`. Maps payloads and delegates outcome reporting to `BatchSpanProcessor`.
- **Honest Metrics (`span_export_exported_total` & `span_export_failed_total`)**: Moved `span_export_exported_total` increment to confirmed delivery receipt (`ok: true`). Added new unlabelled counter `span_export_failed_total` incremented by the span count of a batch whose final attempt failed.
- **Bounded Retry & Memory Bound**: Bounded retries for retryable failures up to `maxExportRetries` (default 3) attempts scheduled through the existing `Scheduler` seam. Spans awaiting retry count toward `maxQueueSize`; when memory bound is hit, oldest spans (from retrying batches or fresh queue) are evicted, incrementing `span_export_dropped_total`.
- **Synchronous Non-Blocking `shutdown()`**: `BatchSpanProcessor.shutdown()` cancels pending retry tasks, counts unsent retrying spans as failed in `span_export_failed_total`, force-flushes queued spans, and finishes synchronously without hanging.
- Detailed in `docs/adr/0063-span-export-failure-visibility.md`.

Prior: _Last updated: 2026-08-01 — M13 Observability Increment 6: gateway tracing + reachable OTLP export (ADR-0062)._

## M13 Observability Increment 6 — Gateway Tracing + Reachable OTLP Export (ADR-0062)

Realtime gateway tracing, cross-node trace context propagation, and Helm OTLP configuration reachability (ADR-0062):
- **Gateway Tracer Wiring**: Wired `RecordingTracer` into `services/gateway/src/serve.ts` matching `packages/api/src/bootstrap.ts`. Configured with `serviceName: 'realtime-gateway'`, `LoggingSpanExporter`, and optional `BatchSpanProcessor(OtlpJsonSpanExporter)` gated by `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`. Self-instrumented via existing `metrics` registry (`GET /metrics`). Sampling supported via `OTEL_TRACES_SAMPLER_ARG` (`probabilitySampler`, defaulting to `alwaysOnSampler`).
- **Targeted Gateway Spans**: Spans emitted for game commands (`gateway.command`) and cross-node command forwarding (`gateway.forward`). Noise endpoints (`/health`, `/metrics`, `/ready`) and raw WS frames are excluded.
- **Bounded-Attribute PII Discipline**: `gateway.command` carries bounded attributes (`'cmd.kind'`, `'cmd.outcome'`, `'cmd.error_code'`); `gateway.forward` carries `'forward.outcome'` and `'forward.timeout'`. Updated `BOUNDED_SPAN_ATTRS` in `@chess-platform/api` to whitelist these keys. Game ID, user ID, move UCI payload, and tokens are never added to attributes.
- **Distributed Trace Context Propagation**: Added optional `traceparent?: string` to `ForwardedCommand` wire envelope. Forwarding node writes active span context; receiving node (`OwnerCommandConsumer`) parses `traceparent` and creates child spans under the forwarder. Wire-compatible fallback to fresh root span if missing or malformed.
- **Helm OTLP Reachability**: Added `tracing` configuration block to `deploy/helm/gambit/values.yaml` (`enabled`, `otlpEndpoint`, `otlpTracesEndpoint`, `samplerArg`). Rendered onto both API and Gateway Deployments (`api.yaml`, `gateway.yaml`). Fails closed when enabled with no endpoint. Verified by 50 snapshot test assertions in `scripts/helm-snapshot-test.sh`.

Prior: _Last updated: 2026-08-01 — M14 inc 8: load baseline, and the container build was broken (see below)._

## M14 Increment 8 — load baseline + container-build repair (ADR-0065)

### `docker compose up --build` had been broken since M11 inc 5

The headline. `docs/RUNNING.md` promises a one-command local stack; it had not worked for months and
**no gate noticed**, because CI builds from the root `npm run build` chain and never builds the
container images.

Two hand-maintained lists, stale in the same way:
1. **Build order** — duplicated inside `Dockerfile.api` and `Dockerfile.gateway`, and neither gained
   `search`, `engine` or `anti-cheat` when `persistence` and `api` started depending on them. The
   build failed outright.
2. **Runtime `COPY` list** — with the order fixed the image built, then died at startup with
   `Cannot find module '@chess-platform/search'`. Same three packages missing again.

Fixed by removing the duplication: both Dockerfiles now run the root `build:server` script.
`scripts/check-docker-build-order.mjs` (`npm run check:build-order`, wired into the `build-test` CI
job) verifies statically that the chain covers every transitive dependency of `@chess-platform/api`
in a valid order **and** that each runtime stage ships them. Verified by reproducing both real
failures. Note for future work: package directory ≠ package name — `@chess-platform/core` lives in
`packages/chess-core/`, so the checker maps names from the manifests rather than deriving paths.

### Load baseline

`deploy/load` + `npm run load-test`. k6 from a pinned image (`grafana/k6:0.55.0`), no npm dependency,
matching how helm/kubeconform/promtool are used. **The k6 thresholds ARE the SLOs from ADR-0064**, so
an unachievable target fails the run instead of sitting unchallenged in a document.

Measured on one Windows workstation, single replica, near-empty dataset, generator sharing the host:

Latency figures are the **read path only** — the series the threshold enforces.

| | Measured | Target |
|---|---|---|
| Availability | 100.000% (0/50,800 5xx) | 99.5% ✅ |
| Read p99 | 98.9 ms | 250 ms ✅ |
| Read p95 | 66.4 ms | — |
| Throughput | 1,582 req/s | — |

Targets are achievable and conservative. Deliberately **not** tightened — a target tuned to an empty
database on a laptop is a promise about the wrong system.

**Five bugs in my own harness.** Three found by running it, two more by Qodo on PR #60:
the reporter printed the *aggregate* `http_req_duration` p99 while the threshold is scoped to
`{scenario:read}`, so the documented figure came from a series that blends in the registration path;
and `readPath` checked only "not 5xx", meaning a 4xx passed the check while its latency still
entered the baseline — which is exactly how the `blitz` mistake below stayed invisible. Read checks
now demand 200 and the run fails if they stop doing so.

The first three: k6's `http_req_failed` counts all
non-2xx, so the rate limiter's 429s reported 76.5% availability for a service returning zero 5xx
(fixed with `setResponseCallback`); `p(99)` is absent from k6's default summary stats, so the one
percentile the SLO is stated at printed `n/a`; and the scenario requested
`/v1/leaderboard/blitz`, but `blitz` is a *speed* and the path takes a *variant* — 9,039 silent 422s
that looked like healthy traffic (the exact vocabulary split ADR-0055 introduced).

Registration throughput remains unmeasurable from one host: 5 requests/IP/hour (ADR-0013) means the
scenario is really a rate-limiter probe, and it now asserts what it can — that the limiter sheds
load with a 429 rather than a 5xx.

Prior: _Last updated: 2026-08-01 — M13 CLOSED: SLOs, alerting, dashboards, drift guard (see below)._

## M13 — increment 8, milestone CLOSED (ADR-0064)

Increments 1–7 built the signals; nothing looked at them, which operationally equals having no
instrumentation, only more expensive. This adds the consuming half.

- **Three SLOs** (`docs/SLO.md`): API availability 99.5%, API latency 99% under 250 ms, span-export
  delivery 99%. Deliberately no gateway-latency SLO — the WebSocket path emits only connection,
  message and auth-failure counters, so one would have to be invented rather than measured.
- **Latency thresholds sit on real histogram bucket edges.** `http_request_duration_seconds` buckets
  are fixed at `0.005 … 10`; a threshold off an edge makes `histogram_quantile` interpolate and
  return an estimate that reads like a measurement. 250 ms is an actual edge.
- **Multi-window multi-burn-rate alerts** (14.4x page / 6x page / 3x ticket), thresholds derived as
  `burn x (1 - target)` rather than tuned by feel. 4xx never burns availability. No traffic means a
  NaN ratio, no series, and no alert — an idle service has no measured availability.
- **21 rules validated with the real `promtool`**, two Grafana dashboards, and a runbook per alert
  with all nine `runbook_url` anchors verified to resolve.
- **`scripts/check-observability-drift.mjs`** (`npm run check:observability`, wired into the CI
  `helm` job) cross-checks every metric referenced in `deploy/observability/**` against the names the
  source emits. This is the piece that matters: rename a counter and an alert silently stops matching
  forever, and nothing else in the suite can catch it because the rules are YAML and the metrics are
  TypeScript. Verified by making it fail — renaming `gateway_auth_failures_total` produced exit 1
  naming the metric and the file.
- **Scraping:** Prometheus must hit the API Service directly in-cluster; SEC-1 blocks `/v1/metrics`
  at the public proxy.
- **The SLO targets are unvalidated.** No production traffic, no load test (M14's 100k validation is
  still deferred). `docs/SLO.md` opens by saying so.

Also fixed stale drift in `docs/OBSERVABILITY.md`: it still described `OtlpJsonSpanExporter` as
passing outcomes via `onOutcome`, a symbol removed in ADR-0063 and replaced by `exportWithOutcome`.

Prior: _Last updated: 2026-08-01 — M12 CLOSED: pen-test pass (see below)._

## M12 — pen-test pass complete, milestone CLOSED

Full STRIDE audit of all seven trust boundaries at `c4d5bc7`, written up in `docs/SECURITY_AUDIT.md`.

**One finding, SEC-1 (Medium), fixed:** `docker/web/nginx.conf` proxied all of `/v1/` to the API and
`GET /v1/metrics` is a `PUBLIC` route, so on any deployed Gambit the whole Prometheus registry was
retrievable unauthenticated from the internet — ten series whose `route` label enumerates every
endpoint, with per-route request volume and status distribution (moderation traffic included), plus
the five `span_export_*` counters. Fixed with an exact-match
`location = /v1/metrics { return 404; }` ahead of the `/v1/` block; Prometheus scrapes the API
Service directly in-cluster, so nothing legitimate used the public path.

**The first fix was bypassable and Qodo caught it.** `splitPath` filters empty segments, so
`/v1/metrics/` resolves to the same route and serves the registry; an exact-match
`location = /v1/metrics` let it through. The initial probe forwarded that form upstream and recorded
it as "does not over-block" — a bypass written down as correct, because the probe stopped at the
proxy instead of asking what the API did with it. Now `location ~ ^/v1/metrics/?$`, verified against
a running nginx across `/v1/metrics/`, `/v1//metrics//`, `/v1/./metrics`, `/v1/foo/../metrics`, case
variation and `%20`, while `/v1/metricsfoo` and `/v1/metrics/sub` still proxy.

Guarded at both layers: an api test pins the route equivalence that makes the proxy rule's shape
load-bearing, and `scripts/smoke-test.mjs` checks both URL forms and rejects any 404 body containing
Prometheus text.

Everything else checked out: parameterised SQL throughout, moderation endpoints correctly gated to
`moderator`/`admin`, spectators unable to issue commands, scrypt + 256-bit tokens + rate limiting on
every brute-forceable endpoint, full security-header set, allowlist CORS, no internal detail in error
bodies, `shell: false` engine spawn, no committed secrets, and `npm audit --omit=dev` clean. The
audit document also states what the pass did NOT cover — no fuzzing/DAST, no load or DoS testing, no
frontend or WebAuthn crypto review, no live-cluster infrastructure review.

Prior: _Last updated: 2026-08-01 — CI: Helm chart snapshot test is now a gate (see below)._

## CI — Helm chart snapshot test wired into the `helm` job

`scripts/helm-snapshot-test.sh` (44 assertions) had been written in ADR-0057 and extended twice
since, but **nothing ever ran it automatically** — it only executed when someone remembered to.
It is now the final step of the `helm` job.

This matters because `kubeconform` only proves manifests are schema-valid. It cannot catch that
`POSTGRES_PASSWORD` must be declared before `DATABASE_URL` (Kubernetes expands `$(VAR)` only for
earlier entries), that `SEARCH_ENABLED`/`SEMANTIC_SEARCH_ENABLED` land on the right container, or
that the search indexer stays pinned to one replica. Those are exactly the regressions the script
guards, and they are invisible until a deploy.

Prior: _Last updated: 2026-08-01 — M11 Search Increment 12: embedding backfill + live embedding pipeline (ADR-0061)._

## M11 Search Increment 12 — Embedding Backfill + Live Embedding Pipeline (ADR-0061)

Vector embedding backfill (`reindexAll`) and live index worker (`SearchIndexWorker`) embedding pipeline in `@chess-platform/search`, `@chess-platform/api`, `services/gateway`, and Helm (ADR-0061):
- **Pure Domain Document Embedding**: Added `embedDocument` and `embedDocuments` to `@chess-platform/search` (`src/embed-document.ts`). Preserves `id`, `text`, and filter `fields` using conditional spread for `exactOptionalPropertyTypes` compliance. Processes inputs sequentially (since `HashingEmbeddingProvider` is CPU-bound and synchronous).
- **Single Write Path Routing**: Refactored `reindexAll` and `SearchIndexWorker` so that when `semantic` options (`{ repository, embeddingProvider }`) are supplied, writes route exclusively through the semantic repository, replacing the keyword write path. Rationale: `PgSemanticSearchRepository.index` and `indexAll` already write to both `search_documents` and `search_embeddings` inside one transaction; calling both write paths would write `search_documents` twice per document.
- **`reindexAll` Options Object Refactoring**: Converted `reindexAll` from 4 positional parameters to a unified `ReindexOptions` options object (`{ source, repository, batchSize?, onProgress?, semantic? }`), respecting the 4-argument ceiling.
- **CLI Reindex & Live Worker Wiring**: Updated `packages/api/src/scripts/reindex-search.ts` to instantiate `PgSemanticSearchRepository` and `HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS)` when `SEMANTIC_SEARCH_ENABLED !== '0'`, logging the active path. Updated `services/gateway/src/serve.ts` to pass `semantic` options to `SearchIndexWorker` under the same env gate.
- **Helm Indexer & Snapshot Test**: Updated `deploy/helm/gambit/templates/search-indexer.yaml` to set `SEMANTIC_SEARCH_ENABLED="0"` when `search.semanticEnabled` is `false`. Extended `scripts/helm-snapshot-test.sh` with matching assertions.
- **DB-Gated Integration Tests**: Added `packages/api/test/semantic-pipeline.integration.test.ts` (gated on `DATABASE_URL`, namespaced via `uuidv7()`), verifying that `reindexAll` populates `search_embeddings` in Postgres and that `querySemantic` successfully retrieves seeded entities.
- **Operator Backfill Requirement**: Documented plainly in ADR-0061 and deployment guide that populating pre-existing data into `search_embeddings` is a manual operator step (`npm run reindex-search -w @chess-platform/api`).
- Detailed in `docs/adr/0061-embedding-pipeline.md`.

Prior: M11 Search Increment 11 — REST Endpoint Wiring for Semantic and Hybrid Search (ADR-0060)

## M11 Search Increment 11 — REST Endpoint Wiring for Semantic and Hybrid Search (ADR-0060)

REST API search endpoint (`GET /v1/search`) support for semantic and hybrid search modes in `@chess-platform/api` (ADR-0060):
- **Search Mode Query Parameter**: Added optional `mode` query parameter (`mode=keyword|semantic|hybrid`, default `keyword`) to `GET /v1/search`. Invalid `mode` values return 422 validation errors (`"mode" must be one of keyword, semantic, hybrid`).
- **Keyword Mode Unchanged**: `mode=keyword` (and default when `mode` is omitted) preserves exact byte-for-byte existing behavior and response shape. Requires `deps.searchRepository` or returns 503 (`search is not configured`).
- **Semantic & Hybrid Mode Requirements**: `mode=semantic` and `mode=hybrid` require both `deps.semanticSearchRepository` and `deps.embeddingProvider`, returning 503 (`semantic search is not configured`) if either dependency is missing.
- **Filter-Aware Query Embedding**: For vector embedding input, `parseNaturalQuery` output extracts relevance terms and phrases (`[...query.terms, ...query.phrases].join(' ')`), stripping filter tokens (e.g. `variant:blitz`) to prevent noisy filter tokens from skewing vector distance calculations. Falls back to raw `q` when no terms/phrases exist.
- **Search Execution & Filtering**: `mode=semantic` executes `semanticSearchRepository.querySemantic(vector, { limit, offset, filters: query.filters })`, ensuring natural query filters constrain the vector result set. `mode=hybrid` executes `semanticSearchRepository.queryHybrid(query, vector, { limit, offset })` (where filters are applied internally across both keyword and vector RRF CTE branches).
- **Constant Export & Schema Coupling**: Exported `SEARCH_EMBEDDING_DIMENSIONS = 256` constant from `@chess-platform/search` (re-exported via package index) with explicit comment documenting strict coupling to `vector(256)` in `packages/persistence/migrations/0014_search_embeddings.sql`.
- **Production Wiring & Test Harness**: Configured production bootstrap in `bootstrap.ts` gated by `SEMANTIC_SEARCH_ENABLED !== '0'` (defaulting to `PgSemanticSearchRepository` and `HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS)`). Updated test harness (`HarnessOptions.withoutSemanticSearch`) with `InMemorySemanticSearchRepository` and `HashingEmbeddingProvider` exposed on `Harness`.
- **OpenAPI 3.1 & Integration Tests**: Regenerated `packages/api/openapi.json` with `mode` enum and updated 503 response docs. Added comprehensive integration tests covering mode defaults, semantic ranking, hybrid union/RRF fusion, filter parsing & exclusion from vector generation, mode validation, 503 unconfigured states, and pagination.
- **Helm Wiring**: New `search.semanticEnabled` value (default `true`) renders `SEMANTIC_SEARCH_ENABLED=0` on the API Deployment, so the switch is actually reachable in a Kubernetes deployment (the gap ADR-0057 fixed for `SEARCH_ENABLED`). `scripts/helm-snapshot-test.sh` grew from 39 to 43 assertions.
- **DEFERRED Gap**: Documented plainly that no production worker or projection pipeline populates `search_embeddings` yet; `mode=semantic` in production returns an empty page until an embedding backfill/projection increment lands.
- Detailed in `docs/adr/0060-semantic-search-rest-wiring.md`.

Prior: M11 Search Increment 10 — pgvector Semantic Adapter (ADR-0059)

## M11 Search Increment 10 — pgvector Semantic Adapter (ADR-0059)

PostgreSQL `pgvector` semantic vector search adapter (`PgSemanticSearchRepository`) and schema migration `0014_search_embeddings.sql` in `@chess-platform/persistence` (`/pg` subpath) (ADR-0059):
- **Schema & Extension Migration (`migrations/0014_search_embeddings.sql`)**: Created extension `vector` and table `search_embeddings` (`id TEXT PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE`, `embedding vector(256) NOT NULL`). Configured HNSW vector index (`search_embeddings_embedding_idx`) using `vector_cosine_ops` for low-latency cosine distance queries (`<=>`).
- **Separate Table Design Rationale**: Embeddings live in a separate table (`search_embeddings`) joining `search_documents`, keeping `remove(id)` and `clear()` honest on `SemanticSearchRepository` (deleting embeddings without touching keyword documents in `search_documents`).
- **Shared Query Helpers (`src/pg/search-helpers.ts`)**: Extracted `canonicalizeFields`, `formatPgVector`, `buildTsqueryExpr`, and `buildJsonbFilterClauses` into a shared module used by both `PgSearchRepository` and `PgSemanticSearchRepository` to ensure zero drift in field canonicalization, full-text tsquery building, or JSONB containment filtering.
- **PgSemanticSearchRepository (`src/pg/semantic-search.ts`)**: Implements `SemanticSearchRepository` port over a `pg.Pool`. Serializes vector parameter inputs as `$N::vector` without string interpolation. Handles transactional upserts (`index`/`indexAll`), selective semantic removals (`remove`/`clear`), and `size()`.
- **Cosine Distance to Similarity Mapping**: `querySemantic` converts pgvector cosine distance (`<=>`) to cosine similarity via `1 - (e.embedding <=> $q::vector)` so that higher scores represent higher similarity ("higher score = more similar"). `minScore` thresholding is mapped to the bare-operator distance predicate `e.embedding <=> $q::vector <= 1 - minScore` (the index-friendly form, kept so the predicate stays usable once the fast path below lands). The query vector is bound **lazily**: the count query only references it when a `minScore` predicate exists, and Postgres rejects a Bind supplying more parameters than the statement uses, so eager binding broke `querySemantic(vector)` with no filters outright.
- **SQL Reciprocal Rank Fusion (`queryHybrid`)**: Fuses keyword FTS (`kw` CTE) and vector search (`vec` CTE) via SQL Reciprocal Rank Fusion (`COALESCE(kwWeight / (rrfK + kw.rnk), 0) + COALESCE((1 - kwWeight) / (rrfK + vec.rnk), 0)`). Handles empty keyword queries, validates parameters throwing `RangeError`, and filters `WHERE score > 0` so `keywordWeight: 1` and `keywordWeight: 0` return strictly their respective modality's documents.
- **Planner Mechanics — MEASURED (pgvector 0.8.5, 5,000 × 256-dim rows, `EXPLAIN ANALYZE`)**: the `, d.id` tie-break **alone** defeats the HNSW index. The join and the jsonb `@>` filter do NOT — both keep an `Index Scan` (0.43 ms / 0.18 ms); adding the tie-break drops the plan to a top-N `Sort` over a full `Seq Scan` (5.89 ms). The tie-break is deliberately retained for pagination determinism, so **the HNSW index is not currently exercised by any adapter query** — it exists for the follow-up fast path. That fast path (ANN candidates via the index in an inner query, re-sorted outside) is deferred on purpose: pgvector 0.8's iterative scans are off by default, so an inner `LIMIT` plus a filter can under-return, and choosing a recall policy deserves its own increment. Full numbers in ADR-0059.
- **Hybrid Filter Correctness (fixes ADR-0058 behaviour, `@chess-platform/search` + adapter)**: `query.filters` now constrain the SEMANTIC branch as well as the keyword branch, in both `hybridSearch` and `queryHybrid`. Previously a document violating a hard constraint parsed from the query text (e.g. `variant:blitz`) could re-enter through the vector branch and surface in the fused results. Regression tests at both layers.
- **Test Isolation Fix (`packages/persistence/package.json`)**: persistence tests now run with `--test-concurrency=1`. `PgSearchRepository.size()` counts `search_documents` globally, and the new semantic suite writes to that same table, so parallel test files raced and broke the pre-existing keyword suite's relative-size assertions. These are integration tests sharing one database; serializing them is the honest expression of that.
- **DB-Gated Integration Tests (`test/semantic-search.integration.test.ts`)**: Added namespaced, hermetic integration test suite covering migration, indexing, similarity ranking, upsert, removal, `minScore` thresholding, JSONB metadata filters, pagination, hybrid union/extremes, and 256-dimension vector mismatch error handling.
- Detailed in `docs/adr/0059-pgvector-semantic-adapter.md`.

## M11 Search Increment 9 — Semantic Search Domain Core (ADR-0058)

Pure, dependency-free domain core for vector and hybrid search in `@chess-platform/search` (ADR-0058):
- **Pure Vector Math (`src/vector.ts`)**: Added `Vector` type (`readonly number[]`) and functions `dot`, `magnitude`, `cosineSimilarity` (bounded in `[-1, 1]`), and `normalize`. All vector functions validate finite components via `assertFinite` throwing `RangeError` on `NaN`/`Infinity`. Dimension mismatches throw `RangeError` with explicit length details. Zero-magnitude vectors return `0` similarity and normalize to zero vectors of equal length. `cosineSimilarity`/`normalize` scale by the largest absolute component before squaring, so entirely finite inputs near `Number.MAX_VALUE` cannot overflow into a `NaN` score or a silently zeroed unit vector.
- **Embedding Provider Port & Offline Hashing Adapter (`src/embedding.ts`)**: Defined async `EmbeddingProvider` interface (`dimensions`, `embed`, `embedAll`) ensuring `@chess-platform/search` stays dependency-free while accommodating external model providers. Implemented `HashingEmbeddingProvider` using deterministic 32-bit FNV-1a hashing (`fnv1a32`) for offline, reproducible vectorization in CI.
- **Shared Filter Module (`src/filters.ts`)**: Extracted `matchesAllFilters`, `matchesFilter`, and `getFieldValue` into a shared module for keyword and vector search rankers without altering `search.ts` external behavior.
- **Pure Vector Similarity Ranker (`src/semantic.ts`)**: Created `SemanticSearchableDocument` interface and `semanticSearch` ranker evaluating cosine similarity, enforcing `minScore` thresholding, applying field filters, and sorting results `score DESC`, tie-broken by `id ASC`.
- **Hybrid Search via Reciprocal Rank Fusion (`src/hybrid.ts`)**: Implemented `hybridSearch` fusing keyword FTS and vector search via Reciprocal Rank Fusion (RRF, `1-based rank` score `weight / (rrfK + rank)`). Solves term-frequency vs cosine-similarity scale incompatibility with scale-invariant rank fusion. Validates `keywordWeight` in `[0, 1]` and `rrfK > 0`.
- **Semantic Repository Port & In-Memory Adapter (`src/semantic-repository.ts`)**: Created `SemanticSearchRepository` interface (`index`, `indexAll`, `remove`, `clear`, `size`, `querySemantic`, `queryHybrid`) and `InMemorySemanticSearchRepository` adapter. The index latches its embedding dimension on first write and rejects mismatched documents there (released again whenever the index becomes empty, via `clear()` or removal of the last document), so one bad insert cannot break reads for the whole repository. Documented pgvector cosine-distance (`<=>`) mapping (`1 - distance`) for future persistence adapters.
- **Shared Pagination Contract (`src/pagination.ts`)**: Moved `SearchOptions`, `SearchPage`, and a new `paginate` helper out of `repository.ts` (which re-exports both types, so the package's public API is unchanged and `PgSearchRepository` keeps importing them from the package root). Both `InMemorySearchRepository` and `InMemorySemanticSearchRepository` now share one implementation of the clamping rules — negative `offset`/`limit` clamp to `0`, an omitted `limit` returns all remaining hits, `total` counts hits before pagination — so keyword and semantic paging cannot drift apart.
- **Deferred**: pgvector persistence adapter (`PgSemanticSearchRepository`) and REST API wiring deferred to Increments 10 and 11.
- Detailed in `docs/adr/0058-semantic-search-core.md`.

## M14 Increment 7 — Search Indexer Deployment (ADR-0057)

Helm wiring for the live search indexer, pinned to one replica (ADR-0057):
- **Dedicated Deployment (`deploy/helm/gambit/templates/search-indexer.yaml`)**: renders `<fullname>-search-indexer` when `gateway.searchIndexer.enabled=true` (default `false`), running the gateway image with `SEARCH_INDEXER=1`. `replicas: 1` is hard-coded, not a value — the worker's dedup set is process-local, so N replicas would each index every finished game.
- **No Service**: the pod takes no client traffic. It binds the WS/health ports because it reuses `serve.ts`, but with no clients it never claims game ownership and stays inert in the Redis ownership registry (ADR-0010). Probes target the pod directly.
- **`SEARCH_ENABLED` reachable from Helm (`templates/api.yaml`)**: new `search.enabled` value (default `true`); when `false` the API gets `SEARCH_ENABLED=0` and `GET /v1/search` returns 503 per ADR-0055.
- **Fail-closed**: `gateway.searchIndexer.enabled=true` with `search.enabled=false` fails at template time instead of indexing into an index nothing serves.
- **Gateway template comment**: records that `SEARCH_INDEXER` is deliberately absent there, so it is not added later — unlike `TOURNAMENT_REPORTER`, duplicate indexing is not made safe by CAS.
- **Explicit rollout strategy**: `RollingUpdate` with `maxSurge: 1, maxUnavailable: 0`. `Recreate` was rejected — `gamesEndedChannel()` is Redis pub/sub (fire-and-forget), so terminating the old pod first would drop every game finishing in the gap; a brief two-pod overlap only duplicates idempotent work.
- **Verification**: `scripts/helm-snapshot-test.sh` extended with assertions for opt-in default, `replicas == 1`, the pinned strategy, `SEARCH_INDEXER` absent from the gateway, no added Service, the fail-closed combination, and the `SEARCH_ENABLED` kill switch. 35 passed / 0 failed locally. Default render stays 13 resources; indexer-enabled is 14.
- **CI wiring PENDING**: `.github/workflows/ci.yml` could not be committed (integration lacks the GitHub App `workflows` permission), and the snapshot script has never run in CI. Indexer rendering is not continuously verified until a step invoking it is added.
- **Debt note**: this closes the single-replica-Deployment debt for the indexer only. `TOURNAMENT_REPORTER` (safe via CAS), `BOT_AUTO_ANALYZE` and `ANTICHEAT_AUTO_ANALYZE` remain per-replica; shared distributed leadership stays tracked.
- Detailed in `docs/adr/0057-search-indexer-deployment.md`.

Prior: M11 Search Increment 8 — Live Incremental Game Search Indexing (ADR-0056)

## M11 Search Increment 8 — Live Incremental Game Search Indexing (ADR-0056)

Event-driven live game search indexing triggered by `gamesEndedChannel()` broadcasts (ADR-0056):
- **Single-Game Read Path (`@chess-platform/persistence`)**: Added `findGame(id: string): Promise<GameDocumentInput | null>` to `SearchBackfillSource` port and implemented in `PgSearchBackfillSource` reusing column selection + JOINs.
- **Package Boundary & Local Subscriber Port (`@chess-platform/api`)**: Declared local structural `SearchIndexSubscriber` port (`subscribe(channel, handler): () => void`) avoiding an `api` -> `realtime-gateway` package dependency.
- **Live Worker Architecture (`SearchIndexWorker`)**: Created `SearchIndexWorker` in `@chess-platform/api` with defensive payload type guards, bounded FIFO dedup set (`MAX_SEEN = 10_000`), error containment, and deterministic `await worker.drain()` test hook.
- **Aborted Games Decision**: Aborted games (`result: '*'`) and non-existent games (`null`) are explicitly skipped during live indexing.
- **Gateway Hosting (`services/gateway/src/serve.ts`)**: Hosted worker gated on `SEARCH_INDEXER=1`, suppressed by `SEARCH_ENABLED=0`, and wired to graceful process shutdown (`worker.stop()`).
- Detailed in `docs/adr/0056-live-search-indexing.md`.

## M11 Search Increment 7 — Search Projections, Backfill & Production Wiring (ADR-0055)

Search entity projections, keyset-paginated backfill source, production wiring, and reindex CLI (ADR-0055):
- **Entity Projections (`@chess-platform/search`)**: Added `gameToDocument`, `playerToDocument`, and `tournamentToDocument` in `projections.ts` mapping local structural inputs into canonicalized `SearchableDocument` records with namespaced IDs (`game:<id>`, `player:<id>`, `tournament:<id>`) and a `type` field (`game` | `player` | `tournament`). Zero external runtime dependencies.
- **Security & PII Exclusion**: Player documents strictly index `handle` and optional `country`. User `email`, `email_hash`, and `flags` are explicitly excluded from indexed search documents, proven by automated regression test.
- **Backfill Source (`@chess-platform/persistence`)**: Added `SearchBackfillSource` interface port and `PgSearchBackfillSource` PostgreSQL implementation using bound parameter keyset (cursor) pagination (`WHERE id > $1 ORDER BY id ASC LIMIT $2`). JOINs `users` on `games` to resolve player handles.
- **Production Wiring (`@chess-platform/api`)**: Wired `PgSearchRepository` in `createPgDependencies` in `bootstrap.ts`, with operator opt-out via `SEARCH_ENABLED=0` environment variable (degrading `GET /v1/search` to HTTP 503).
- **Reindex CLI**: Added `reindex-search.ts` script in `packages/api/src/scripts/` (registered as `npm run reindex-search -w @chess-platform/api`), paging all entity kinds in batches (~500) and upserting into `search_documents` idempotently.
- **Vocabulary Realignment & Player-Relative Query Deferral**: Realigned natural vocabulary (`speed` vs `variant`, canonical codes, `match`/`matches` -> `game`, draw result mapping). Removed player-relative terms (`won`, `lost`, `white`, `black`) from `NATURAL_VOCABULARY`, deferring player-scoped natural queries ("games I won") to Increment 8 (authenticated search mode).
- **Absolute Operator Kill Switch**: Hardened `SEARCH_ENABLED=0` in `bootstrap.ts` to act as an absolute kill switch (setting `deps.searchRepository` to `undefined` unconditionally).
- **Reindex Core & Idempotency**: Extracted pure `reindexAll` helper in `packages/api/src/search/reindex.ts`, verified idempotent across multiple runs.
- **Round-Trip Testing**: Added `search-roundtrip.test.ts` verifying end-to-end matching of projected entity documents via `parseNaturalQuery` against `InMemorySearchRepository`.
- Detailed in `docs/adr/0055-search-projections-and-wiring.md`.

## M11 Search Increment 6 — Search REST API (GET /v1/search) (ADR-0054)

Public, read-only search REST API endpoint `GET /v1/search` in `@chess-platform/api` (ADR-0054):
- **Endpoint & Routing**: Added `GET /v1/search` route (public policy) accepting required `q` query string, optional bounded `limit` (default 20, max 100), and optional `offset` (default 0, non-negative integer validation).
- **Query Processing**: Runs natural language query normalizer `parseNaturalQuery(q)` from `@chess-platform/search` and executes `deps.searchRepository.query(query, { limit, offset })`.
- **Response & OpenAPI Schemas**: Returns `{ total, results }` matching `SearchResults` schema (`SearchResult` items with `id` and `score`).
- **Optional Dependency & 503 Guard**: Injected `searchRepository?: SearchRepository` on `ApiDependencies` / `RouteDeps`. Throws `HttpError.unavailable('search is not configured')` (503) when `searchRepository` is absent, mirroring anti-cheat moderation routes.
- **Test Harness**: Wired `InMemorySearchRepository` into `startHarness`, controllable via `withoutSearch` option.
- **Deferred**: Populating search index (projections from entities) and wiring `PgSearchRepository` in `bootstrap.ts` deferred to later increments.
- Detailed in `docs/adr/0054-search-rest-api.md`.

Prior: M11 Search Increment 5 — Postgres full-text adapter (PgSearchRepository) (ADR-0053)

Durable Postgres full-text adapter `PgSearchRepository` in `@chess-platform/persistence` implementing `SearchRepository` (ADR-0053):
- **Schema & Migration (`0013_search_documents.sql`)**: `search_documents` table with `id TEXT PRIMARY KEY`, `text TEXT`, `fields JSONB`, and stored generated `tsv tsvector` using `'simple'` configuration, with GIN indexes on `tsv` and `fields`.
- **`PgSearchRepository` Adapter**: Implements `SearchRepository` (`index`, `indexAll` with atomic transaction, `remove`, `clear`, `size`, `query`) in `@chess-platform/persistence/pg`.
- **Parameterized Query Building**: Query translator converting terms via `plainto_tsquery('simple', $N)` and phrases via `phraseto_tsquery('simple', $N)`, combined with `&&`. Case-insensitive field filters using `lower(fields->>$N) = lower($M)` or `IS DISTINCT FROM` for negation. All user inputs passed as SQL bound parameters ($1, $2, ...) ensuring zero SQL injection.
- **Scoring & Pagination**: `ts_rank(tsv, tsquery)` scoring when text terms/phrases exist (0 otherwise for filter-only/empty queries ordered `id ASC`), separate total count query before appending `LIMIT` / `OFFSET`.
- **Integration Testing**: Ephemeral Postgres integration test (`search.integration.test.ts`) covering index, query, upsert, remove, field filters, negation, and pagination, cleanly skipping when `DATABASE_URL` is unset.
- **Deferred**: pgvector semantic vector search adapter and REST/GraphQL API integration deferred to later M11 increments.
- Detailed in `docs/adr/0053-pg-search-repository.md` and `docs/DATABASE.md`.

Prior: M11 Search Increment 4 — Async SearchRepository port (ADR-0052)

Async `SearchRepository` port and in-memory adapter signatures in `@chess-platform/search` (ADR-0052):
- **SearchRepository Port**: Updated interface methods to return Promises (`index`, `indexAll`, `remove`, `clear`, `size`, `query`) enabling future I/O-backed adapters (Postgres full-text and pgvector semantic search) to perform async operations.
- **InMemorySearchRepository Adapter**: Updated method implementations to `async`, returning resolved Promises with unchanged Map-backed storage, query evaluation, and pagination semantics.
- **Contracts Unchanged**: `SearchOptions` and `SearchPage` data contracts remain unchanged; no consumers outside `@chess-platform/search` were affected.
- Detailed in `docs/adr/0052-async-search-repository.md`.

Prior: M11 Search Increment 3 — Natural-language query normalization (parseNaturalQuery) (ADR-0051)


Bounded, rule-based natural language query normalizer in `@chess-platform/search` (ADR-0051):
- **Normalizer (`parseNaturalQuery`)**: `parseNaturalQuery(input: string): SearchQuery` layers on `parseSearchQuery(input)` (preserving explicit `field:value` filters and quoted `"phrases"` intact), promotes recognized chess vocabulary words among bare terms into non-negated filters, drops stop words, and deduplicates filters by `(field, value, negated)` preserving first-occurrence order.
- **Vocabulary & Stop Words**: `NATURAL_VOCABULARY` maps recognized terms to structured filters (variants: `blitz`, `bullet`, `rapid`, `classical`, `chess960`/`960`, `atomic`, `crazyhouse`, `horde`, `antichess`; colors: `white`, `black`; results: `win`/`won`/`wins`/`winning`, `loss`/`lost`/`losses`/`lose`, `draw`/`draws`/`drew`/`drawn`/`tie`/`tied`); `NATURAL_STOP_WORDS` drops 27 filler words carrying no search signal.
- **Pure & Total**: Operates strictly in memory without I/O or external dependencies, returning a structured `SearchQuery` consumable by existing matchers and repositories.
- **Deferred**: Semantic vector embeddings and LLM-based query understanding deferred to later M11 increments.
- Detailed in `docs/adr/0051-natural-query-normalization.md`.

Prior: M11 Search Increment 2 — SearchRepository port + in-memory adapter (ADR-0050)

Stateful repository abstraction and in-memory adapter in `@chess-platform/search` (ADR-0050):
- **SearchRepository Port**: `SearchRepository` interface with `index(document)`, `indexAll(documents)`, `remove(id)`, `clear()`, `size()`, and `query(query, options)`.
- **Pagination Contracts**: `SearchOptions` (`limit`, `offset` with negative value clamping to `0`) and `SearchPage` (`total` matching hit count across index independent of pagination limits, and `results` containing sliced `SearchResult[]`).
- **InMemorySearchRepository Adapter**: Pure, dependency-free Map-backed adapter storing `SearchableDocument`s by `id` (upsert semantics). Delegates query evaluation to Increment 1's `search` ranker and slices results deterministically (`start = Math.max(0, offset ?? 0)`, `end = limit === undefined ? allHits.length : start + Math.max(0, limit)`).
- **Deferred**: Postgres full-text search and pgvector semantic adapters deferred to later M11 increments.
- Detailed in `docs/adr/0050-search-repository.md`.

Prior: M11 Search Increment 1 — pure-domain keyword search core (ADR-0049)

Pure, dependency-free `@chess-platform/search` domain package delivering keyword search core (ADR-0049):
- **Tokenizer**: `tokenize(text: string): string[]` splitting text into lowercase alphanumeric tokens using Unicode-aware regex (`/[^\p{L}\p{N}]+/u`).
- **Query Parser**: `parseSearchQuery(input: string): SearchQuery` parsing free-text input into `terms`, `phrases` (`"quoted phrase"`), and `filters` (`[-]field:value` or `field:"value"`). Non-throwing, hand-rolled whitespace/quote tokenizer handling empty values (`field:` as term) and unterminated quotes cleanly.
- **In-Memory Search Matcher & Ranker**: `search(query, documents): SearchResult[]` performing AND-matching across exact case-insensitive filters (including negated filters `-field:value`), required term-tokens, and contiguous phrase token sublists. Ranks hits by term token frequency plus phrase bonus (`2 * phraseMatches`), tie-broken deterministically by `id` ASC.
- **Deferred**: pgvector persistence, semantic embeddings, and REST/GraphQL API surfaces deferred to later M11 increments.
- Detailed in `docs/adr/0049-search-domain-core.md`.

Prior: M13 Increment 5 — span-export pipeline self-instrumentation (metrics) (ADR-0048)

Self-observing span export pipeline in `@chess-platform/api` (ADR-0048):
- **BatchSpanProcessor Self-Instrumentation**: Emits Prometheus counters via `metrics?: Metrics` in `BatchSpanProcessorOptions` to surface pipeline health at `GET /v1/metrics`.
- **Counters**: `span_export_received_total` (spans accepted), `span_export_dropped_total` (spans evicted on overflow + post-shutdown drops), `span_export_exported_total` (spans dispatched downstream), and `span_export_batches_total` (batches dispatched downstream).
- **Cardinality Discipline**: Counters carry NO labels (cardinality and PII safe).
- **Dropped Count Agreement**: `span_export_dropped_total` and `processor.droppedSpans` stay in exact agreement.
- **Bootstrap Wiring**: In production `bootstrap.ts`, passes the shared `metrics` instance to `BatchSpanProcessor` on the OTLP path.
- **Deferred**: True export-FAILURE counters + retries remain deferred to the async-exporter increment (synchronous `void` export cannot confirm collector receipt).
- Detailed in `docs/adr/0048-span-export-metrics.md` and `docs/OBSERVABILITY.md`.

Prior: M13 Increment 4 — BatchSpanProcessor (buffered, batched span export) (ADR-0047): Buffered and batched span export decorator `BatchSpanProcessor` in `@chess-platform/api` (ADR-0047):
- **BatchSpanProcessor**: Decorator implementing `SpanExporter` in `src/ports/batch-span-processor.ts` buffering finished spans and flushing them in batches of size `maxExportBatchSize` (default: 512).
- **Scheduler Seam & Periodic Flush**: Periodic flush every `scheduledDelayMillis` (default: 5000ms) to bound span loss window; `Scheduler` seam with `intervalScheduler` default (unref'd `setInterval`) and manual scheduler test helper.
- **Bounded Queue**: Bounded by `maxQueueSize` (default: 2048). Drops oldest spans on overflow and increments `droppedSpans` counter.
- **Lifecycle & Containment**: `forceFlush()` drains queue in batch chunks; `shutdown()` cancels scheduled task and force-flushes (idempotent); downstream export exceptions are contained.
- **Bootstrap Wiring**: In production `bootstrap.ts`, wraps ONLY `OtlpJsonSpanExporter` inside `MultiSpanExporter` when `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. Logging export stays direct per-span.
- **Deferred**: Retries remain deferred (sync `void` `export` contract cannot signal failure).
- **Detailed in `docs/adr/0047-batch-span-processor.md` and `docs/OBSERVABILITY.md`.**

Prior: M13 Increment 3 — span export seam + OTLP/JSON exporter (ADR-0046): Span export abstraction, reusable `LoggingSpanExporter`, fan-out `MultiSpanExporter`, pure `toResourceSpans` OTLP/JSON payload builder, and `OtlpJsonSpanExporter` over an injectable `SpanTransport` in `@chess-platform/api`.
- **Exporter Seam**: `SpanExporter` port (`export(spans: readonly SpanData[]): void`) in `src/ports/span-export.ts` with best-effort, non-blocking contract.
- **Whitelisting**: Exported `pickBoundedAttrs` and `BOUNDED_SPAN_ATTRS` (`http.method`, `http.route`, `http.status_code`) as single source of truth; removed bootstrap local copy.
- **Exporters**: `LoggingSpanExporter` (same structured JSON log output as inc 2), `MultiSpanExporter` (composite fan-out with try/catch error containment), and `spanSinkFromExporter` adapter.
- **OTLP/JSON Exporter**: `src/ports/otlp-span-exporter.ts` defines OTLP/JSON interfaces (`OtlpTracesPayload`, `OtlpSpan`, etc.), pure mapping `toResourceSpans` (kind/status enums, `BigInt` nanosecond timestamps, `toOtlpAnyValue` type conversion, omitted `parentSpanId` when null), and `OtlpJsonSpanExporter` delegating to `SpanTransport`. Includes `FetchSpanTransport` boundary adapter.
- **Bootstrap Wiring**: In production `bootstrap.ts`, if `OTEL_EXPORTER_OTLP_ENDPOINT` is set, builds `OtlpJsonSpanExporter` alongside `LoggingSpanExporter` via `MultiSpanExporter`; otherwise uses `LoggingSpanExporter` alone.
- **Deferred**: Buffered/batched async export and retries remain deferred (spans currently export per-`end()`).
- Detailed in `docs/adr/0046-span-export-otlp.md` and `docs/OBSERVABILITY.md`.

Prior: M13 Increment 2 — tracing and propagation (ADR-0045): Request span emission, deterministic sampling, and outbound `traceparent` propagation in `@chess-platform/api`.
- **Tracer Port**: `Tracer`, `Span`, `SpanData`, `NullTracer`, `RecordingTracer`, `InMemorySpanRecorder` ring buffer in `packages/api/src/ports/tracer.ts`.
- **Sampling**: `alwaysOnSampler` default and deterministic `probabilitySampler(ratio)` based on the first 8 hex chars of `traceId`. Respects inbound `parentSampled` decision.
- **Trace Context Propagation**: Hand-rolled `formatTraceparent` (`00-<traceId>-<spanId>-<flags>`), `generateSpanId`, and `isSampled` in `traceparent.ts`. Router sets outbound `traceparent` header on every response.
- **Server Spans**: Per-request `http.server` span in `router.ts`, attributed with route pattern (`http.route`), HTTP method (`http.method`), and numeric status code (`http.status_code`). Sets span status to `'error'` for status >= 500 and `'ok'` for <500.
- **Production Exporter**: Production `bootstrap.ts` injects a `RecordingTracer` emitting finished spans to structured logs (`JsonLogger`) with a `pickBoundedAttrs` whitelist (`http.method`, `http.route`, `http.status_code`), maintaining PII and cardinality discipline.
- Detailed in `docs/adr/0045-tracing-and-propagation.md` and `docs/OBSERVABILITY.md`.

Prior: M14 Increment 6 — external-secrets (ADR-0044): External Secrets Operator (`external-secrets.io/v1`) integration for the Gambit Helm chart (`deploy/helm/gambit/`).
When `secrets.externalSecrets.enabled=true`, the chart renders an `ExternalSecret` custom resource (`apiVersion: external-secrets.io/v1`) that ESO reconciles into a Kubernetes Secret named `<fullname>-secret`, sourced from a backing SecretStore / ClusterSecretStore.
- `spec.target.name` equals `include "gambit.secretName" .` so `api` and `gateway` Deployments consume `ACCESS_TOKEN_SECRET` and `POSTGRES_PASSWORD` via `secretKeyRef` with zero modifications to Deployment manifests.
- The inline Opaque `Secret` and its fail-closed min-length checks are skipped in ES mode.
- `secrets.externalSecrets` and `secrets.existingSecret` are strictly mutually exclusive (fail-closed in chart).
- CI workflow validates the external-secrets render case via `kubeconform -strict -ignore-missing-schemas`.
- Detailed in `docs/adr/0044-external-secrets.md`, `deploy/helm/gambit/README.md`, and `docs/DEPLOYING.md`.

Prior: M12 Anti-Cheat Increment 8 (ADR-0043): Production engine wiring and gateway hosting for anti-cheat auto-analyzer (createEngineProviderFromEnv, createEngineBackedAnalysisService, serve.ts ANTICHEAT_AUTO_ANALYZE=1 hosting block and graceful engine shutdown).


Prior: M12 Bot Detection Increment 6 (ADR-0041): Automatic auto-analysis worker and gateway hosting for bot detection (BotAnalysisService, BotAutoAnalyzer, refactored analyze route, serve.ts BOT_AUTO_ANALYZE=1 hosting block).

Prior: M12 Bot Detection Increment 4 (ADR-0039): Bot detection service and report repository (`BotDetectionService` & `BotBehaviorReportRepository` with `InMemoryBotBehaviorReportRepository` in `@chess-platform/anti-cheat`, `AnalyzeBotAndStoreInput`, `GameBotReport`, idempotent `(playerId, gameId)` nested-map upsert, `analyzeAndStore` and `aggregatePlayer` composition).


Prior: M12 Bot Detection Increment 3 (ADR-0038): Move-timing extraction (`extractTimedMoves` in `@chess-platform/anti-cheat`, `MoveTiming`, `GameTimings`, minimal decoupled projection from `MovePlayedEvent.moveTimeMs`, `isBook` predicate seam for opening-book exclusion).

Prior: M12 Bot Detection Increment 1 (ADR-0036): Pure domain behavioral move-time analyzer (`analyzeBotBehavior` in `@chess-platform/anti-cheat`, `TimedMove` timing interface, mean/stdev move time, coefficient of variation, near-instant move fraction, lowConfidence gate, and deterministic suspicion banding).

Prior: M12 Anti-Cheat Increment 7 (ADR-0035): Automated auto-analysis worker (`gamesEndedChannel` fan-out in `@chess-platform/realtime-gateway`, single-owner authority broadcast, `AntiCheatAutoAnalyzer` worker in `@chess-platform/api` with dedup, at-least-once safety, crash-safe error handling, and drain hook).

Prior: M12 Anti-Cheat Increment 6 (ADR-0034): On-demand analysis-trigger pipeline (`FinishedGameSource` port + `EventStoreGameSource` adapter, `AntiCheatAnalysisService` application service, and `POST /v1/moderation/anti-cheat/games/:gameId/analyze` endpoint, audited and `MODERATION`-gated, 503 when unconfigured).

Prior: M12 Anti-Cheat Increment 5 (ADR-0033): Postgres persistence (`anti_cheat_reports` table, `PgAntiCheatReportRepository` with atomic `saveBatch` transactions and `(player_id, game_id)` upsert) and read-only moderation REST API (`GET /v1/moderation/anti-cheat/players/:playerId` and `GET /v1/moderation/anti-cheat/players/:playerId/games`, audited, `moderator`/`admin`-gated).

Prior: M12 Anti-Cheat Increment 4 (ADR-0032): AntiCheatService and AntiCheatReportRepository port with an in-memory adapter. The pure orchestration composes earlier increments into a usable flow: analyzing a game, saving both players' reports atomically via `saveBatch` keyed by `(playerId, gameId)` for idempotency, and fetching reports to aggregate an account-level signal.

Prior: M12 Anti-Cheat Increment 3 (ADR-0031): EngineBackedEvaluator adapter bridging the pure anti-cheat domain to the real @chess-platform/engine. Adds extractPlies to parse full games, negates resulting position evaluation to price sub-optimal moves, and safely handles terminal positions. Prior: M12 Anti-Cheat Increment 2 (ADR-0030): cross-game, account-level
suspicion aggregation in `@chess-platform/anti-cheat`. `aggregatePlayer(games)` combines a player's
per-game `PlayerCorrelationReport`s (the side the account played each game) into one
`PlayerAggregateReport` by **pooling** raw numerators/denominators (never averaging per-game rates —
a 3-ply game must not weigh like a 60-ply one), with sample-weighted ACPL and pooled T1/T3. Increment
1's report now exposes those raw counts (`t1Matches`/`t3Matches`/`tRateSampleCount`/
`rawCentipawnLossTotal`/`cappedCentipawnLossTotal`); the suspicion thresholds are shared constants so
per-game and aggregate bands can't diverge. An aggregate confidence gate (`AGG_MIN_GAMES=3`,
`AGG_MIN_POOLED_TRATE=40`) means one anomalous game can't flip an account while many individually
low-confidence games can still form a confident aggregate; duplicate `gameId`s are rejected so a
retried history read can't double-count. `flaggedGameIds` drills reviewers to the anomalous games.
Pure domain, no I/O/DB wiring (later increment). **Review note:** the increment was reconstructed on
current `main` — Gemini's branch had been cut from a stale `main` and built the aggregator on the
pre-review *blended* per-game report, which would have reverted Increment 1's per-player separation
and CodeRabbit fixes; aggregation is now correctly per-player. Prior: M12 Anti-Cheat Increment 1
(ADR-0029): the `@chess-platform/anti-cheat` pure domain package with `analyzeGame` — ACPL (raw +
per-ply-capped), T1/T3 match rates, only-move + opening-book exclusions, `lowConfidence`, and
deterministic suspicion bands (`clean`/`review`/`high`) over a `PositionEvaluator` port; splits by
side into a per-player `{ white, black }` report so a cheater isn't diluted by the opponent's human
moves. Prior: M13 Observability, Increment 1 (ADR-0028), completed in a review pass:
the `Logger`/`Metrics`/`traceparent` ports the router referenced were missing (branch did not
build) — they are now implemented (dependency-free `JsonLogger`/`NullLogger`,
`InMemoryMetrics`/`NullMetrics` with Prometheus `render()`, W3C `traceparent` parse), wired through
the composition root (shared metrics instance for the recorder + `GET /v1/metrics`; `JsonLogger`
in production `bootstrap.ts`), plus review fixes: bounded failure-path metric cardinality
(`req.method` → known verb or `OTHER`), a `gateway_auth_failures_total` counter via a wrapped
`TokenVerifier`, and `startHarness` extended to inject readiness/logger. Port + endpoint +
redaction + traceparent tests added; PII/cardinality rules enforced (never label by userId/gameId/
handle/IP; never log tokens/emails/bodies). Prometheus `/metrics` also exposed on the gateway
health port; readiness verifies real dependencies. Prior: WebAuthn security review fixes (post-merge of ADR-0027): (1) User
Verification is now **enforced** — options request `userVerification: 'required'` and both
register- and login-verify reject an authenticator-data flag with UV (0x04) unset (previously
a touch-only assertion authenticated, downgrading the guarantee); (2) login failures are now a
single uniform 401 — rpIdHash / User-Present / User-Verification / flag-invariant checks funnel
into the same failure path instead of throwing 422, closing a response-code oracle; (3)
deleting an account's only passkey when no password is set is refused with 409 (lockout guard).
Regression tests added (UV-absent register/login, uniform-401 across auth failures, last-passkey
delete). Prior: Playable Alpha Increment 2: Production game action controls (resign, offer draw, accept/decline draw, claim flag, abort) implemented in the web UI via GameSync. Prior: Playable Alpha Increment 1: Seek Acceptance (atomic match provisioning, frontend lobby play button). Prior: M4 Identity Hardening inc 2 review hardening: strict
typed `clientDataJSON` validation, complete authenticator-extension framing,
signature-counter regression protection, and reusable dummy verification key. Prior: M4 Identity Hardening inc 2: WebAuthn (passkeys) support
(ADR-0027): `webauthn_credentials` Postgres table + `WebAuthnCredentialsRepository`, auth-service logic for credential parsing/signature verification with `node:crypto` (ES256), and `POST /v1/auth/webauthn/*` endpoints with decoy flows. Prior: M4 Identity Hardening inc 1: password reset + email verification
(ADR-0026): `users.email` (CITEXT UNIQUE) + `identity_tokens` (hashed, single-use, TTL),
`EmailSender`/`IdentityTokensRepository` ports, three new `/v1/auth` endpoints with
anti-enumeration + rate limiting, full-session revocation on reset. Prior: M9 inc 13: Durable tournament result recording in production
(ADR-0025): optimistic concurrency (version CAS) on `TournamentsRepository`, the
`TournamentResultReporter` promoted from the e2e harness into `@chess-platform/api` and
hosted by `services/gateway` behind `TOURNAMENT_REPORTER=1` (startup rehydration + periodic
re-scan for games launched by other processes). **M1–M9 complete, M12 inc 1–3 complete, M14 increments 1–4 complete (M14 overall still in progress).** Prior: Repo review pass: fixed the two tournament routes that
predated the Arena format and never gained its dispatch — `POST
/v1/tournaments/:id/games/:gameId/result` (always 409'd for arenas; arenas had NO
result-recording path through the REST API) and `GET /v1/tournaments/:id/live`
(always 409'd for arenas) — plus `ArenaService` domain-error → HTTP mapping
(unknown gameId is now 404, not 500). Docs (README/AI_HANDOVER/ROADMAP) re-synced
with reality (M9 ✅, M12 🚧, live test counts). Prior: M9 inc 12: Arena realtime game lifecycle (ADR-0024). Prior: M9 inc 11: Arena through the API + persistence (ADR-0023). Prior: M9 inc 10: Arena tournament format (domain model) (ADR-0022). Prior: M9 inc 9: Tournament robustness (ADR-0021). Prior: M9 inc 8: Tournament Commentator AI feature (ADR-0020). Prior: M9 inc 7: Live tournament broadcast (ADR-0019). Prior: M9 inc 6: Real-time tournament integration (ADR-0018). Prior: M9 inc 5: Tournament game lifecycle (ADR-0017). Prior: M9 inc 4: Postgres adapter for tournament persistence. Prior: M9 inc 3: Tournament persistence & REST API (ADR-0016). Prior: M9 inc 2: Swiss pairing + round-by-round port evolution (ADR-0015). Prior: M12 inc 3: rate limiting for sensitive auth endpoints (ADR-0013). Prior: M14 increment 4 (Kubernetes Helm chart). **M7, M8, M9, M14 inc 1–4 complete.** Prior: Review #03 fixes applied:
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
| **M1** ✅ | `@chess-platform/core` | Variant-aware, perft-verified rules engine (0x88, immutable `Position`, FEN/UCI/SAN, 8 variants, terminal detection, repetition-key derivation) | 16/16 |
| **M2** ✅ | `@chess-platform/game` | Event-sourced `Game` aggregate + deterministic clocks; threefold repetition (en-passant legality-aware repetition key in `@chess-platform/core`); exact reconstruction via `Game.fromEvents` (~1.17ms/game) | 26/26 |
| **M3** ✅ | `@chess-platform/realtime-gateway` | Server-authoritative WS protocol, `GameAuthority`, rooms/presence/fanout, resume, latency comp; `PubSub`/`Transport` seams; token-based auth (`TokenVerifier` port, ADR-0004); durable `EventLog` port + Redis `PubSub` (M14) | 56/56 |
| **M4a** ✅ | `@chess-platform/persistence` | Durable append-only event store (in-memory + Postgres), migrations, repositories, Glicko-2, UUIDv7 | 14/14 (+5 DB-gated) |
| **M4b** ✅ | `@chess-platform/api` | Stateless REST + identity (scrypt/`PasswordHasher`, HMAC access tokens, rotating refresh tokens, RBAC), seeks/ratings/games, published OpenAPI 3.1 | 48/48 |
| **M5** ✅ | `@chess-platform/engine` | Provider-agnostic UCI engine bridge: `AnalysisProvider`/`EngineManager`/`EnginePool`/`EngineInstance`/`EnginePlugin`/`AnalysisCache`/`EngineTransport`; capability discovery, priority scheduler, watchdog/cancellation, crash→hot-replacement, circuit breaker, graceful drain, health | 50/50 |
| **M6** ✅ | `@chess-platform/web` | Playable web frontend: interactive board (drag/click, premoves, promotion), REST + WS client, GameSync, lobby, profile, theme, PWA, a11y; Playwright e2e + Lighthouse gate passed | 239 |
| **M7** ✅ | `@chess-platform/ai-orchestrator` | Provider-agnostic AI orchestration: `AiProvider`/`AiOrchestrator`/`ProviderRegistry`/`RoutingStrategy`/`ResponseCache`/`RateLimiter`/`HealthTracker`/`BenchmarkRunner`; OpenAI + Anthropic adapters; engine grounding | 114 |
| **M8** ✅ | `@chess-platform/ai-features` | 8 AI features: Move Explainer, Puzzle Generator, Mistake Predictor, Opening Explorer, Endgame Trainer, Coach, Study Partner, Voice Coach; Tournament Commentator deferred to M9 | 137 (16 key-gated) |
| **M9** ✅ | `@chess-platform/tournament` | **Increment 1 (pure domain):** tournament aggregate with a `registration → running → finished` state machine, a `PairingStrategy` port, `RoundRobinPairing` (circle-method/Berger schedule — every pair once, one bye per player for odd N, balanced colors), and Sonneborn-Berger standings (ADR-0014). **Increment 2 (Swiss pairing):** round-by-round `PairingStrategy` port (`pairNextRound(context): Round \| null`), `SwissPairing` (deterministic Monrad/Dutch-lite — score-group pairing via a complete backtracking match that never drops a player, no rematches, best-effort color balancing, configurable round count, graceful early finish when the field is exhausted), `Tournament` aggregate auto-advances round-by-round, `TournamentConfig` discriminated union (`round_robin` / `swiss`); full FIDE Dutch deferred (ADR-0015). **Increment 3 (persistence & API):** `TournamentSnapshot`-based persistence (`toSnapshot`/`restore`), an in-memory `TournamentsRepository` adapter, and a REST API (create/list/get/register/withdraw/start/record-result/standings) with OpenAPI schemas and `tournament_director` authorization (ADR-0016). **Increment 4:** Postgres adapter `PgTournamentsRepository` + `0003_tournaments.sql`. **Increment 5 (Game lifecycle):** gameLinks in aggregate, API GameLauncher port, reconcileLaunch loop in TournamentService, and recordResultByGame (ADR-0017). **Increment 6 (Real-time integration):** AuthorityGameLauncher mapping tournament pairings to realtime GameAuthority games, TournamentResultReporter subscribing to PubSub EndedBroadcast to auto-record results, per-pairing launch-attempt counter so aborted games auto-relaunch, implemented purely via composition root (ADR-0018). **Increment 7 (Live broadcast):** `TournamentLiveView` port (api) + `TournamentBroadcaster` (composition root) multiplexing every active game's live board, `tournamentChannel` fanout of `TournamentUpdateBroadcast` to spectators, and a public `GET /v1/tournaments/:id/live` returning live boards + standings (ADR-0019). **Increment 8 (Tournament Commentator):** `TournamentCommentator` AI feature in `ai-features` providing engine-grounded live commentary on games and data-grounded narrative round recaps (ADR-0020). **Increment 9-10:** Tournament robustness, Arena domain model (ADR-0021, ADR-0022). **Increment 11:** Arena persistence and API (ADR-0023). **Increment 12:** Arena realtime game lifecycle, continuous launching, result recording, and settle on read (ADR-0024). | 35 tournament + api lifecycle |
| **M12** 🚧 | Security hardening & Anti-cheat | **Increment 1:** CORS policy + security response headers for the API (`withSecurity` middleware — ACAO allowlist, credentials-aware, preflight short-circuit, `X-Content-Type-Options`/`Referrer-Policy`/`X-Frame-Options`/CSP/CORP/HSTS); ADR-0011 Accepted. **Increment 2:** httpOnly refresh-token cookie — API sets `HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=<ttl>; Secure` cookie on login/refresh; refresh/logout accept cookie or body token; web stops persisting refresh token to `localStorage`; access token in memory only; ADR-0012 Accepted. **Increment 3:** Rate limiting for auth endpoints — API injects a `RateLimiter` port (`InMemoryRateLimiter` default) to protect `/v1/auth/{login,register,refresh}`, returns `429 Too Many Requests` with `Retry-After`; ADR-0013 Accepted. **Increment 4:** Anti-cheat engine-correlation analyzer (pure domain package), ACPL/T1/T3 match rates, forced-move exclusion, and suspicion banding (ADR-0029). **Increment 5:** Cross-game, account-level suspicion aggregation — `aggregatePlayer` pools per-game per-player reports (weighted ACPL, pooled T1/T3), an aggregate confidence gate, and duplicate-game rejection (ADR-0030). **Increment 6:** EngineBackedEvaluator adapter and extractPlies bridging to real engine (ADR-0031). **Increment 7:** AntiCheatService and AntiCheatReportRepository orchestrating the flow (ADR-0032). | 77/77 (+4 inc 3) + 31 anti-cheat |
| **M13** 🚧 | Observability | **Increment 1:** Hand-rolled zero-dependency JSON logger and Prometheus text metrics implementation (`InMemoryMetrics`), strictly isolated as domain ports (`Logger` / `Metrics`). W3C `traceparent` parsing in API router, injecting request context (traceId, logger). Automated HTTP route cardinalities. Gateway instrumented with metrics and logs. (ADR-0028 Accepted) | — |
| **M14** 🚧 | Deployable services | Docker Compose local stack (inc 1), durable EventLog + Postgres (inc 2), Redis pub/sub multi-node fanout (inc 3), Kubernetes Helm chart (inc 4); Terraform/blue-green/load-test deferred | — |

**Whole-repo total: 1049 tests passing, 0 failures, across 13 packages + the gateway service** (31 skips, all environment-gated — Postgres/API-key/Redis; `npm run test:counts` prints the live per-package breakdown). Strict TS, zero errors, lint clean. CI active — 6 jobs: build+typecheck+test on Node 22/24, Postgres integration, M6 Playwright + Lighthouse acceptance, helm lint + kubeconform, gateway service (build + Redis integration).

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

- **Tournaments (M9 follow-ups):** items 1 (production result reporter) and
  2 (optimistic concurrency for `TournamentsRepository`) from the 2026-07-18
  review are **CLOSED by M9 inc 13** (ADR-0025). Still open:
  1. Arena `withdraw` is permanent by design — `register` after `withdraw`
     does not re-admit the player (the domain keeps them in `withdrawn`).
     Lichess-style pause/rejoin needs an explicit domain decision + ADR.
  2. Reporter refinements (ADR-0025 consequences): an event-log catch-up read
     for `EndedBroadcast`s missed between game end and first subscription, and
     a dedicated single-replica reporter Deployment instead of
     one-reporter-per-gateway-replica.
- **Identity (M4 → hardening pass):** **WebAuthn/passkeys** are NOT implemented yet.
  The `webauthn_credentials` table exists in the schema; add a `WebAuthnRepository`
  + registration/assertion ceremonies. Password-reset + email verification flows are **IMPLEMENTED** (M4 identity hardening inc 1).
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
- **Token-storage tradeoff (web):** **Resolved in M12 inc 2** (ADR-0012).
  The refresh token now lives in an `httpOnly` cookie (not `localStorage`),
  and the access token is kept in memory only. See ADR-0012 for details.

## 6. Technical debt (status)

1. **`LICENSE` — ✅ DONE** (AGPL-3.0, commit `d295ad2`).
2. **CI — ✅ ACTIVE.** `.github/workflows/ci.yml` runs **six** jobs on every push/PR
   to `main`: build + typecheck + test on Node 22.x/24.x, the Postgres
   integration job (persistence against a real database), the M6 acceptance
   gate (Playwright full-game e2e + Lighthouse a11y ≥ 0.95), the M14 Helm
   job (`helm lint` + `helm template | kubeconform` for both the bundled and
   external-datastore renders), and the **gateway service** job (build + Redis
   integration tests). The formerly staged copies (`docs/ci/ci.yml`,
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
- ~~`additionalProperties: false` is documented in the OpenAPI request schemas but the
  runtime validators don't yet reject unknown fields (they ignore them).~~ **RESOLVED:**
  `strictObject()` in `http/validate.ts` is applied to every mutating route in
  `routes.ts` and rejects unknown fields with a 422 `validation_failed` response.
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
1. **M4 identity hardening:** WebAuthn/passkeys (table exists). (Password reset + email verification are complete).
2. **Small deferred correctness:** PGN parser, per-variant timeout rules.
3. **M9 Tournaments & broadcast:** Arena pairing, FIDE Dutch compliance, live broadcast.
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

## M9 Increment 11: Arena through the API + persistence
- **Parallel Arena Service**: In order to securely implement API access to the `ArenaTournament` format without jeopardizing the stability of round-based formats (round-robin and swiss), `TournamentConfig` was split into `RoundBasedConfig` and `ArenaConfig`.
- **API Branching**: `ArenaService` isolates arena-specific behavior. The REST endpoints natively branch based on the tournament format, falling back to `TournamentService` for standard formats.
- **Persistence**: Reused `TournamentsRepository` completely by introducing `TournamentAnySnapshot`. `ArenaSnapshot` handles distinct fields for the arena schema. No schema migrations needed as `jsonb` absorbs the structural differences smoothly.
- **Testing**: Added integration test suite explicitly for validating Arena tournaments natively through the API.

## M9 Increment 13: Durable tournament result recording in production
- **Optimistic Concurrency Control**: Added OCC to the `TournamentsRepository` to prevent lost updates in the domain (using a row-version increment with an automated 3-attempt CAS retry loop).
- **Production Reporter**: Extracted `TournamentResultReporter` into `@chess-platform/api` to act as a production-grade long-running background worker running alongside the gateway. The reporter tracks pubsub topics for ongoing games to drive tournament progression durably, surviving temporary crashes or downtime by catching up on startup.
- **Leak Fix**: Fixed test memory leak by supporting graceful `stop()` and event subscription deregistration in `TournamentResultReporter`.

## M4 Identity Hardening — Increment 1: password reset + email verification (ADR-0026)
- **Email storage**: `users` gains a nullable `email CITEXT UNIQUE` column (plus
  `email_verified_at`), populated at registration alongside the existing
  `email_hash`; the privacy tradeoff is recorded in ADR-0026. Migration
  `0007_identity_hardening.sql` also adds the `identity_tokens` table
  (kind CHECK `password_reset` | `email_verify`, token stored as SHA-256 hash,
  TTL-bound, single-use).
- **Flows**: `POST /v1/auth/password-reset/request` (always 202 —
  anti-enumeration; rate-limited per-IP and per-target), `POST
  /v1/auth/password-reset/confirm` (atomic single-use consume, new password via
  `PasswordHasher`, ALL sessions/refresh chains revoked, refresh cookie
  cleared), `POST /v1/auth/email/verify`; registration issues a verification
  token when an email is provided. All audited; OpenAPI regenerated.
- **Ports**: `EmailSender` (`InMemoryEmailSender` for tests, `ConsoleEmailSender`
  as the stand-in production default — a real provider adapter is a later
  increment) and `IdentityTokensRepository` (in-memory + Postgres; consumption
  is one conditional `UPDATE ... RETURNING`, race-free by construction).
- **Review hardening**: pre-reset refresh tokens proven dead after a reset;
  expired-token rejection via the injected clock; the in-memory users fake now
  mirrors the email UNIQUE constraint (duplicate email registration → 409).

## M4 Identity Hardening — Increment 2: WebAuthn / Passkeys (ADR-0027)
- **Storage**: Added `webauthn_login_challenges` to Postgres for stateless login challenge handling without fake user FKs.
- **Security Primitives**: Hardened `decodeFirst` CBOR parser against trailing bytes, recursion limits, and duplicate map keys.
- **Anti-Enumeration**: `allowCredentials` omitted from login options to prevent handle enumeration. Login flow uses decoy challenges (HMAC) for non-existent users.
- **Sign Counts**: Atomic concurrency control when updating sign counts via `WebAuthnCredentialsRepository.updateSignCount`.
- **API Endpoints**: Rate-limited `POST /v1/auth/webauthn/*` endpoints with comprehensive tests validating ceremony and decoy behaviors.

## M4 Identity Hardening — Increment 2 Review Hardening
- **Client data validation**: Both WebAuthn ceremonies now require typed, canonical client-data challenges, exact ceremony type, an allowed origin, `crossOrigin: false` when present, and no `topOrigin` under the current same-origin policy; malformed data returns 422 instead of reaching `node:crypto` as a 500.
- **Authenticator data framing**: The parser rejects trailing bytes unless the ED flag is set, and requires ED payloads to be one complete CBOR map for both assertions and attested credential data.
- **Counter/replay protection**: A stored non-zero signature counter can no longer regress to zero, and the in-memory repository now mirrors the Postgres compare-and-update rule.
- **Resource hardening**: Unknown credentials reuse one process-level dummy EC key instead of synchronously generating a key pair for every unauthenticated verification request.
- **Regression coverage**: Added tests for extension framing, signature-counter regression, malformed challenges, and forbidden `topOrigin`.

## Playable Alpha Increment 1: Seek Acceptance
- **Atomic Matching**: Added `POST /v1/seeks/:id/accept` endpoint in `@chess-platform/api` which checks rating boundaries and enforces game-ownership assignment.
- **Persistence**: Implemented `PgSeekAcceptor` in `@chess-platform/persistence` that uses an atomic row-locking `UPDATE ... WHERE game_id IS NULL` to claim the seek while provisioning the `game_id`, avoiding race conditions between simultaneous acceptors. Database schema updated with `0009_seek_match_receipts.sql` to support the tracking of matched games.
- **Lobby Integration**: Updated `@chess-platform/web`'s `LobbyController` and `bootstrap.ts` to render 'Play' buttons on opponent seeks. Upon successful acceptance, both players automatically route to the game via client-side redirection.
- **Verification**: E2E verification implemented in `packages/web/e2e/seek-acceptance.spec.ts` modeling the entire slice: Player 1 creates seek -> Player 2 accepts -> both land on the board page and connect successfully.

## M13 Observability — Increment 1 (ADR-0028)
- **JSON Logger**: Implemented a zero-dependency `JsonLogger` mapped behind a generic `Logger` port in `@chess-platform/api`. It supports W3C `trace_id` injection and automatic redaction of sensitive keys (`password`, `token`).
- **Prometheus Metrics**: Implemented a hand-rolled `InMemoryMetrics` engine mapped behind a `Metrics` port, generating spec-compliant Prometheus text format. Enforces strict metric cardinality bounds.
- **API Instrumentation**: Updated `router.ts` to parse W3C `traceparent` headers for distributed tracing, injecting trace context into the route handlers. Also instruments every route automatically with bounded-cardinality route tags (avoiding unbounded params). Exposed `GET /v1/metrics`.
- **Gateway Instrumentation**: Realtime gateway updated to replace `console.log` with `JsonLogger`, introduced connection, message, and auth failure metrics, and exposed `GET /metrics`.

## M12 Anti-Cheat Increment 1 — Engine-Correlation Analysis (ADR-0029)
- **Domain logic**: Created `@chess-platform/anti-cheat` as a pure, dependency-free domain package.
- **Metrics**: Implemented `analyzeGame` to calculate Average Centipawn Loss (ACPL) with a 300cp cap and MATE encoding, T1/T3 match rates, and deterministic suspicion bands (`clean`, `review`, `high`).
- **Mitigations**: Opening-book plies are excluded from *every* metric. Forced moves (only-move gap >= 200cp) are excluded from the **T1/T3 match rates only** — they still count toward ACPL and `sampleSize`, since playing the sole reasonable move is not itself suspicious but the position was still played. Applies a `lowConfidence` flag for low engine depth, small ACPL sample size, or a thin T1/T3 denominator.
- **Hermetic tests**: Tested against deterministic `InMemoryEvaluator` fakes.
- **Poolable counts**: The per-player report also exposes raw numerators/denominators (`t1Matches`, `t3Matches`, `tRateSampleCount`, `rawCentipawnLossTotal`, `cappedCentipawnLossTotal`) so Increment 2 can aggregate games by pooling rather than averaging rates.

## M12 Anti-Cheat Increment 2 — Cross-Game Aggregation (ADR-0030)
- **Account-level signal**: `aggregatePlayer(games)` combines a player's per-game `PlayerCorrelationReport`s (the side the account played each game) into one `PlayerAggregateReport`.
- **Pool, never average**: T1/T3 are pooled (Σ matches ÷ Σ eligible plies) and ACPL is a sample-weighted mean (Σ loss ÷ Σ `sampleSize`) — a 3-ply game cannot weigh like a 60-ply one. A test asserts pooling differs from naive per-game averaging.
- **Per-player, not blended**: aggregation consumes `PlayerCorrelationReport`, so a cheater is never diluted by the opponent's human moves — the same isolation as Increment 1, carried to the account level.
- **Confidence gate**: `AGG_MIN_GAMES = 3` and `AGG_MIN_POOLED_TRATE = 40`. One anomalous game can't flip an account; many individually low-confidence games can still form a confident aggregate once pooled.
- **Shared thresholds**: the `high`/`review` bands reuse Increment 1's exact numeric constants (imported) so per-game and aggregate bands can't diverge.
- **Duplicate rejection**: a repeated `gameId` throws, so a retried/overlapping history read can't double-count a game and inflate confidence.
- **Reviewer drill-down**: `flaggedGameIds` lists the games whose per-game suspicion was `review`/`high`.
- **Reconstruction note**: the increment was rebuilt on current `main`; the original branch had been cut from a stale `main` and built the aggregator on the pre-review *blended* per-game report, which would have reverted Increment 1's per-player separation and CodeRabbit fixes.

## M12 Anti-Cheat Increment 4 — Service and Repository (ADR-0032)
- **Application Layer**: Introduced `AntiCheatService` and `AntiCheatReportRepository` to compose Increments 1-3 into a usable flow.
- **Pure Orchestration**: The service orchestrates analyzing a game, saving reports for both players, and aggregating a player's history. It depends only on injected ports, keeping the domain logic pure and independent of specific persistence or engine implementations.
- **Idempotency Guarantee**: Reports are stored keyed by `(playerId, gameId)`. `InMemoryAntiCheatReportRepository` uses a nested map (`playerId` -> `gameId` -> `report`). This ensures re-analyzing a game replaces the prior record rather than appending a duplicate, so `aggregatePlayer`'s duplicate game guard will never trip. Both players' reports are persisted atomically via `saveBatch`.
- **Deferred Storage**: Postgres implementation and moderation REST APIs are deferred to a later increment, proving the domain patterns fully in-memory first.

## M12 Anti-Cheat Increment 5 — Postgres Persistence & Moderation REST API (ADR-0033)
- **Postgres Schema**: Migration `0010_anti_cheat_reports.sql` creates table `anti_cheat_reports` storing `player_id`, `game_id`, `color`, and `report` JSONB with `PRIMARY KEY (player_id, game_id)`. Opaque IDs without foreign keys preserve analytical records independently of user/game row lifecycles.
- **Repository Implementation**: `PgAntiCheatReportRepository` in `@chess-platform/persistence` implements `AntiCheatReportRepository`. `saveBatch` persists white and black reports in one atomic transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`). Upserts replace existing reports on `(player_id, game_id)` conflict for idempotency.
- **Moderation REST API**: Added `GET /v1/moderation/anti-cheat/players/:playerId` (account aggregate) and `GET /v1/moderation/anti-cheat/players/:playerId/games` (per-game history) to `@chess-platform/api`, gated by policy `MODERATION` (`moderator` or `admin` role). Both endpoints record audit entries (`anti_cheat.aggregate.view` / `anti_cheat.games.view`).
- **OpenAPI Document**: Updated OpenAPI 3.1 specification committed to `packages/api/openapi.json` with new component schemas (`AntiCheatPlayerReport`, `AntiCheatGameReportView`, `AntiCheatAggregateView`, `AntiCheatGameReportList`) and route definitions.
- **Root Build Pipeline**: Moved `@chess-platform/engine` and `@chess-platform/anti-cheat` ahead of `@chess-platform/persistence` and `@chess-platform/api` in root `package.json` `build`, `test`, and `lint` scripts to reflect the new package dependency graph.
- **Next Steps**: The on-demand analysis pipeline landed in Increment 6 (below); the automated background/PubSub trigger is deferred to Increment 7.

## M12 Anti-Cheat Increment 6 — On-Demand Analysis Pipeline (ADR-0034)
- **Application Services**: Added `FinishedGameSource` interface and `EventStoreGameSource` adapter in `@chess-platform/api` to load historical events, reconstruct games via `Game.fromEvents`, and validate finished status and player presence. Implemented `AntiCheatAnalysisService` composing `FinishedGameSource`, `extractPlies`, evaluator factory, and `AntiCheatService.analyzeAndStore`.
- **Moderation REST Endpoint**: Added `POST /v1/moderation/anti-cheat/games/:gameId/analyze` to `@chess-platform/api`, gated by policy `MODERATION`. Parses optional `depth` parameter `[8, 30]`, records audit entry (`anti_cheat.analyze`), runs analysis, and returns `AntiCheatGameAnalysisView` (`{ white, black }`). Returns 503 if engine is not configured.
- **Engine Gating & Wiring**: Production bootstrap (`createPgDependencies`) env-gates `AntiCheatAnalysisService` behind `PgBootstrapOptions.analysisProvider`. Test harness (`startHarness`) wires a deterministic fake evaluator for hermetic integration testing.
- **OpenAPI Document**: Updated OpenAPI 3.1 specification committed to `packages/api/openapi.json` with new component schemas (`AnalyzeGameRequest`, `AntiCheatGameAnalysisView`) and route documentation.
- **Automated Worker Deferred**: Automated background/PubSub auto-analysis worker deferred to Increment 7.

## M12 Anti-Cheat Increment 7 — Automated Auto-Analysis Worker (ADR-0035)
- **Global Game-Ended Channel**: Added `gamesEndedChannel()` (`games:ended`) to `@chess-platform/realtime-gateway` and exported it from the package root.
- **Authority Fan-Out**: Updated `GameAuthority` publish loop to fan out terminal `EndedBroadcast` messages to `gamesEndedChannel()`. Because each live game has a single authority owner (ADR-0010), each game's completion is published to `gamesEndedChannel()` exactly once.
- **Auto-Analysis Worker**: Implemented `AntiCheatAutoAnalyzer` in `@chess-platform/api` (`packages/api/src/anti-cheat/auto-analyzer.ts`). Subscribes to `gamesEndedChannel()`, deduplicates seen game IDs, tracks background analysis promises in an `inFlight` set, and provides a `drain()` hook for deterministic testing.
- **Crash Safety & Idempotency**: Analysis rejections trigger `onError` (or `console.error`) and remove the game ID from `seen` so subsequent re-broadcasts can retry. The pubsub message handler never throws, preventing host crashes. Upserts in `AntiCheatAnalysisService` guarantee idempotent report storage.
- **Package Exports**: Exported `AntiCheatAutoAnalyzer`, `AntiCheatAnalysisService`, and `EventStoreGameSource` from `@chess-platform/api` root index.
- **Hermetic Test Suite**: Added `packages/api/test/anti-cheat-auto-analyzer.test.ts` covering end-to-end auto-analysis, crash-safety/error handling, deduplication, non-ended message filtering, and `stop()` cleanup.

## M12 Bot Detection Increment 1 — Behavioral Move-Time Analyzer (ADR-0036)
- **Pure Domain Analyzer**: Added `analyzeBotBehavior` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-behavior.ts`) to analyze move-time distributions for a single player in one game.
- **Timing Interface**: Defined `TimedMove` interface with move duration `ms` and opening-book flag `isBook`.
- **Metrics & Signals**: Computes `meanMs`, population standard deviation `stdevMs`, `coefficientOfVariation` (`stdev / mean`), near-instant move count `instantMoves` (`ms <= 150`), and `instantFraction`.
- **Confidence Gate & Suspicion Banding**: Low confidence gate (`sampleSize < 10`) forces report to `clean`. Confident reports take the max suspicion band between CV band (`<= 0.25` -> `high`, `<= 0.5` -> `review`) and near-instant band (`>= 0.9` -> `high`, `>= 0.7` -> `review`).
- **Human Moderation Screening**: Serves strictly as a screening signal for human review queues, never auto-banning (per ARCHITECTURE §7).
- **Hermetic Tests**: Unit test suite in `packages/anti-cheat/test/bot-behavior.test.ts` covering uniform bots, human pacing, low confidence gating, book exclusions, empty input, numeric accuracy, and review bands.

## M12 Bot Detection Increment 2 — Cross-Game Aggregation (ADR-0037)
- **Account-Level Behavioral Aggregation**: Added `aggregateBotBehavior` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-aggregate.ts`) to combine an account's per-game `BotBehaviorReport`s into a single `BotAggregateReport`.
- **Pool Raw Moments, Never Average**: Extended `BotBehaviorReport` with raw poolable moments `sumMs` (Σ ms) and `sumSqMs` (Σ ms²). Aggregation pools raw timing sums across games (`pooledMeanMs`, `pooledStdevMs`, `pooledCoefficientOfVariation`, `pooledInstantFraction`) rather than averaging per-game rates, avoiding skew from short games.
- **Aggregate Confidence Gate**: Enforces `BOT_AGG_MIN_GAMES = 3` and `BOT_AGG_MIN_POOLED_SAMPLE = 40`. Aggregates with fewer games or smaller pooled move samples set `lowConfidence: true` and remain `clean`.
- **Shared Suspicion Banding**: Extracted `behaviorSuspicion` as a shared pure helper in `bot-behavior.ts` used by both `analyzeBotBehavior` and `aggregateBotBehavior`, guaranteeing per-game and account-level thresholds cannot diverge.
- **Duplicate Rejection**: Rejects duplicate `gameId`s with a thrown `Error` to prevent double-counting game history.
- **Reviewer Drill-Down**: Surfaces `flaggedGameIds` listing games whose per-game suspicion was `review` or `high`.
- **Hermetic Tests**: Unit test suite in `packages/anti-cheat/test/bot-aggregate.test.ts` covering pooling vs averaging, confidence gates, confident escalation, duplicate rejection, flagged game collection, empty inputs, and exact pooled statistics math.

## M12 Bot Detection Increment 3 — Move-Timing Extraction (ADR-0038)
- **Pure Domain Move-Timing Bridge**: Added `extractTimedMoves` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-extract.ts`) to split a game's ordered per-move timings into per-player `TimedMove[]` (`{ white, black }`) ready for `analyzeBotBehavior`.
- **Decoupled Projection**: Accepts minimal `MoveTiming` (`{ by: Color, moveTimeMs: number }`) without depending on `@chess-platform/game` or event log infrastructure.
- **Direct Clock Timing**: Uses pre-computed `MovePlayedEvent.moveTimeMs` directly as `ms` without clock-delta math.
- **Book Exclusion Seam**: Supports an `isBook(moveIndex: number)` predicate to flag opening-book plies so `analyzeBotBehavior` excludes them from behavioral statistics.
- **Hermetic Tests**: Unit test suite in `packages/anti-cheat/test/bot-extract.test.ts` covering alternating split, `ms` mapping, book marking, empty input, single-color/uneven input, and end-to-end extract -> analyze bridge triggering high suspicion.

## M12 Bot Detection Increment 4 — Service + Report Repository (ADR-0039)
- **Repository Port & In-Memory Adapter**: Added `BotBehaviorReportRepository` interface and `InMemoryBotBehaviorReportRepository` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-repository.ts`) with `saveBatch` and `listByPlayer`.
- **Nested-Map Idempotent Upsert**: `InMemoryBotBehaviorReportRepository` keys records by `(playerId, gameId)` in a nested map (`Map<playerId, Map<gameId, StoredBotReport>>`), replacing prior records on re-analysis so duplicate-`gameId` error guards in `aggregateBotBehavior` never trip.
- **Pure Domain Service**: Added `BotDetectionService` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-service.ts`) composing `extractTimedMoves` → `analyzeBotBehavior` → `saveBatch` (`analyzeAndStore`) and `listByPlayer` → `aggregateBotBehavior` (`aggregatePlayer`).
- **Engine-Free Simplicity**: Operates entirely on move-timing data without requiring an engine/evaluator adapter (unlike `AntiCheatService`).
- **Hermetic Tests**: Unit test suites in `packages/anti-cheat/test/bot-repository.test.ts` and `packages/anti-cheat/test/bot-service.test.ts` covering batch storage, idempotent upsert replacement, unknown player fallback, multi-game bot escalation vs human clean aggregates, and `isBook` predicate delegation.

## M12 Bot Detection Increment 5 — Postgres Persistence & Moderation REST API (ADR-0040)
- **Database Schema**: Added migration `0011_bot_reports.sql` creating `bot_reports` table (`player_id`, `game_id`, `color`, `report JSONB`, `created_at`, `updated_at`) with composite primary key `(player_id, game_id)` and supporting index `(player_id, created_at)`.
- **Postgres Repository**: Added `PgBotBehaviorReportRepository` in `@chess-platform/persistence/pg` implementing atomic `saveBatch` (SQL `BEGIN`...`COMMIT` transaction with `ON CONFLICT (player_id, game_id) DO UPDATE`) and `listByPlayer`. Re-exported from `@chess-platform/persistence/pg`.
- **Timing Source Adapter**: Added `EventStoreBotTimingSource` in `@chess-platform/api/src/bot-detection/source.ts` implementing `BotGameTimingSource` to project finished game events into `BotFinishedGame` (`white`, `black`, `moves`).
- **Moderation REST Endpoints**: Added three `MODERATION`-gated, audited endpoints in `@chess-platform/api`:
  - `GET /v1/moderation/bot-detection/players/:playerId` (audits `bot_detection.aggregate.view`, returns `BotAggregateView`).
  - `GET /v1/moderation/bot-detection/players/:playerId/games` (audits `bot_detection.games.view`, respects `limit`, returns `BotGameReportList`).
  - `POST /v1/moderation/bot-detection/games/:gameId/analyze` (audits `bot_detection.analyze`, loads timings via `botTimingSource`, triggers `BotDetectionService.analyzeAndStore`, returns `BotGameAnalysisView`). Unconditionally available without engine setup (throws 503 if `botTimingSource` is missing).
- **OpenAPI & Wire Integration**: Added presenter functions/views in `presenters.ts` and OpenAPI component schemas in `schemas.ts`. Updated `deps.ts`, `server.ts`, `fakes.ts`, `bootstrap.ts`, and test `helpers.ts`.
- **Tests**: DB-gated integration test in `packages/persistence/test/bot-reports.integration.test.ts` and API test suites in `packages/api/test/bot-detection.test.ts` and `packages/api/test/bot-detection-analyze.test.ts`.

## M12 Bot Detection Increment 6 — Automatic Auto-Analysis Worker & Gateway Hosting (ADR-0041)
- **BotAnalysisService Application Service**: Added `BotAnalysisService` in `@chess-platform/api` (`packages/api/src/bot-detection/analysis-service.ts`) encapsulating `BotGameTimingSource` and `BotDetectionService`, exposing `analyzeAndStore(gameId)`.
- **BotAutoAnalyzer Worker**: Added `BotAutoAnalyzer` in `@chess-platform/api` (`packages/api/src/bot-detection/auto-analyzer.ts`). Subscribes once to `gamesEndedChannel()`, deduplicates game IDs up to `MAX_SEEN = 10_000` with FIFO eviction, tracks background analysis in `inFlight`, handles rejections safely via contained `onError` hook without failing promises/drain, and provides a deterministic `drain()` method.
- **REST Analyze Route Refactoring**: Updated `POST /v1/moderation/bot-detection/games/:gameId/analyze` in `packages/api/src/routes.ts` to consume `BotAnalysisService`, removing inline loading and analysis duplication.
- **Gateway Process Hosting**: Hosted `BotAutoAnalyzer` in `services/gateway/src/serve.ts` behind optional environment variable `BOT_AUTO_ANALYZE === '1'`. Requires `DATABASE_URL` (instantiates `PgBotBehaviorReportRepository` and `EventStoreBotTimingSource`). Requires no engine process. Stop hook wired into graceful shutdown.
- **Package Exports & Documentation**: Exported bot detection source, analysis service, and auto-analyzer from `@chess-platform/api` index. Documented ADR-0041 and updated roadmap.
- **Hermetic Tests**: Added unit test suite in `packages/api/test/bot-detection-auto-analyzer.test.ts` covering end-to-end auto-analysis, crash-safety and contained error hooks, retry on re-broadcast, deduplication, and subscriber filtering/cleanup.

## M12 Anti-Cheat Correctness Hardening (ADR-0042)
- **Identical Player ID Validation**: `AntiCheatService.analyzeAndStore` now throws an error if `input.players.white === input.players.black`, preventing silent record overwrites in composite PK `(player_id, game_id)` storage.
- **Deterministic Repository Ordering**: Updated `PgAntiCheatReportRepository.listByPlayer` SQL to `ORDER BY created_at ASC, game_id ASC` with `game_id` tie-breaker. Added migration `0012_anti_cheat_reports_index.sql` replacing index with `(player_id, created_at, game_id)` for index-backed deterministic pagination.
- **Documentation & Parity**: Updated `docs/DATABASE.md` §4.5, `docs/ROADMAP.md`, and added `docs/adr/0042-anticheat-correctness-hardening.md`.

## M12 Anti-Cheat Increment 8 — Production Engine Wiring & Gateway Hosting (ADR-0043)
- **Engine Provider Factories**: Added `createEngineProviderFromEnv()` (reads `STOCKFISH_PATH`, instantiates `EngineManager` lazily or returns `undefined`) and `createEngineBackedAnalysisService(source, provider, repository)` in `packages/api/src/anti-cheat/engine-provider.ts`, re-exported from `@chess-platform/api`.
- **Gateway Process Hosting**: Hosted `AntiCheatAutoAnalyzer` in `services/gateway/src/serve.ts` behind `ANTICHEAT_AUTO_ANALYZE === '1'`. Requires `DATABASE_URL` (for `PgAntiCheatReportRepository` and `EventStoreGameSource`) and an engine binary (`STOCKFISH_PATH`). Logs clear warnings if either requirement is missing.
- **Graceful Subprocess Shutdown**: Integrated `antiCheatAutoAnalyzer?.stop()` and engine pool shutdown (`antiCheatEngine.shutdown()`) into the gateway's `SIGINT`/`SIGTERM` shutdown handler.
- **Documentation**: Added `docs/adr/0043-anticheat-engine-hosting.md` and updated `docs/ROADMAP.md` and `docs/PROJECT_STATE.md`.
- **Hermetic Tests**: Added unit test suite in `packages/api/test/anti-cheat-engine-provider.test.ts` testing environment variable reading and end-to-end anti-cheat analysis/storage using a fake `AnalysisProvider`.

## M10 Social Graph Increment 2 — Persistence & REST API (ADR-0067)
- **Migration `0015_social_graph.sql`**: Created tables `social_follows` `(follower_id, followee_id, followed_at)`, `social_blocks` `(blocker_id, blocked_id, blocked_at)`, and `social_friend_requests` `(id, requester_id, addressee_id, status, created_at, responded_at)`. Added foreign keys with `ON DELETE CASCADE` to `users(id)`, NOT NULL timestamp fields, `not_self` CHECK constraints, and partial unique indexes (`social_friend_requests_one_pending_per_pair` and `social_friend_requests_one_accepted_per_pair`).
- **Postgres Adapter (`PgSocialGraphRepository`)**: Implemented `SocialGraphRepository` port in `packages/persistence/src/pg/social.ts` and re-exported from `@chess-platform/persistence/pg`. Atomic `block()` execution within single SQL transactions (`BEGIN` ... `COMMIT`), block precedence checks in `follow()` and `sendFriendRequest()`, and error translation (handling unique violation `23505` to `already_exists`). Collation for UUID fields uses standard Postgres byte-wise comparison matching code-point `compareIds` order without `COLLATE "C"`.
- **REST API Endpoints**: Registered 12 `/v1/social/...` endpoints in `packages/api/src/routes.ts` (`POST/DELETE /v1/social/follows/:playerId`, `GET /v1/social/players/:playerId/followers`, `GET /v1/social/players/:playerId/following`, `POST /v1/social/friend-requests`, `POST /v1/social/friend-requests/:id/respond`, `GET /v1/social/friend-requests/incoming`, `GET /v1/social/friend-requests/outgoing`, `GET /v1/social/friends`, `POST/DELETE /v1/social/blocks/:playerId`, `GET /v1/social/blocks`).
- **Authorization & Wire Integration**: Enforced actor strictly as `requireAuth(ctx).userId`, server-generated `uuidv7()` request IDs, public follow lists, private caller-only friend/block/request lists, and `mapSocialError` helper converting `SocialRuleError` to 422, 403, 409, 404. Wired `socialGraphRepository` across `deps.ts`, `server.ts`, `bootstrap.ts` (with 503 fallback when omitted), and test `helpers.ts` (`withoutSocial`).
- **OpenAPI & Build Chain**: Exported presenters (`followEdgeView`, `friendRequestView`, `blockEdgeView`) and OpenAPI 3.1 schemas (`COMPONENT_SCHEMAS`). Regenerated `packages/api/openapi.json` with zero drift. Updated `package.json` `build:server` and Dockerfiles (`Dockerfile.api`, `Dockerfile.gateway`). Verified check:build-order script passes.
- **Tests**: DB-gated integration tests in `packages/persistence/test/social.integration.test.ts` (29/29 pass) and HTTP REST tests in `packages/api/test/social-api.test.ts` (255/255 pass).
- Detailed in `docs/adr/0067-social-persistence-api.md`.

## M10 Direct Messaging Increment 3 — Direct 1:1 Messaging (ADR-0068)
- **Domain Core Package (`@chess-platform/messaging`)**: Created pure TypeScript domain package with zero runtime dependencies. Defined `Conversation`, `Message`, `ConversationReadState`, and `ConversationSummary` interfaces. Inverted block dependency via `BlockChecker` port interface. Defined `MessagingRuleError` with codes `self_conversation`, `blocked`, `not_found`, `not_authorized`, `invalid_body`, `invalid_transition`. Code-point tie-break sorting (`compareOldestThenId`, `compareRecentActivityThenId`) and `paginate` pagination helper.
- **Migration `0016_messaging.sql`**: Created tables `messaging_conversations`, `messaging_messages`, and `messaging_reads`. `ON DELETE CASCADE` foreign key references to `users(id)` and `messaging_conversations(id)`. Partial-free unique index on `(LEAST(participant_a, participant_b), GREATEST(participant_a, participant_b))` enforcing one conversation per pair. Every referencing FK side is covered, three of them by the composite list indexes that already lead with the same column rather than by narrow duplicates.
- **Postgres Adapter (`PgMessagingRepository`)**: Implemented `MessagingRepository` in `packages/persistence/src/pg/messaging.ts` and re-exported from `@chess-platform/persistence/pg`. Transaction pair locks via the shared `pair-lock.ts` key (the same key the social graph adapter uses, which is what makes the cross-connection block check meaningful), a fixed lock order — pair lock before any row lock, after the reverse order in `sendMessage` was found to deadlock against `getOrCreateConversation` — single-statement idempotent upsert for `getOrCreateConversation`, `GREATEST` for both the read marker and `last_message_at`, `listConversations` as one query with a `LATERAL` instead of two per row, and safe `NaN`/`Infinity` pagination handling.
- **REST API Endpoints**: Registered 9 `/v1/messages/...` endpoints in `packages/api/src/routes.ts` (`GET/POST /v1/messages/conversations`, `GET /v1/messages/conversations/:id`, `GET/POST /v1/messages/conversations/:id/messages`, `PATCH/DELETE /v1/messages/messages/:id`, `POST /v1/messages/conversations/:id/read`, `GET /v1/messages/unread-count`).
- **Authorization & Privacy**: Actor strictly derived from `requireAuth(ctx).userId`. Server-generated `uuidv7()` message and conversation IDs. Uniform `not_found` (404) returned for non-existent vs unauthorized conversation access to prevent conversation ID probing.
- **Wiring & OpenAPI**: Added presenters in `presenters.ts` and OpenAPI component schemas in `schemas.ts`. Updated `deps.ts`, `server.ts`, `bootstrap.ts` (with optional dependency 503 fallback), and test `helpers.ts` (`withoutMessaging`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts, `test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/messaging/test/messaging.test.ts` (10/10), DB-gated integration tests in `packages/persistence/test/messaging.integration.test.ts` (persistence 30/30 against a real Postgres), and REST API tests in `packages/api/test/messaging-api.test.ts` (api 263/263). Two of them were checked against deliberately broken code before being trusted: the deadlock test fails with Postgres' own `deadlock detected` under the original lock order, and the stranger-probing tests compare a real id against an invented one so they cannot pass by accident.
- Detailed in `docs/adr/0068-direct-messaging.md`.

## M10 Teams & Forums Increment 4 — Teams/Communities + Forums (ADR-0069)
- **Domain Core Package (`@chess-platform/community`)**: Created pure TypeScript domain package with zero runtime dependencies. Defined `Team`, `Membership`, `JoinRequest`, `ForumThread`, `ForumPost` interfaces, bounds, role hierarchy (`owner` > `admin` > `member`), and slug normalization. Defined `CommunityRuleError` with codes `not_found`, `not_authorized`, `invalid_slug`, `slug_taken`, `invalid_input`, `already_member`, `already_requested`, `cannot_leave_as_owner`, `invalid_role_transition`, `invalid_transition`. Defined ordering comparators (`compareThreads`, `comparePosts`, `compareMembers`, `compareTeams`) and `paginate` pagination helper.
- **Single-Owner & Role Invariants**: Enforced single owner per team across domain logic and persistence. Ownership transfer updates old owner to admin and target member to owner atomically under an advisory lock. Primary owner cannot leave the team without first transferring ownership.
- **Existence Oracle Protection**: Private teams read as `not_found` (404) for non-members across team details, membership lists, join requests, and forum threads/posts. `not_authorized` (403) is used exclusively for visible resources where the actor lacks permission.
- **Migration `0017_community.sql`**: Created tables `community_teams`, `community_memberships`, `community_join_requests`, `community_forum_threads`, `community_forum_posts`. `ON DELETE CASCADE` foreign key references to `users(id)` and `community_teams(id)`. Partial unique indexes `community_memberships_one_owner_per_team` and `community_join_requests_one_pending_per_player`. All referencing foreign key columns indexed to avoid full table scans on cascading user or team deletions.
- **Postgres Adapter (`PgCommunityRepository`)**: Implemented `CommunityRepository` in `packages/persistence/src/pg/community.ts` and re-exported from `@chess-platform/persistence/pg`. Transaction advisory locks (`lockTeam` via `pg_advisory_xact_lock`) acquired before row locks (`FOR UPDATE`) to prevent deadlocks. Safe `NaN`/`Infinity` pagination handling.
- **REST API Endpoints**: Registered 22 `/v1/teams/*` and `/v1/teams/:id/forum/*` endpoints in `packages/api/src/routes.ts`. Enforced authentication matrix, `requirePlayerExists` verification for target user routes, server-generated `uuidv7()` IDs, presenter views in `presenters.ts`, and `mapCommunityError` error translation.
- **Wiring & OpenAPI**: Added presenter views in `presenters.ts` and OpenAPI component schemas in `schemas.ts`. Updated `deps.ts`, `server.ts`, `bootstrap.ts` (with optional dependency 503 fallback), and test `helpers.ts` (`withoutCommunity`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts (`build`, `test`, `lint`, `clean`, `build:server`), `scripts/test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/community/test/community.test.ts` (8/8 suites pass), DB-gated integration tests in `packages/persistence/test/community.integration.test.ts` (7/7 pass), and REST API tests in `packages/api/test/community-api.test.ts` (all auth matrix, 503 fallback, and full lifecycle tests pass).
- Detailed in `docs/adr/0069-teams-and-forums.md`.

## M10 Studies & PGN Increment 6 — Interactive Studies & PGN System (ADR-0071)
- **Domain Core Package (`@chess-platform/studies`)**: Created pure TypeScript domain package with zero runtime dependencies (43/43 tests passing). Defined `Study`, `StudyCollaborator`, `StudyChapter`, `StudyTreeNode`, and PGN models (`PgnGame`, `PgnHeader`, `PgnMoveNode`). Defined `StudyRuleError` with code taxonomy (`not_found`, `not_authorized`, `invalid_input`, `invalid_san`, `cannot_remove_owner`, `already_collaborator`, `invalid_role_transition`, `illegal_move`, `cycle_detected`, `order_conflict`). Implemented PGN parser (`parsePgn`) and serializer (`serializePgn`), SAN move resolver, code-point deterministic comparators, and `StudiesRepository` port with `InMemoryStudiesRepository` implementation.
- **SAN Move Resolution**: Adapted SAN move validation and position execution through an abstract `PositionReader` port (`legalSans`, `play`), decoupling domain move application from engine internals. Created `CorePositionReader` in `@chess-platform/api` using `@chess-platform/core`'s `Position`.
- **Migration `0019_studies.sql`**: Created tables `studies`, `study_collaborators`, `study_chapters`, and `study_tree_nodes`. Foreign key constraints specify `ON DELETE CASCADE`. Partial unique indexes `study_collaborators_one_owner_per_study` (one owner per study) and `study_chapters_study_id_order_index_idx` (active chapter ordering).
- **Postgres Adapter (`PgStudiesRepository`)**: Implemented `StudiesRepository` in `packages/persistence/src/pg/studies.ts` re-exported from `@chess-platform/persistence/pg`. Transaction advisory locking (`lockStudy` via `pg_advisory_xact_lock`) acquired before row locks (`FOR UPDATE`) to prevent cross-entity deadlocks. Ownership transfer demotes old owner to contributor before promoting target user to owner to maintain partial unique index compliance. Constraint-safe chapter reordering under advisory lock.
- **REST API Endpoints**: Registered 21 `/v1/studies/*` endpoints in `packages/api/src/routes.ts`. Enforced authentication matrix (`AUTHED` / `PUBLIC`), `requirePlayerExists` validation, server-generated `uuidv7()` IDs, presenter functions in `presenters.ts`, `mapStudyError` error translation, and `MAX_PGN_BYTES` (5 MB) body size limit on PGN import returning 413 Payload Too Large.
- **Wiring & OpenAPI**: Added presenter functions in `presenters.ts` and OpenAPI component schemas in `schemas.ts` (`StudyView`, `StudyPage`, `CollaboratorView`, `CollaboratorPage`, `StudyOwnershipTransferView`, `ChapterView`, `ChapterList`, `TreeNodeView`, `ChapterDetailView`, `PgnExport`). Updated `deps.ts`, `server.ts`, `bootstrap.ts` (`STUDIES_ENABLED === '1'`), and test `helpers.ts` (`withoutStudies`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts (`build`, `test`, `lint`, `clean`, `build:server`), `scripts/test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/studies/test/` (43/43 pass), DB-gated integration tests in `packages/persistence/test/studies.integration.test.ts` (14/14 pass against Postgres), and REST API integration tests in `packages/api/test/studies-api.test.ts` (303/303 `@chess-platform/api` tests pass cleanly).
- Detailed in `docs/adr/0071-pgn-and-studies.md`.

## M10 Lessons & Courses Increment 7 — Structured Courses & Interactive Lessons (ADR-0072)
- **Domain Core Package (`@chess-platform/learning`)**: Created pure TypeScript domain package with zero runtime dependencies (8/8 unit tests passing). Defined `Course`, `Lesson`, `LessonStep`, `Progress`, `CourseProgressSummary`, `AttemptResult` interfaces, and step discriminators (`text`, `move`, `quiz`). Reused `@chess-platform/studies`'s `PositionReader` port for move step authoring-time legality check. Implemented slug validation and normalization (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), code-point deterministic comparators (`compareCourses`, `compareLessons`, `compareSteps`, `compareProgress`), `paginate` helper, and `LearningRepository` port with `InMemoryLearningRepository` implementation.
- **Migration `0020_learning.sql`**: Created tables `learning_courses`, `learning_lessons`, `learning_steps`, and `learning_progress`. All player/course/lesson/step foreign keys specify `ON DELETE CASCADE`. Partial unique indexes on active course slugs (`learning_courses_slug_idx`), active lesson order indexes (`learning_lessons_course_id_order_index_idx`), and active step order indexes (`learning_steps_lesson_id_order_index_idx`). Dedicated full indexes on all foreign key columns cover cascading deletions on tombstoned rows.
- **Postgres Adapter (`PgLearningRepository`)**: Implemented `LearningRepository` in `packages/persistence/src/pg/learning.ts` re-exported from `@chess-platform/persistence/pg`. Transaction advisory locking (`lockCourse` via `pg_advisory_xact_lock`) acquired before row locks (`FOR UPDATE`). Dense order index reordering shifts active rows to negative indices (`-1 - i`) first to avoid partial unique index collisions. Single atomic SQL statement attempt recording (`INSERT INTO learning_progress ... ON CONFLICT (player_id, step_id) DO UPDATE SET attempts = ..., completed_at = COALESCE(...)`) with verified concurrent execution semantics.
- **REST API Endpoints**: Registered 23 `/v1/courses/*`, `/v1/lessons/*`, `/v1/steps/*` endpoints in `packages/api/src/routes.ts`. Enforced authentication matrix (`AUTHED` / `PUBLIC`), `requirePlayerExists` validation, server-generated `uuidv7()` IDs via `deps.ids.next()`, presenter functions in `presenters.ts`, and `mapLearningError` error translation.
- **Wiring & OpenAPI**: Added presenter functions in `presenters.ts` and OpenAPI component schemas in `schemas.ts` (`CourseView`, `CoursePage`, `LessonView`, `LessonList`, `StepView`, `StepList`, `ProgressView`, `ProgressList`, `CourseProgressSummaryView`, `AttemptResultView`). Updated `deps.ts`, `server.ts`, `bootstrap.ts` (`LEARNING_ENABLED === '1'`), and test `helpers.ts` (`withoutLearning`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts (`build`, `test`, `lint`, `clean`, `build:server`), `scripts/test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/learning/test/learning.test.ts` (8/8 pass), DB-gated integration tests in `packages/persistence/test/learning.integration.test.ts` (including real N-concurrent attempt submission test), and REST API integration tests in `packages/api/test/learning-api.test.ts` (54/54 `@chess-platform/api` test suites pass cleanly).
- Detailed in `docs/adr/0072-lessons-and-courses.md`.

## M10 Increment 8 — Read-Only GraphQL Layer (ADR-0073) — closes M10
- **Endpoint**: `POST /v1/graphql`, behind `GRAPHQL_ENABLED=1`, registered with the same `AuthPolicy` machinery as the REST routes and open to anonymous callers. Delivers the nested reads REST answers badly — a player with their followers, teams, achievements and studies in one round trip. This closes the GraphQL deferral recorded in §4 decision 1.
- **Queries only**: the parser refuses `mutation` and `subscription` by name. Writes stay on REST, where each already has an authorization review.
- **Authorization delegated entirely to the repositories** (`packages/api/src/graphql/schema.ts`): every resolver passes `ctx.actorId` into the existing port and returns the answer, with no exceptions. `not_found` and `not_authorized` are flattened to one message so the endpoint is not an existence oracle (ADR-0069 §4). Review removed an invented rule: `Query.player` initially hid players who had blocked the caller, but ADR-0066 §3 scopes a block to follows and friend requests, and no REST read consults `isBlockedBetween` — the test now asserts GraphQL and REST return the *same* profile for a blocked pair. The repository bundle was also dropped from `ResolverContext` so resolvers reach subsystems only through accessors that fail the field rather than through a bundle they can branch on.
- **Per-request batching** (`graphql/loaders.ts`): a dependency-free DataLoader-style `BatchLoader` coalescing every `load()` in a microtask tick and caching per key, created inside the request handler so the cache never outlives it. Required a new `UsersRepository.findByIds`, implemented in `PgUsersRepository` (filters non-canonical ids before `= ANY($1::uuid[])`, since the cast would fail the whole batch on one malformed element) and in `InMemoryUsersRepository`. 25 followers resolve in 2 batched reads, not 26.
- **Three limits enforced before execution** (`graphql/limits.ts`): depth 8, complexity 1000 (list fields multiply their subtree by the page size they request), aliases 50. Validation *produces* the execution plan, so no field can resolve uncosted; each limit test asserts the repositories were not called. Plus a 16 KB query cap and argument-nesting bound in the parser.
- **Introspection off by default** (`GRAPHQL_INTROSPECTION=1`); rejection messages never list the fields that exist. The `__schema` shape returned is this repo's own, not spec-compliant — stated as such in the ADR.
- **No new runtime dependency**: parser, validator, executor and loader hand-written (~1,800 lines, 8 files). Fragments, directives, block strings and multi-operation documents are refused with explicit parse errors rather than misparsed; the fragment refusal avoids cyclic/exponential expansion that a depth bound cannot see.
- **Wiring**: `deps.ts`, `routes.ts`, `server.ts`, `bootstrap.ts` (`GRAPHQL_ENABLED`), `openapi/schemas.ts` (`GraphQLRequest`), and test `helpers.ts` (`withoutGraphql`, `graphqlIntrospection`).
- **Tests**: `packages/api/test/graphql.test.ts` (29) and DB-gated `packages/persistence/test/users-batch.integration.test.ts`. Eight rules were mutation-tested — each broken in turn, covering test confirmed to fail. That pass caught a flattening test that proved nothing (the studies adapter already flattens both codes, so it passed against broken code); it was replaced with a direct unit test.
- Detailed in `docs/adr/0073-graphql-read-layer.md`.

## M10 Increment 9 — Social UI on the Profile Page (ADR-0074) — first WEB increment
- **The gap it closes**: increments 1–8 were all backend. 91 M10 endpoints existed with **zero UI**; the web app spoke only `/v1/auth`, `/v1/health`, `/v1/seeks`, `/v1/users` across four routes. This is the first increment of the web track.
- **Surface**: the existing `/profile/:handle` route, extended — no new route. Follower/following lists with counts, follow/unfollow, friend requests (send, accept, decline, cancel), block/unblock, and on the viewer's own profile their pending requests, friends and blocked players. All 12 social endpoints reachable.
- **Read path** (`packages/web/src/api/graphql.ts`): `POST /v1/graphql` for nested reads, REST for writes. The binding reason is not round trips — the social endpoints return **bare ids and REST has no id-to-handle lookup** (`/v1/users/:handle` goes the other way), so `player(id:)` is the only route to a display name. `resolvePlayers` batches aliased lookups 20 at a time, well under the endpoint's 50-alias and 1000-complexity limits.
- **Degradation**: `GRAPHQL_ENABLED` is opt-in, so every GraphQL failure becomes `null` rather than an exception, latched after the first attempt. Flag off ⇒ counts, lists and actions all still work; only names fall back to truncated ids under an explanatory note.
- **Derived relationship** (`packages/web/src/app/social-controller.ts`): there is no "do I follow this player" endpoint, so the viewer's own following/blocks/requests are read once (`RELATIONSHIP_SCAN_LIMIT = 100`) and the relationship derived. Knowingly approximate past 100 follows, and safe because `follow` is an idempotent upsert and `unfollow` reports "nothing removed" without failing.
- **Writes reload rather than patch** — a follow can be refused by an unseen block, and a request can be answered from the other side between render and click.
- **Sign-out clears the region**: it holds one account's friends, requests and blocks; leaving it rendered would be a disclosure, not a stale view.
- **Design (Impeccable v4, Operate mode)**: `.rating-row`/`.game-row`/`.panel-row` consolidated onto one shared rule per DESIGN.md's one-row-style requirement; counts sit beside their heading rather than in stat tiles (the SaaS-dashboard anti-reference); follow state carried by the verb, never colour (one accent, and colour-only state fails colourblind users); a signed-out visitor gets an empty action bar rather than disabled buttons.
- **Tests**: `social-controller.test.ts` (15) plus 3 a11y assertions; 305/305 web tests pass. Eight rules mutation-tested, 8/8 caught — the pass caught a stale-load test that proved nothing (identical fakes on both loads meant it passed with the generation guard removed) and it was rewritten with a gated slow response.
- **Recorded gaps**: GraphQL `Player` has no `teams` field despite ADR-0073's Context claiming it; five pre-existing design-system findings in `style.css` are reported, not repaired (fixing drift inside a feature PR is how a design-system change ships unreviewed).
- Detailed in `docs/adr/0074-social-ui-profile.md`.









