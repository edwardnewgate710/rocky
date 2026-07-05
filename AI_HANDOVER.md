# AI Handover — Gambit

> Quickstart for an engineer or AI agent continuing this project **from GitHub alone**.
> The detailed, living handover is [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) — read it
> next. This file is the 60-second orientation and the guardrails.

## What this is

*Gambit* — an AGPL-3.0 open-source chess platform (feature parity with Lichess/Chess.com plus
a first-class AI layer), built as an npm-workspaces monorepo of **strict TypeScript,
dependency-free domain packages** tested with the built-in `node --test` runner.

## Where things are

- `docs/ARCHITECTURE.md` — architecture (the design everything builds toward).
- `docs/ROADMAP.md` — milestones (M1–M14) with explicit acceptance criteria; ✅/🚧/⬜ status.
- `docs/PROJECT_STATE.md` — live handover: what's done, how it's built, decisions,
  deferrals, and the exact next step. Update it after every milestone.
- `docs/DATABASE.md` + `docs/adr/*` — data contract + ADRs.
- `packages/*` — code. Each package has its own `README.md`, `tsconfig.json`, and tests.

## Current status (2026-07-05)

| Milestone | Package | Status | Tests |
|---|----|----|----|
| M1 | `@chess-platform/core` | ✅ rules engine (perft-verified) | 16 |
| M2 | `@chess-platform/game` | ✅ event-sourced game authority | 18 |
| M3 | `@chess-platform/realtime-gateway` | ✅ realtime WS edge | 26 |
| M4a | `@chess-platform/persistence` | ✅ durable event store + repos | 14 (+2 gated) |
| M4b | `@chess-platform/api` | ✅ stateless REST + identity | 45 |
| **M5** | `@chess-platform/engine` | ✅ **engine bridge (this milestone)** | 51 |
| **M6** | `@chess-platform/web` | 🚧 **web frontend (increment 3C: composition root wired)** | 115 |

**Whole repo: 170 tests green** (2 Postgres-gated skips). Strict TS, lint clean.

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
→ reflect → document → commit → push.** Advance only when clean. Architectural decisions that
introduce a durable/shared contract get a **gate** (a design doc + ADR, approved before code) —
see the M4 `DATABASE.md` and M5 `ENGINE_BRIDGE.md` precedents.

## Guardrails

- **Milestone 6 is IN PROGRESS** (`@chess-platform/web` increment 3C: composition root wired).
  Immediate next is **increment 4** (lobby/matchmaking UI, profile page, Playwright e2e,
  Lighthouse a11y gate). M5 is complete; for the broader track after M6 pick from
  `docs/PROJECT_STATE.md` §"Exact next step" (M4 WebAuthn hardening, or M14 engine wiring).
- Keep domain packages **dependency-free**; native/infra code stays behind documented seams.
- No placeholders, TODO-implementations, or temporary hacks — production quality only.
- Keep GitHub authoritative: after each checkpoint update README/ROADMAP/PROJECT_STATE/this file,
  then commit and push, so the next agent needs no conversation history.

## Known tech debt (tracked, unchanged by M5)

CI workflow is staged at `docs/ci/ci.yml` (needs `workflow` scope to activate); a stray root
`chess` file needs `git rm`; committed lockfiles are inconsistent. See `docs/PROJECT_STATE.md` §6.
