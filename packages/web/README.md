# `@chess-platform/web`

Gambit's playable web frontend (Milestone 6). Framework-light TypeScript that
consumes the already-approved contracts — the M4 REST API and the M3 realtime
WebSocket gateway — and renders a fast, accessible, installable (PWA) chess
client.

> **Status: Milestone 6 — in progress (increment 3A).** Increments 1–2 shipped
> the dependency-free, unit-tested *view core* and the **interactive board**
> (drag & drop, click-to-move, highlights, promotion, premoves). Increment 3A
> adds the **networking foundation**: a `fetch`-based transport port, an
> `HttpClient` (timeout, safe-method retry, typed errors), a session/auth
> abstraction with token refresh, and the typed `GambitClient` over the M4 REST
> contract — all framework-independent and unit-tested, with the UI kept separate
> from networking. The WS game stream, lobby/profile, Playwright e2e and the
> Lighthouse a11y gate land in following increments.

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
src/net/     Networking foundation (framework-independent, unit-tested)
  errors.ts       typed error taxonomy (network/timeout/http/decode)
  retry.ts        exponential backoff + safe-method retry policy (pure)
  http-client.ts  HttpClient: timeout, retry, JSON, error mapping
  session.ts      token store + SessionManager (proactive/single-flight refresh)
src/api/     Typed REST layer
  models.ts       request/response models mirroring openapi.json
  client.ts       GambitClient (auth injection + 401 refresh-retry)
src/ui/      DOM rendering + input (board-view.ts)
src/main.ts  App entry: mounts the interactive board, registers the SW
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
