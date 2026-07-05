# `@chess-platform/web`

Gambit's playable web frontend (Milestone 6). Framework-light TypeScript that
consumes the already-approved contracts — the M4 REST API and the M3 realtime
WebSocket gateway — and renders a fast, accessible, installable (PWA) chess
client.

> **Status: Milestone 6 — in progress (increment 1).** This increment ships the
> dependency-free, unit-tested *view core* plus the app scaffold. Board
> rendering polish, the REST/WS client seam, bots vs. human play, Playwright e2e
> and the Lighthouse a11y gate land in following increments.

## Layout

```
src/core/    Dependency-free, DOM-free, unit-tested presentation logic
  board.ts     square <-> index/pixel geometry, orientation
  position.ts  view-only FEN placement parsing (no rules-engine dependency)
  premove.ts   premove queue state machine
  clock.ts     chess clock with injected time source (deterministic)
src/ui/      DOM rendering + input (board-view.ts)
src/main.ts  App entry: mounts the board, registers the service worker
public/      PWA manifest + offline service worker
```

Design rationale and the consumed contracts are documented in
[`docs/FRONTEND.md`](../../docs/FRONTEND.md).

## Why no formal gate (ADR)

Gates in this repo are reserved for changes introducing a **durable/shared
contract** (precedents: `DATABASE.md`/ADR-0001, `ENGINE_BRIDGE.md`/ADR-0002).
The frontend is a **leaf consumer** of existing approved contracts and defines
no new shared contract, so it follows the standard workflow without a gate.
`docs/FRONTEND.md` documents the architecture but is explicitly non-gating.

## Build & test

```bash
npm install
npm run lint    # strict tsc --noEmit over src (incl. UI)
npm test        # tsc -p tsconfig.test.json && node --test dist-test/test/
npm run dev     # vite dev server
npm run build   # tsc + vite build
```

The `core` suites are hermetic (`node --test`, no browser). Browser-level e2e
(Playwright) is added with the interactive board increment.
