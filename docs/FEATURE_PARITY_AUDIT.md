# Gambit feature-parity audit

- Date: 2026-07-19
- Target: `main` at `9b7aad4`, plus the local fixes listed below
- Environment: production Docker Compose stack at `http://localhost:3000`

This audit distinguishes four different meanings of “implemented”:

1. **Domain/library** — code and unit tests exist.
2. **Runtime/API** — the production Compose services expose and execute it.
3. **Web client** — the browser client has an adapter/controller for it.
4. **Visible UI** — a user can discover and use it on the website.

Having a package in the monorepo does not imply that it is a product feature.

## Feature matrix

| Feature | Domain/library | Runtime/API | Web client | Visible UI | Audit result |
|---|---:|---:|---:|---:|---|
| Chess rules, legal moves, terminal detection | Yes | Yes | Yes | Yes | Standard play verified through a real browser move; the variant selector exposes all eight implemented variants. |
| Server-authoritative clocks and event-sourced games | Yes | Yes | Yes | Yes | Real matched game returned authoritative clocks and position over `/ws`. |
| Click/drag, legal highlights, promotion, premove, board flip | Yes | Yes | Yes | Yes | Board renders 64 squares/32 pieces; `e2-e4` and server legal highlights verified. Promotion and premove remain covered by automated tests. |
| Resign, draw offer/accept/decline, abort, claim flag | Yes | Yes (WebSocket commands) | Yes | Yes | Actions are fully exposed in the game sidebar with proper state sync and confirmation flows. Resign and draw offer/accept flows are E2E-verified; others are covered at the component/unit level. |
| Presence, spectator role, reconnect/resume | Yes | Yes | Yes | Yes | Connection status, player metadata, live clocks, and spectator counts are exposed in the game UI. |
| Password register/login/logout | Yes | Yes | Yes | Yes | Visible and exercised; refresh cookie restores the session. |
| Session list/revocation | Yes | Yes | Partial (`sessions()` only) | No | No account/security screen. |
| Password reset and email verification | Yes | Yes | No | No | Backend-only. Email sender is deployment-dependent. |
| WebAuthn/passkeys | Yes | Yes | No | No | Registration/login/list/delete endpoints pass tests, but the website has no passkey flow. |
| Profiles, ratings and recent games | Yes | Yes | Yes | Yes | Profile session race fixed; `/profile` now loads the signed-in user correctly. |
| Leaderboard | Yes | Yes | Yes | Yes | `GET /v1/leaderboard/:variant` exposed as SPA page at `/leaderboard` with variant selector populated by an app-layer labels module, optional GraphQL handle resolution, shortId fallback, stale request protection, two-child row rendering, semantic loading/list behavior, and composite view disposal. |
| Seek creation, cancellation, acceptance and atomic game provisioning | Yes | Yes | Yes | Yes | Creation and acceptance are verified end-to-end with two users and real PostgreSQL provisioning. Cancellation is API-tested but has no end-to-end cancellation test. |
| Play against a bot | Yes | Yes | Yes | Yes | Engine bot service (`POST /v1/games/bot`) and Play vs Computer dialog shipped (ADR-0080, ADR-0081). |
| Engine/UCI analysis | Yes | **No composed engine service** | No | No | The engine bridge is a tested library, but Compose starts no engine worker and the API exposes no analysis endpoint. |
| AI provider orchestration | Yes | No service/API | No | No | OpenAI/Anthropic adapters, routing, failover, cache and grounding exist only as libraries. Real-provider tests are key-gated. |
| Move explainer | Yes | No | No | No | Library/test implementation only. |
| Puzzle generator | Yes | No | No | No | Library/test implementation only. |
| Mistake predictor | Yes | No | No | No | Library/test implementation only. |
| Opening explorer | Yes | No | No | No | Bundled data and library exist; no endpoint/page. |
| Endgame trainer | Yes | No | No | No | Bundled data and library exist; no endpoint/page. |
| Coach, study partner and voice coach | Yes | No | No | No | Ports and hermetic tests exist; no browser speech adapters or product workflow. |
| Round-robin, Swiss and Arena tournaments | Yes | Yes | Yes | Yes | Full REST lifecycle, live view, tournament client adapter, and UI views shipped (ADR-0082). |
| Tournament live broadcast/commentary | Yes | Partial | No | No | Live boards/result reporter run; AI commentary is not composed into a production service. |
| PWA/offline shell | Yes | Yes | Yes | Yes | Manifest/service worker and offline-navigation acceptance test pass. |
| Light/dark theme | Yes | Yes | Yes | Yes | Fixed: explicit light preference now overrides a dark OS preference and updates icon/ARIA/theme-color. |
| Social features (teams, friends, chat, forums, achievements) | No | No | No | No | M10 not started. |
| Learning content, PGN import and collaborative studies | No product implementation | No | No | No | M10 not started; the AI `StudyPartner` library is not a collaborative study product. |
| Search | No | No | No | No | M11 not started. |
| CORS, security headers, httpOnly refresh and rate limiting | Yes | Yes | N/A | Indirect | Verified against the live API and dedicated Postgres integration tests. |
| Anti-cheat/bot detection/pen-test | No | No | No | No | Remaining M12 work. |
| Docker Compose | Yes | Yes | N/A | N/A | Full stack healthy after Dockerfile, healthcheck and WebSocket proxy fixes. |
| Kubernetes Helm | Yes | Packaging only | N/A | N/A | Chart exists; no live cluster deployment was part of this local audit. |
| Terraform, canary/blue-green, large load/chaos | No | No | N/A | N/A | Remaining M14 work. |
| OpenTelemetry, Prometheus, Grafana, SLOs | No | No | No | No | M13 not started. |

## Defects found and fixed during this audit

1. Light mode only removed `.dark`; on a dark-system browser all colour tokens
   stayed dark. The app now applies an explicit `.light` state, persists it,
   updates the action icon/label, and has a browser regression test.
2. `/profile` requested `/v1/users/me` before the asynchronous refresh-cookie
   restore finished, producing `no active session` for a signed-in user. The
   profile now waits for the authenticated session and also reacts to a later
   sign-in.
3. `Flip` and “Skip to board” appeared on routes with no board. They are now
   game-route-only controls.
4. Browser WebSocket upgrades through nginx were all rejected with HTTP 401.
   nginx forwarded `$host` (`localhost`) while the browser Origin was
   `localhost:3000`; it now forwards `$http_host` and preserves the port.
5. The official Compose smoke test had drifted from the API contract (old token
   path and old time-control body), only tested a direct gateway port, and did
   not provision a real matched game. It now registers two players, atomically
   accepts a seek, and joins the game through the same nginx `/ws` path and
   Origin policy used by browsers.
6. A malformed public game id caused PostgreSQL UUID error `22P02` and an HTTP
   500. `PgGamesRepository.findById` now treats malformed ids as not found; a
   real-Postgres regression test covers it.
7. The API and gateway runtime images were missing required workspace build and
   runtime dependencies; the Compose web healthcheck used a container-local
   hostname that failed on this image. The Dockerfiles/healthcheck were fixed.

## Verification performed

- Full monorepo production build: passed.
- Full monorepo test command across all 11 packages: passed with zero failures.
- Full monorepo strict TypeScript lint: passed.
- Web unit suite: 272/272 passed.
- Web static/offline Playwright suite (Without GAMBIT_E2E_BACKEND): 6 passed, 6 skipped.
- Web full backend-gated Playwright suite (With GAMBIT_E2E_BACKEND=1): 12 passed, 0 skipped.
- Dedicated real-Postgres persistence suite: 23/23 passed.
- Dedicated real-Postgres API suite: 138/138 passed.
- Compose smoke test through nginx `/ws`: passed.
- Manual real-browser acceptance: theme both ways, restored profile, seek
  creation, second-user acceptance, route to game, authenticated WebSocket,
  64-square board, legal `e2` destinations, and authoritative `e2-e4` update.

## Remaining product-critical work, in order

1. [Shipped] Add game metadata/presence to the UI to make a match manageable without hidden protocol calls. Game controls (resign, draw, abort, claim flag) are already implemented.
2. [Shipped] Add production bot service + `Play bot` (ADR-0080, ADR-0081).
3. Expose the remaining already-built passkeys and recovery APIs through real pages and typed web clients (leaderboard and tournaments UI are shipped in ADR-0082 and ADR-0107).
4. Compose an engine worker and AI feature API before advertising any AI
   feature; then build analysis, puzzles, openings/endgames, coach and voice UI.
5. Add a Compose-based browser acceptance job. The current backend Playwright
   tests use the e2e harness, which is why the production nginx 401 escaped.
6. Add a real not-found page and clean up SPA controller/listener lifecycle on
   repeated client-side navigation.
7. Complete M10, M11, M12 anti-cheat, M13 and the deferred M14 scale work.
