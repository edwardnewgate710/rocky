# AI Handover — Gambit

> Quickstart for any engineer or AI agent continuing this project **from GitHub alone**.
> The detailed, living handover is [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) — read it
> next. This file is the 60-second orientation and the guardrails.

## What this is

*Gambit* — an AGPL-3.0 open-source chess platform (feature parity with Lichess/Chess.com plus
a first-class AI layer), built as an npm-workspaces monorepo of **strict-TypeScript,
dependency-free domain packages** tested with the built-in `node --test` runner.

## Where things are

- `docs/ARCHITECTURE.md` — the target system architecture (the design everything builds toward).
- `docs/ROADMAP.md` — milestones (M1–M14) with explicit acceptance criteria; ✅/🚧/⬜ status.
- `docs/PROJECT_STATE.md` — the **living handover**: what's done, how it's built, decisions,
  deferrals, and the exact next step. Update it after every milestone.
- `docs/DATABASE.md` + `docs/adr/*` — the approved data contract and Architecture Decision Records.
- `packages/*` — the code. Each package has its own `README.md`, `tsconfig.json`, and tests.

## Current status (2026-07-06)

| Milestone | Package | Status | Tests |
|---|---|---|---|
| M1 | `@chess-platform/core` | ✅ rules engine (perft-verified) | 16 |
| M2 | `@chess-platform/game` | ✅ event-sourced game authority | 18 |
| M3 | `@chess-platform/realtime-gateway` | ✅ realtime WS edge | 26 |
| M4a | `@chess-platform/persistence` | ✅ durable event store + repositories | 14 (+2 gated) |
| M4b | `@chess-platform/api` | ✅ stateless REST + identity | 45 |
| **M5** | `@chess-platform/engine` | ✅ **engine bridge (this milestone)** | 51 |

**Whole repo: 207 tests green** (2 Postgres-gated skips). Strict TS, lint clean.

M5 design/decisions: [`docs/ENGINE_BRIDGE.md`](docs/ENGINE_BRIDGE.md) +
[`docs/adr/0002-engine-bridge.md`](docs/adr/0002-engine-bridge.md) (Accepted).

## Build & test

```bash
npm install
npm run build   # core → game → realtime-gateway → persistence → api → engine
npm test        # all package suites via node --test
npm run lint    # strict typecheck across packages
```
Per package: `cd packages/<pkg> && npm install && npm run build && npm test`.
Postgres-gated tests need `DATABASE_URL`; everything else (incl. the engine suite) is hermetic.

## Working method (do not skip)

Every milestone: **build to explicit acceptance criteria with tests → self-critique loop →
multi-perspective review (distributed-systems, performance, security, chess-server maintainer)
→ refactor → document → commit → push.** Advance only when clean. Architectural decisions that
introduce a durable/shared contract get a **gate** (a design doc + ADR, approved before code) —
see the M4 `DATABASE.md` and M5 `ENGINE_BRIDGE.md` precedents.

## Guardrails

- **Milestone 6 is IN PROGRESS** (`@chess-platform/web` increment 3B: tested view core + interactive board + REST networking foundation + **WebSocket foundation + gameplay synchronization** — `WebSocketConnection` port, `WsClient` (reconnect/heartbeat), typed wire protocol, `GameSync` (join/resume, optimistic moves, ply-gap resync); UI kept separate from networking; 115 web tests). Increment **3C-1** then landed: the web **application composition root** (`packages/web/src/app/`) wiring `GambitClient` + `WsClient` + a `GameSync` factory via dependency injection, with `main.ts` reduced to a thin DOM entry (wiring only — no connection, gameplay sync, or server-backed oracle; 121 web tests). Increment **3C-2A** then landed: the authoritative realtime `StateView` gained a typed `legalMoves` map (origin square → legal destinations), computed server-side by the core engine in the gateway `GameAuthority` and mirrored in `web`'s `ws-protocol.ts` — step 1 of the server-backed `LegalMoveOracle` (ADR-0003, Option 2; do not import `@chess-platform/core` into `web`). Increment **3C-2B** then landed: `legalMoves` is now surfaced through `GameSync` state (populated from each authoritative snapshot, stale after a live move broadcast, empty once the game ends) and a new `AuthoritativeMoveOracle` adapter implements the existing `LegalMoveOracle` port, fed by the `GameSync` state's `legalMoves` map (no chess rules in the client; 131 web tests). Increment **3C-2C** then landed: the `AuthoritativeMoveOracle` is now wired into the composition root — `createApp` exposes `createGameOracle(gameSync)` which builds an `AuthoritativeMoveOracle` reading the live `legalMoves` from `GameSync` state, and `mountBoard` accepts an optional `LegalMoveOracle` (defaulting to `NullMoveOracle`) so the board's legal-move highlights reflect the server's authoritative state; the offline `StaticMoveOracle` placeholder is removed (133 web tests). Increment **3D** then landed: a pure, DOM-free `GameController` (`packages/web/src/app/game-controller.ts`) bridges `GameSync` state to the board UI — it subscribes to state changes, projects the current FEN from the snapshot + move ledger via the view-only mover, exposes callbacks for position/turn/clock/status/last-move updates, and forwards move submissions to `GameSync`; 9 tests covering snapshot projection, move replay, game-over status, spectator mode, and unsubscribe (142 web tests). Increment **3E** then landed: the full live game view wiring — `bootstrap.ts` now assembles the complete game view graph (GameSync + GameController + AuthoritativeMoveOracle + mountBoard with oracle and onMove callback), connecting the controller's callbacks to the DOM BoardView (position, last-move highlight, turn, clock display, status text) and forwarding user moves through the controller to GameSync; `mountBoard` exposes `setPosition`/`setLastMove`/`setTurn` on the `MountedBoard` handle and accepts an `onMove` callback for server-authoritative mode; `extractGameId` parses the game ID from the URL path; `formatClock` formats ms as M:SS; clock display CSS added; 17 new tests (159 web tests). M5 is complete; for the broader track after M6 pick from
  `docs/PROJECT_STATE.md` §"Exact next step" (M4 WebAuthn hardening, or M14 engine wiring).
- Keep domain packages **dependency-free**; native/infra code stays behind documented seams.
- No placeholders, TODO-implementations, or temporary hacks — production quality only.
- Keep GitHub authoritative: after each checkpoint update README/ROADMAP/PROJECT_STATE/this file,
  then commit and push, so the next agent needs no conversation history.

## Known tech debt (tracked, unchanged by M5)

CI workflow is staged at `docs/ci/ci.yml` (needs `workflow` scope to activate); a stray root
`chess` file needs `git rm`; committed lockfiles are inconsistent. See `docs/PROJECT_STATE.md` §6.
