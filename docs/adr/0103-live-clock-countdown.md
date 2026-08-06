# ADR-0103 — Live clock countdown UI interpolation and web image build chain

| Field      | Value                                                                             |
|------------|-----------------------------------------------------------------------------------|
| **Status** | Accepted                                                                          |
| **Date**   | 2026-08-06                                                                        |
| **Scope**  | `packages/realtime-gateway`, `packages/web`, `Dockerfile.web`, `package.json`, `scripts/check-docker-build-order.mjs`, `docs` |

---

## Context

A player watching their own game saw a frozen clock: remaining time changed only when a move landed, remaining constant while sitting and thinking, even across a full page reload.

The server's timing logic (`packages/game/src/clock.ts`) was authoritative and correct: move charges were calculated accurately. The defect was that the client UI never rendered local interpolation between move broadcasts.

Each claim below was reproduced before being fixed.

### 1. Pure latency interpolation helpers existed with zero production callers

`packages/realtime-gateway/src/latency.ts` contained unit-tested pure functions (`estimateRttMs`, `estimateSkewMs`, `interpolateRemaining`) specifically specified for client-side countdown interpolation (`docs/ARCHITECTURE.md` §4).

However, `grep -rn "interpolateRemaining"` across `packages/` and `services/` found only `latency.ts` itself and its unit test `packages/realtime-gateway/test/latency.test.ts`. There was zero production invocation in the web client or anywhere else. A suite of unit tests for helper math passed while the browser clock never ticked.

### 2. StateView snapshot had no turn start anchor

`interpolateRemaining` requires a server timestamp anchor (`turnStartServerTs`). While live move broadcasts (`MoveBroadcast`) carried `serverTs`, the complete state snapshot (`StateView` sent on join/resume) had `clock: ClockView` but no turn start timestamp. Consequently, a client joining mid-game or reloading had no anchor and its clock stayed frozen until a move landed.

`snap.clock.turnStartedAt` already existed in `@chess-platform/game`, but `GameAuthority.viewOf()` dropped it when constructing `StateView`.

### 3. `docker compose build web` broke, and the gate that exists to catch that was blind to it

This is the first time production code under `packages/web/src` imports another workspace package;
until now the web package mirrored the gateway's protocol by hand and depended on it only from a
test (`packages/web/test/e2e-live-loop.test.ts`). That first import broke the web image:

```
src/app/game-controller.ts(20,38): error TS2307: Cannot find module
  '@chess-platform/realtime-gateway/latency' or its corresponding type declarations.
src/net/ws-client.ts(23,32): error TS2307: Cannot find module
  '@chess-platform/realtime-gateway/latency' or its corresponding type declarations.
failed to solve: process "/bin/sh -c npm run build --workspace @chess-platform/web"
  did not complete successfully: exit code: 2
```

The failure is invisible on a developer machine, because `packages/realtime-gateway/dist/` is
already there from earlier work. `.dockerignore` lists `**/dist`, so inside the image it is not,
and `Dockerfile.web` never built it. The full seven-gate suite passed while the image would not
build — the same shape as ADR-0065.

`scripts/check-docker-build-order.mjs` exists precisely to stop this class of drift, and missed it
for two independent reasons, either of which alone was sufficient:

- it hard-coded `DOCKERFILES = ['Dockerfile.api', 'Dockerfile.gateway']`, so `Dockerfile.web` was
  never examined at all;
- its `internalDeps()` reads only `pkg.dependencies`, and the gateway sat in web's
  `devDependencies` — so even a web-aware check would have found no dependency to order.

### 4. And the compiled gateway cannot be bundled into the browser at all

Declaring the dependency and building it first was still not enough. `vite build` then failed:

```
src/net/ws-client.ts (23:9): "estimateSkewMs" is not exported by
  "../realtime-gateway/dist/index.js", imported by "src/net/ws-client.ts".
```

`packages/realtime-gateway` compiles with `"module": "CommonJS"` and declares no `"type": "module"`,
while the SPA is an ESM Rollup bundle. Vite applies its CommonJS interop only to files inside
`node_modules`, and a workspace package resolves outside it — so Rollup reads the emitted
`exports.x = ...` assignments as ESM, finds no named exports, and fails. Pointing the import at the
leaf `dist/latency.js` instead of the barrel does not help; it is the same CommonJS emit.

This is why `tsc` passing is not evidence the bundle will build, and why both halves have to be
verified by running `docker compose build web` rather than by reading the diff.

## Decisions

### 1. StateView carries `turnStartedAt`

Added `readonly turnStartedAt: number | null` to `StateView` in `packages/realtime-gateway/src/protocol.ts` and mirrored it in `packages/web/src/net/ws-protocol.ts`. `GameAuthority.viewOf()` populates `turnStartedAt` from `snap.clock.turnStartedAt`. It is nullable
exactly where `ClockState.turnStartedAt` is: `initClock(tc, startedAt)` stores whatever start
timestamp it is given, independent of `tc.kind`, so the null case is a clock that was never started
— not, as an earlier draft of this ADR claimed, an unlimited time control.

### 2. WebSocket client measures and exposes clock skew

`packages/web/src/net/ws-client.ts` calculates clock skew on `pong` messages using `estimateSkewMs(msg.ts, msg.serverTs, rtt)` and exposes it via a `skew` accessor. `GameSync` exposes `skew` from its `WsClient`.

### 3. One authored implementation, reached by two resolutions

The arithmetic is authored once, in `packages/realtime-gateway/src/latency.ts`. Duplicating six
lines of subtraction into the web package would have been the easy answer and is rejected: the two
copies would drift silently, and the interpolation has to agree with the server's charging model or
the displayed clock lies.

Reaching it from the browser takes two mechanisms, because of §4 above:

- `packages/realtime-gateway/package.json` gains an `exports` map with a `./latency` subpath, so
  `tsc` and the Node test runner resolve `@chess-platform/realtime-gateway/latency` to the compiled
  `dist/latency.js`. The subpath, not the barrel — importing the package root would pull the whole
  server-side gateway into the browser's module graph.
- `packages/web/vite.config.ts` aliases that same specifier to the TypeScript **source**, so Vite
  compiles it as ordinary ESM and never meets the CommonJS emit.

Both routes originate from the one authored file, so there is still exactly one implementation:
`grep -rn "interpolateRemaining" packages/ services/ --include=*.ts` shows the definition, the two
web call sites, and tests. The alias is a build-tool detail, deliberately commented at both the
import site and in the Vite config so the next reader does not "simplify" it back into a failure.

The considered alternative was making the gateway emit ESM. That is a larger change touching every
server consumer of the package, and is not justified by one leaf module of pure arithmetic.

### 4. GameController ticks an injectable clock timer with second-granularity DOM emission suppression

`GameController` accepts injectable `setInterval`/`clearInterval`/`now` parameters defaulting to standard timer functions and `Date.now()`.
- While a game is live (`status.over === false` and `turnStartedAt !== null`), `GameController` ticks on a 100ms interval.
- Because `formatClock` renders second granularity (`M:SS`), timer ticks suppress `onClock` callbacks unless the rounded second value (`Math.floor(display/1000)`) changes, reducing DOM updates by ~90%.
- Authoritative state updates (`handleState`) bypass suppression and emit immediately, ensuring moves never lag by up to a second.
- The idle side displays its authoritative value without ticking.
- Interpolated values clamp at 0 without going negative.
- The timer stops when the game ends or when the controller stops.

### 5. Web image build chain & build-order gate expansion

- Moved `@chess-platform/realtime-gateway` from `devDependencies` to `dependencies` in `packages/web/package.json`.
- Added root `build:web` script in `package.json` building `@chess-platform/core`, `@chess-platform/game`, `@chess-platform/realtime-gateway`, and `@chess-platform/web` in dependency order.
- Updated `Dockerfile.web` to run `npm run build:web`.
- Extended `scripts/check-docker-build-order.mjs` into a parameterized checker validating both `server` (`build:server` -> `@chess-platform/api`) and `web` (`build:web` -> `@chess-platform/web`) container build chains.

### 6. The anchor is coerced at the boundary, and skew is measured on open

Both raised in the review of PR #100, both confirmed against the source before being fixed.

**The anchor was trusted where it enters.** `decodeServer()` validates only the `t` discriminant and
casts the rest, so `turnStartedAt` is a claim about a frame rather than a fact about it. The guard
`state.turnStartedAt !== null` admits `undefined`, which reaches `interpolateRemaining` and yields
`NaN` remaining — a `NaN:NaN` clock face. This is not a malformed-input hypothetical: a gateway
built before this ADR sends exactly that frame, and a rolling deploy serves the new bundle against
the old gateway as a matter of course. `GameSync` now coerces through a `clockAnchor()` helper on
both paths that set it — the snapshot's `turnStartedAt` and the move broadcast's `serverTs`, the
second of which the review did not mention and which is exposed identically.

The coercion lives at the boundary and only there; the controller keeps trusting its declared
`number | null` rather than re-checking a value that has already been made true.

**Skew arrived up to 25 seconds late.** `startHeartbeat()` armed the interval without pinging, and
`skewMs` is only set on `pong`, so `GameSync.skew` fell back to `0` for a full `heartbeatMs` —
always including the seconds right after a join or reload, which is exactly when a player watches
the clock. On a machine set ahead of the server that reads as time already spent, so the countdown
could show `0:00` on a game that had barely started. The socket now pings once on open and keeps its
existing schedule after that.

The alternative — suppressing interpolation until the first pong — was rejected: it reinstates the
frozen clock this increment exists to remove, for the sake of a correction that is zero on a
correctly-set machine.

## Consequences

- The client clock ticks down continuously while waiting for a move, across live play and mid-game page reloads.
- DOM clock writes occur once per second instead of 10 times per second during countdowns.
- `docker compose build web` succeeds on clean checkouts.
- `npm run check:build-order` guards both server and web container image build chains.

## Out of scope

- Authoritative timing and flagging logic on the server.
- The claim-timeout command handling behind `#action-claim-flag` ("Claim timeout" in the UI).
- CSS layout and tournament board clocks.
