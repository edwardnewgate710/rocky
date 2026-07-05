# `@chess-platform/web`

Gambit's playable web frontend (Milestone 6). Framework-light TypeScript that
consumes the already-approved contracts — the M4 REST API and the M3 realtime
WebSocket gateway — and renders a fast, accessible, installable (PWA) chess
client.

> **Status: Milestone 6 — in progress (increment 3C-1).** Increments 1–2 shipped
> the dependency-free, unit-tested *view core* and the **interactive board**
> (drag & drop, click-to-move, highlights, promotion, premoves). Increment 3A
> added the **REST networking foundation** (transport port, `HttpClient`, typed
> `GambitClient`, session/auth abstraction). Increment 3B added the **WebSocket
> foundation + gameplay synchronization**: a `WebSocketConnection` port, a typed
> `WsClient` (reconnect with backoff, heartbeat), wire-protocol models mirroring
> the M3 gateway, and a `GameSync` layer (join/resume, authoritative state,
> optimistic move tracking, ply-gap resync). Increment 3C-1 adds the
> **application composition root** (`src/app/`): `createApp` wires the REST stack,
> the realtime `WsClient` and a per-game `GameSync` factory via dependency
> injection (browser adapters as defaults, fakes in tests), and `main.ts` is
> reduced to a thin DOM entry — UI kept separate from infrastructure. This
> increment is **wiring only**: no connection is opened, no gameplay
> synchronization or server-backed move oracle is implemented yet. Lobby/profile,
> Playwright e2e and the Lighthouse a11y gate land in following increments.

## Layout

```
src/core/    Dependency-free, DOM-free, unit-tested presentation logic
  board.ts        square <-> index/pixel geometry, orientation
  position.ts     view-only FEN placement parsing (no rules-engine dependency)
  premove.ts      premove queue state machine
  clock.ts        chess clock with injected time source (deterministic)
  interaction.ts  board interaction state machine (selection, drag/click,
                  highlights, promotion, premove application)
  mover.ts        view-only optimistic move projection (not a rules engine)
src/ports/   Injected seams
  move-oracle.ts  LegalMoveOracle port (+ Null/Static adapters)
  http.ts         HttpTransport port (+ fetch adapter)
  ws.ts           WebSocketConnection port (+ browser adapter)
src/net/     Networking foundation (framework-independent, unit-tested)
  errors.ts       typed error taxonomy (network/timeout/http/decode)
  retry.ts        exponential backoff + safe-method retry policy (pure)
  http-client.ts  HttpClient: timeout, retry, JSON, error mapping
  session.ts      token store + SessionManager (proactive/single-flight refresh)
  ws-protocol.ts  typed wire models mirroring realtime-gateway + JSON codec
  ws-client.ts    WsClient: state machine, reconnect, heartbeat
  game-sync.ts    GameSync: join/resume, authoritative state, optimistic moves
src/api/     Typed REST layer
  models.ts       request/response models mirroring openapi.json
  client.ts       GambitClient (auth injection + 401 refresh-retry)
src/ui/      DOM rendering + input (board-view.ts)
src/app/     Composition root (the one place that knows every layer)
  config.ts       AppConfig + resolveConfig (REST/WS endpoints from location)
  composition.ts  createApp: DI wiring of GambitClient + WsClient + GameSync
  board.ts        mountBoard: composes the interactive board (UI + core only)
  bootstrap.ts    DOM entry: createApp + mountBoard
src/main.ts  Thin app entry: runs bootstrap on DOM-ready, registers the SW
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
