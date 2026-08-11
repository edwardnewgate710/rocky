# ADR-0092 — Structural bootstrap teardown and disposal exhaustiveness

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-05                                             |
| **Scope**  | `packages/web`                                         |

---

## Context

`bootstrap` (`packages/web/src/app/bootstrap.ts`) builds controllers per route and returns them by name. `run()` in `packages/web/src/main.ts` previously tore down the previous route's controllers by naming each one individually by hand. Its own comment noted that doing so "is what makes re-bootstrapping safe" — but because the list was manual, `main.ts` had no test coverage of any kind, and omitting an entry compiled, passed all CI gates, and leaked resources.

This pattern caused four documented defects prior to this increment:

1. **Increment 23:** `LearningController` was returned by `bootstrap` but omitted from `main.ts`'s teardown list. Caught in PR review (#86), not by a test.
2. **Increment 24:** `BoardView` listeners bound to persistent DOM elements (`#board`) with no teardown. Caught by Qodo (#87).
3. **Increment 24:** The `#flip` button click handler had an identical listener accumulation leak, caught when a test was added.
4. **Live on `main` before this fix:** `GameController` was returned as `result.controller` and `main.ts` never invoked teardown on it. Leaving a game left its `GameSync` subscription attached, accumulating socket subscriptions across navigations.

The goal of this increment is to make forgetting to tear down a disposable structurally impossible or a TypeScript compilation error.

## Decisions

### 1. Derive `DisposableKey` from `BootstrappedDisposables` for compile-time exhaustiveness

`BootstrappedDisposables` defines every disposable returned by `bootstrap()`. `Bootstrapped` extends `BootstrappedDisposables` with the non-disposable infrastructure handles `auth` and `theme`; `app` is disposable because it owns the route's realtime client.

Teardown is driven by `DISPOSABLE_TEARDOWN_MAP`, typed strictly as `Record<DisposableKey, true>`. Adding a new field to `BootstrappedDisposables` without registering it in `DISPOSABLE_TEARDOWN_MAP` causes TypeScript compilation to fail immediately:

```
src/app/lifecycle.ts(23,14): error TS2741: Property 'newSection' is missing in type '{ controller: true; board: true; … }' but required in type 'Record<keyof BootstrappedDisposables, true>'
```

This guarantees that omitting a disposable controller is a compile error rather than a silent runtime leak.

### 2. Extract lifecycle execution into a testable `createLifecycle` unit

`main.ts` previously bound listeners and executed lifecycle loops directly on module load, making unit testing impossible.

The lifecycle run/teardown loop is extracted into `createLifecycle` (`packages/web/src/app/lifecycle.ts`). It accepts a `bootstrapFn` seam, guarantees all disposables from the previous route are disposed before the next bootstrap runs, and exposes `run()`, `getCurrentTheme()`, and `teardown()`. `main.ts` remains a thin DOM entry point delegating to `createLifecycle`.

### 3. Normalise teardown verb across all disposables to `dispose()`

Teardown verbs were previously inconsistent (`dispose()` on most controllers, `stop()` on `GameController`, `destroy()` on `MountedBoard`).

All disposables carried by `BootstrappedDisposables` now implement `dispose(): void`. `GameController` exposes `dispose(): void` (aliasing `stop()`), and `MountedBoard` exposes `dispose(): void` (aliasing `destroy()`). Existing public method names are preserved for callers.

### 4. Cascade `GameController.stop()` into `gameSync.stop()`

`GameController.stop()` (and `dispose()`) now invokes `this.gameSync.stop()`. `GameSync.stop()` unsubscribes `GameSync` from the shared `WsClient` without terminating the underlying app-wide WebSocket connection, releasing game socket subscriptions promptly when leaving a game route.

### 5. Dispose route-owned browser connectivity resources

Each bootstrap creates its own `App` and therefore owns that app's `WsClient`. `App.dispose()` closes the realtime connection and cancels its reconnect and heartbeat timers. Game routes also return a connectivity disposable that removes their named `online` and `offline` listeners and invalidates any deferred socket start still waiting for authentication restoration. The teardown map disposes the game controller and connectivity listener/guard before disposing the app, so a navigation cannot leave or later reopen a socket or browser listener.

## Consequences

- Forgetting to register a disposable returned by `bootstrap` causes an immediate TypeScript compile error.
- The run/teardown loop has unit tests for the first time, without needing a DOM (`packages/web/test/lifecycle.test.ts`): teardown happens before the next bootstrap, a `null` slot is skipped, and the exhaustiveness guarantee is pinned by a `@ts-expect-error` case that stops compiling if the guard is ever weakened. What is *not* covered is whether each individual controller's own `dispose()` does the right thing — those remain each controller's own tests.
- `GameController` and `GameSync` subscriptions release cleanly when navigating away from `/game/{id}` routes.
- The route-owned WebSocket and its `online`/`offline` browser listeners are released on every game-route teardown.
- `main.ts` is simplified to a thin DOM event binding shell around `createLifecycle`.

## Alternatives considered

- **Group every disposable into a nested `result.disposables` or `result.sections` object and iterate `Object.values`:** Rejected because it would break existing named property access on `Bootstrapped` (`result.lobby`, `result.board`, `result.controller`, etc.) across test files and consumers. Deriving `DisposableKey` via `Record<DisposableKey, true>` preserves backward-compatible top-level property access while providing an equivalent compile-time exhaustiveness guarantee.
