# Gambit — Web Frontend Architecture (Milestone 6)

> **Status:** IN PROGRESS (M6, increment 2 landed). **Non-gating** design doc.
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

- **REST + identity (M4, `@chess-platform/api`):** typed client generated from
  `packages/api/openapi.json`. Auth, profile, lobby/seeks, game creation.
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
- **app/** — composition root: REST + WS client seams, game state reducer,
  routing (board / lobby / profile), premove application on opponent moves.
  *Next increment.*

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

- **Unit (`node --test`, hermetic):** all `core/` logic. *21 tests green in
  increment 1.*
- **Component/interaction:** board input + premove application (next increment).
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
3. Client seams: generated REST client + WS game stream; core/server-backed
   move oracle; game view end-to-end.
4. Lobby, profile, routing; PWA runtime caching.
5. Playwright e2e (bot + human) and Lighthouse a11y gate -> M6 acceptance.
