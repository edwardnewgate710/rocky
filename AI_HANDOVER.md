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
- `docs/RUNNING.md` — the one-command local stack (`docker compose up`).
- `docs/DEPLOYING.md` — the Kubernetes/Helm deployment flow (`deploy/helm/gambit`).
- `packages/*` — the domain/service packages. `services/gateway` — the deployable realtime
  gateway binary (infra adapters: Postgres event log, Redis pub/sub, `ws`).

## Current status (2026-07-12)

| Milestone | Package(s) | Status | Tests |
|---|---|---|---|
| M1 | `@chess-platform/core` | ✅ rules engine (perft-verified) | 16 |
| M2 | `@chess-platform/game` | ✅ event-sourced game aggregate + clocks + threefold repetition | 23 |
| M3 | `@chess-platform/realtime-gateway` | ✅ realtime WS edge + token auth + durable `EventLog` port + `PubSub` (in-memory & Redis) | 56 |
| M4a | `@chess-platform/persistence` | ✅ durable event store + repositories + Glicko-2 | 16 (2 DB-gated) |
| M4b | `@chess-platform/api` | ✅ stateless REST + identity (scrypt, rotating refresh, RBAC) | 48 |
| M5 | `@chess-platform/engine` | ✅ provider-agnostic UCI engine bridge | 50 |
| M6 | `@chess-platform/web` + `@chess-platform/e2e-harness` | ✅ playable frontend; Playwright full-game e2e + Lighthouse a11y ≥ 0.95 in CI | 239 + 2 |
| M7 | `@chess-platform/ai-orchestrator` | ✅ AI routing/failover/caching + engine-grounded prompts | 114 (2 key-gated) |
| M8 | `@chess-platform/ai-features` | ✅ 8 features (Move Explanation → Voice Coach); Tournament Commentator deferred to M9 | 137 (16 key-gated) |
| **M14** | compose + `services/gateway` + `deploy/helm` | 🚧 **increments 1–4 complete:** local compose stack · durable game authority (write-through `EventLog` → Postgres, evict/rehydrate) · Redis pub/sub multi-node fanout (ADR-0008) · Helm chart + kubeconform CI gate (ADR-0009) · threefold-repetition fix (en-passant legality in repetition key) | — |

**Whole repo: 701 total tests, 0 failures** (skips: 2 Postgres-gated + 18
API-key-gated). Strict TS, lint clean. **CI is active** (`.github/workflows/ci.yml`, 5 jobs:
build+typecheck+test on Node 22/24, Postgres integration, M6 Playwright+Lighthouse acceptance,
helm lint+kubeconform).

M9–M13 (tournaments, social/learning + GraphQL, search, security/anti-cheat, observability)
are ⬜ planned — see the ROADMAP.

## Build & test

```bash
npm ci          # reproducible install (root package-lock.json is committed)
npm run build   # dependency order: core → game → realtime-gateway → persistence → api → engine → web → e2e-harness → ai-*
npm test        # all package suites via node --test
npm run lint    # strict typecheck across packages
```
Run **build before lint/test** on a fresh clone — downstream packages resolve upstream types
from built `dist/`. Postgres-gated tests need `DATABASE_URL`; AI-adapter integration tests need
provider API keys; everything else is hermetic. Local full stack: `docker compose up --build`
(see RUNNING.md). Helm chart checks: `helm lint deploy/helm/gambit`,
`helm template deploy/helm/gambit | kubeconform -strict -summary`,
`bash scripts/helm-snapshot-test.sh`.

## Working method (do not skip)

Every milestone: **build to explicit acceptance criteria with tests → self-critique loop →
multi-perspective review (distributed-systems, performance, security, chess-server maintainer)
→ refactor → document → commit → push.** Advance only when clean — run the full
`npm ci && npm run build && npm test && npm run lint` gate before reporting done.
Architectural decisions that introduce a durable/shared contract get a **gate** (a design doc +
ADR, approved before code) — see `DATABASE.md` (M4), `ENGINE_BRIDGE.md` (M5), ADR-0008/0009 (M14).

## Guardrails

- **Gateway horizontal scaling is NOT safe yet.** Redis fans broadcasts across nodes, but
  game-command *ownership* is not coordinated across gateway replicas — the Helm chart pins
  `gateway.replicas: 1` and must stay that way until sticky per-game routing or sharded
  authority lands (a later M14 increment). Do not scale the gateway or imply that it scales.
- Keep domain packages **dependency-free**; native/infra code (pg, ioredis, ws) enters only via
  documented ports (`EventLog`, `PubSub`/`RedisLike`, `TokenVerifier`, `EngineTransport`) wired
  in `services/gateway` or package `/pg`-style subpaths — never in domain code.
- No placeholders, TODO-implementations, or temporary hacks — production quality only.
- Keep GitHub authoritative: after each checkpoint update README/ROADMAP/PROJECT_STATE/this
  file, then commit and push, so the next agent needs no conversation history.

## Known tech debt (tracked, updated 2026-07-12)

- **Identity hardening (M4 follow-up)** — WebAuthn/passkeys (table exists, flow doesn't),
  password reset + email verification, per-account login rate limiting.
- **Client refresh-token storage** — currently `localStorage`; move to httpOnly cookie in M12.
- **Gateway multi-replica ownership** — see the first guardrail; next M14 increments also
  include Terraform, CI/CD deploy gates (blue/green), load/chaos testing, secrets management.

Full details and the exact next step: `docs/PROJECT_STATE.md`.
