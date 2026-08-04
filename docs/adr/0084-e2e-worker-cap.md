# ADR-0084 — Playwright Worker Cap & Per-Game Bot RNG

| Field      | Value                                  |
|------------|----------------------------------------|
| **Status** | Accepted                               |
| **Date**   | 2026-08-04                             |
| **Scope**  | `packages/web`, `packages/e2e-harness` |

---

## Context

Running the Playwright E2E suite (`packages/web/playwright.config.ts`) on high-core developer machines exhibited severe test flakiness, hard failures, and long wall-clock runtimes. Previously, `packages/web/playwright.config.ts` specified no `workers` property, causing Playwright to default to half the logical CPU count (10 workers on a 24-core machine).

Because all backend-dependent specs share a single `e2e-harness` process and Vite preview server, running 10 parallel Chromium instances with multiple browser contexts created extreme resource contention. Measurements on the same machine and commit demonstrated that the suite degraded globally across all specs:

| Workers | Wall Clock | Passed | Failed | Flaky | Slowest Single Attempt |
|---|---|---|---|---|---|
| 10 | 485.6s | 14 | 1 | 8 | 305.1s |
| 6 | 110.8s | 20 | 0 | 3 | 104.1s |
| 4 | 64.6s | 23 | 0 | 0 | 54.0s |
| 4 | 64.4s | 23 | 0 | 0 | 53.7s |
| 4 | 63.4s | 23 | 0 | 0 | 53.8s |

Inside the single 10-worker run, `packages/web/e2e/app-loads.spec.ts` — a static spec that never touches the backend — took 638ms on one attempt and 200,621ms on another. `packages/web/e2e/offline-navigation.spec.ts` ranged from 1,275ms to 300,243ms. This confirmed the issue was system-level resource contention starving the shared processes rather than per-spec timing bugs. CI has never reported this failure, which is consistent with GitHub-hosted runners having far fewer cores than a developer workstation and therefore never reaching the contention regime — though the runner's exact core count was not measured, so that explanation is inference, not evidence.

Separately, `BotPlayer` (`packages/e2e-harness/src/bot.ts`) used a single shared RNG stream for move selection across all active games. Under concurrent game execution, move selection draw order depended on interleaved message timing, violating the determinism goal set out in `ADR-0079`.

## Decision

### 1. Dynamic Worker Cap Ceiling (`packages/web/playwright.config.ts`)

`packages/web/playwright.config.ts` is updated to set `workers` using a dynamic ceiling:

```ts
import { cpus } from 'node:os';
...
workers: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))),
```

- On a 24-core machine: clamped to 4 workers.
- On a 4-core machine: 2 workers (unchanged).
- On a 2-core machine: 1 worker (unchanged).

The cap is a ceiling over Playwright's own half-the-CPUs heuristic, so it changes nothing at or below 8 cores and only clamps machines above that.

A fixed setting of `workers: 4` was rejected because it would raise parallelism from 1 to 4 on 2-core CI runners, compounding contention on constrained hardware.

### 2. No Timeout Inflation

Test timeouts (`300_000` ms) and `expect` assertion timeouts were deliberately **not** raised. Un-annotated 5-second assertions (e.g. at `packages/web/e2e/game-actions.spec.ts:56`) pass cleanly when worker count is capped to 4. Raising assertion timeouts would mask resource starvation symptoms rather than addressing the root cause.

### 3. Per-Game Bot RNG (`packages/e2e-harness/src/rng.ts`, `packages/e2e-harness/src/bot.ts`)

A pure 32-bit FNV-1a helper `seedFrom(seed, key)` was added to `packages/e2e-harness/src/rng.ts`. `BotPlayer` in `packages/e2e-harness/src/bot.ts` now creates a dedicated RNG stream for each registered game using `createRng(seedFrom(this.seed, gameId))`.

This isolates each game's move choices from concurrent game interleaving, ensuring that `ADR-0079`'s determinism property holds true under arbitrary concurrency. Unit tests in `packages/e2e-harness/test/bot.test.ts` verify that move sequences for a game are identical whether or not another game's turns are interleaved.

### 4. What Is NOT Covered

- Capping workers bounds local machine contention; it does not make the E2E suite hermetic. All E2E specs still share one `e2e-harness` process and one Vite preview server.
- Machines with severely constrained CPU/IO performance may still require a lower worker ceiling or explicit environment override.

## Consequences

- Capped Playwright worker count eliminates suite flakiness on developer workstations, yielding 3 consecutive clean runs at ~64s with 0 flaky tests.
- Bot move streams are deterministic per game ID across concurrent E2E runs.
- All verification gates (`npm run build`, `npm run lint`, `npm test`, `npm run check:adr-claims`) pass cleanly.
