# ADR-0034 — Anti-Cheat On-Demand Analysis Pipeline

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-23                                                       |
| **Scope**  | `@chess-platform/api` (M12)                                     |

---

## Context

Anti-Cheat Increments 1–5 established the pure domain analyzer, cross-game account aggregator, `EngineBackedEvaluator` adapter, application service/repository ports, Postgres persistence schema, and read-only moderation endpoints. The trigger pipeline that processes finished games through engine evaluation and persists reports was deferred to Increment 6.

## Decision

We implement an on-demand anti-cheat analysis pipeline in `@chess-platform/api` and expose a moderator-gated REST API endpoint to trigger analysis for a specific finished game.

### Pipeline Architecture & Ports

1. **`FinishedGameSource` Port & `EventStoreGameSource` Adapter:**
   - Interface `FinishedGameSource` defines `load(gameId): Promise<FinishedGame | null>`.
   - `EventStoreGameSource` loads historical events from `EventStore`, reconstructs the game state using `Game.fromEvents`, and validates that:
     - The game exists (`stored.length > 0`).
     - The game is finished (`state.status.over === true`).
     - Both player IDs (`white` and `black`) are present.
   - Unfinished or incomplete games return `null` and are rejected before engine evaluation.

2. **`AntiCheatAnalysisService` Application Service:**
   - Coordinates `FinishedGameSource`, an evaluator factory `(variant: Variant) => PositionEvaluator`, and `AntiCheatReportRepository`.
   - Reconstructs UCI move lists into per-ply FENs via `extractPlies` from `@chess-platform/anti-cheat/engine`.
   - Delegates scoring and storage to `AntiCheatService.analyzeAndStore` from `@chess-platform/anti-cheat`, ensuring idempotent upserts keyed by `(playerId, gameId)`.
   - Defaults analysis depth to `DEFAULT_ANALYSIS_DEPTH = 18`.

### Moderation Endpoint

`POST /v1/moderation/anti-cheat/games/:gameId/analyze`
- **Authorization:** Gated by policy `MODERATION` (`moderator` or `admin` role required).
- **Request Body:** Optional `{ depth?: number }`, strictly parsed with `strictObject` and `optInt` to enforce integer bounds `[8, 30]`.
- **Audit Logging:** Every attempt is recorded in the audit log (`anti_cheat.analyze`) before invoking the analysis service.
- **Engine Availability:** Returns `503 Service Unavailable` when `antiCheatAnalysis` is not injected (`anti-cheat analysis engine is not configured`), and also when the wired engine has no registered support for the game's variant — a `NoEngineForVariantError` from the provider is translated to a 503 rather than a 500.
- **Response:** Returns `200 OK` with an `AntiCheatGameAnalysisView` (`{ white, black }` per-player correlation reports) on success, or `404 Not Found` if no finished game exists with the given ID.

### Wiring & Engine Gating

- Real-engine production wiring is env-gated behind `PgBootstrapOptions.analysisProvider`. In production bootstrap (`createPgDependencies`), `AntiCheatAnalysisService` is instantiated only when `analysisProvider` is supplied. When absent, `antiCheatAnalysis` remains undefined and the endpoint returns 503.
- In test environments (`startHarness`), a deterministic fake evaluator is wired to allow hermetic integration testing without launching real engine binaries.

### Deferred Background Worker

Automated background triggers (e.g. PubSub listeners or event consumers automatically analyzing finished games upon completion) are deferred to Increment 7.

## Consequences

- **On-Demand Moderation:** Moderators can immediately trigger analysis for suspicious games on demand via the API.
- **Strict Validation & Auditing:** Input parameters and game IDs are validated prior to execution, and all analysis triggers leave an audit trail.
- **Safe Engine Delegation:** Production bootstrap keeps engine wiring optional, avoiding unexpected engine binary dependencies unless explicitly configured.
