# Gambit — Web Frontend Architecture (Milestone 6)

> **Status:** IN PROGRESS (M6, increment 3B landed). **Non-gating** design doc.
> The frontend is a *leaf consumer* of the approved REST (M4) and realtime WS
> (M3) contracts and introduces no new durable/shared contract, so — per the
> repo's gate rule (see `AI_HANDOVER.md`; precedents `DATABASE.md`/ADR-0001 and
> `ENGINE_BRIDGE.md`/ADR-0002) — **no ADR/gate is required**. This document
> records the design for continuity, not for approval.

## 1. Goals & non-goals

**Goals**
1. Playable board: animation, premoves, drag + click, promotion.
2. Clocks, game view, lobby, profile.
3. PWA (installable, offline app shell), accessible (target Lighthouse a11y
   >= 95), light/dark.
4. **Acceptance (from ROADMAP):** Playwright e2e plays a full game vs. bot and
   vs. human; Lighthouse a11y >= 95.

**Non-goals**
- No chess rules in the frontend. Legality, SAN/FEN semantics, and terminal
  detection stay in `@chess-platform/core`; the game authority stays server-side
  (M2/M3). The client validates a candidate move against `core` only to gate UX
  (e.g. accept a premove) before submitting — the server remains authoritative.
- No new server-side or shared contract.

## 2. Consumed contracts (unchanged)

- **REST + identity (M4, `@chess-platform/api`):** consumed via a typed client
  whose request/response models mirror `packages/api/openapi.json`. Increment 3A
  covers health, auth/session, users/profile, ratings, leaderboard and game
  summaries; lobby/seeks and game creation land with the lobby increment.
- **Realtime WS (M3, `@chess-platform/realtime-gateway`):** live game stream —
  moves, clocks, chat, presence — over the existing message protocol.
- **Engine (M5) is consumed indirectly** via the server's analysis/bot endpoints
  (bot wiring is M14); the frontend never spawns engines.

## 3. Layering

```
core/ (pure, tested)  ->  ui/ (DOM + input)  ->  app/ (state + client seams)
```

- **core/** — dependency-free, DOM-free, deterministic. Unit-tested with
  `node --test` (same convention as every other package). Modules: board
  geometry, FEN placement (view-only), premove queue, chess clock (injected
  time). *Landed in increment 1.*
- **ui/** — framework-light DOM rendering and pointer input. `BoardView` renders
  an 8x8 grid + piece layer and emits `move-intent` events; it decides no
  legality. *Interactive board landed (increment 2): drag & drop, click-to-move,
  selection/legal/last-move/premove highlights, promotion overlay.*
- **net/** + **api/** — the networking foundation (increments 3A + 3B):
  - *3A (REST):* a `fetch`-based `HttpTransport` **port**, a transport-level
    `HttpClient` (timeout, safe-method retry with backoff, JSON, typed error
    taxonomy), a `SessionManager` (pluggable token store + proactive, single-flight
    refresh), and the typed `GambitClient` over the M4 REST contract.
  - *3B (WebSocket):* a `WebSocketConnection` **port** + browser adapter, a typed
    `WsClient` (state machine, automatic reconnect with backoff + jitter, ping/pong
    heartbeat with silent-link detection), wire-protocol models mirroring the M3
    gateway, and a `GameSync` synchronization layer (join/resume, authoritative
    snapshot + live move ledger, optimistic move tracking with confirm/rollback,
    ply-gap resync). Framework-independent and unit-tested; the DOM never imports it.
- **app/** — composition root: wires the REST client + WS game stream into the
  UI, game state reducer, routing (board / lobby / profile), premove application
  on opponent moves. *Next increment.*

## 4. Technology choices

- **TypeScript, strict**, matching the monorepo (NodeNext, `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Vite** for dev/build (SPA). Keeps the toolchain small; no heavy UI
  framework, honouring the repo's minimal-dependency ethos. Rendering is done
  with small, testable view logic + direct DOM, upgradeable to a tiny vdom if
  needed.
- **PWA** via a web manifest + a minimal offline app-shell service worker
  (`public/sw.js`), expanded to runtime caching later.
- **Accessibility** baked in from the start: board exposed as a `grid` with
  per-square `gridcell` labels, `aria-live` status region, visible focus, skip
  link, colour-scheme aware theming.

## 5. Testing strategy

- **Unit (`node --test`, hermetic):** all `core/` logic plus the `net/` and
  `api/` layers, the latter driven through in-memory transport doubles (no real
  sockets or HTTP). *Whole web suite 115 tests green (increment 3B).*
- **Component/interaction:** board input + premove application (landed in
  increment 2).
- **e2e (Playwright):** full game vs. bot and vs. human against a running stack;
  the ROADMAP acceptance gate.
- **Lighthouse a11y >= 95** in CI (once CI is active — see deferred maintenance).

## 6. Increment plan

1. **Increment 1 (this commit):** design + dependency-free view core (board,
   position, premove, clock) with tests; app scaffold (board view, entry,
   styles, PWA manifest + service worker); workspace wiring.
2. **Increment 2 (this commit):** interactive board — drag & drop, click-to-move,
   selection/legal-destination/last-move/premove highlighting, promotion UI, and
   premove application over the Increment-1 premove core; a legality **port**
   (`LegalMoveOracle`) keeps rules out of the UI; a view-only optimistic mover
   updates the board immediately. Legality/reconciliation stays server-side.
3. Client seams, split across sub-increments:
   - **3A (this commit):** REST networking foundation — `HttpTransport` port +
     `HttpClient` (timeout, retry, typed errors), request/response models, the
     `GambitClient`, and a session/auth abstraction with token refresh. UI stays
     decoupled from networking; no WebSocket, lobby or gameplay sync yet.
   - **3B (this commit):** WebSocket foundation + gameplay synchronization \u2014
     `WebSocketConnection` port + `WsClient` (reconnect, heartbeat), typed wire
     protocol mirroring the M3 gateway, and `GameSync` (join/resume, authoritative
     state, optimistic move tracking, ply-gap resync). No lobby/profile UI yet.
   - **3C (next):** wire the REST + WS clients into the app composition root and
     game view end-to-end; core/server-backed move oracle.
4. Lobby, profile, routing; PWA runtime caching.
5. Playwright e2e (bot + human) and Lighthouse a11y gate -> M6 acceptance.
