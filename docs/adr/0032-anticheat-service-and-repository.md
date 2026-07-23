# ADR-0032 — Anti-Cheat Service and Repository

| Field      | Value                              |
|------------|------------------------------------|
| **Status** | Accepted                           |
| **Date**   | 2026-07-23                         |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

Increments 1–3 provided the pure domain logic for analyzing a game and aggregating per-player reports, alongside an engine evaluator adapter. We need an application layer to compose these pieces into a usable flow: analyzing a game, storing the reports for each player, and retrieving those reports to build an aggregate account-level signal.

## Decision

We introduce an application-layer `AntiCheatService` and an `AntiCheatReportRepository` port, plus an in-memory adapter.

### Injected Port Design

The `AntiCheatService` takes a `PositionEvaluator` (port) and an `AntiCheatReportRepository` (port) by dependency injection.
This keeps the service and the root of `@chess-platform/anti-cheat` pure and dependency-free. The service orchestrates the flow without importing concrete engine adapters (`@chess-platform/engine`) or infrastructure details.

### Repository Upsert Key & Atomic Persistence

The repository stores records keyed by `(playerId, gameId)`.
- `AntiCheatReportRepository` exposes `saveBatch` to commit both player's reports atomically (in the same synchronous tick).
- `InMemoryAntiCheatReportRepository` implements this with a nested map (`playerId` -> `gameId` -> `report`), eliminating delimiter-based string key collisions.
- This ensures idempotency: re-analyzing a game replaces the prior record rather than appending a duplicate.
- Because a player can have at most one record per `gameId`, the `aggregatePlayer` duplicate `gameId` guard will never trip when aggregating a player's history directly from the repository.

### Deferred Storage

Postgres and moderation REST API implementations are deferred to Increment 5. This increment focuses strictly on the pure orchestration and in-memory verification.

## Consequences

- **Idempotency Guarantees.** Re-analyzing games is safe and won't inflate aggregate signals by double-counting.
- **Purity Maintained.** The domain package retains its purity and testability without being tied to a specific persistence technology.
- **Incremental Delivery.** We prove the service and repository patterns entirely in-memory before wiring them to a real database in the next increment.
