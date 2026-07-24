# ADR-0039 — Bot Detection Service & Report Repository

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

Increments 1–3 introduced single-game behavioral bot analysis (`analyzeBotBehavior`), account-level cross-game aggregation (`aggregateBotBehavior`), and move-timing extraction (`extractTimedMoves`).

To use these behavioral primitives in an end-to-end flow, we need a pure domain orchestration service (`BotDetectionService`) and a report repository port (`BotBehaviorReportRepository` with an in-memory adapter `InMemoryBotBehaviorReportRepository`) mirroring the engine-correlation pattern (`AntiCheatService` and `AntiCheatReportRepository`).

## Decision

We introduce `BotBehaviorReportRepository` (`src/bot-repository.ts`) and `BotDetectionService` (`src/bot-service.ts`) in `@chess-platform/anti-cheat`.

### 1. Repository Port & In-Memory Adapter (`BotBehaviorReportRepository`)

`BotBehaviorReportRepository` defines two methods:
- `saveBatch(records: readonly StoredBotReport[]): Promise<void>`: Atomic batch upsert.
- `listByPlayer(playerId: string): Promise<readonly StoredBotReport[]>`: Retrieves all stored reports for a given player account.

`InMemoryBotBehaviorReportRepository` implements the port using a nested `Map<playerId, Map<gameId, StoredBotReport>>`. Keying by `(playerId, gameId)` enforces idempotency: re-analyzing a game replaces prior stored records rather than appending duplicates, preventing `aggregateBotBehavior`'s duplicate-`gameId` guard from tripping.

### 2. Pure Orchestration Service (`BotDetectionService`)

`BotDetectionService` accepts an injected `BotBehaviorReportRepository` and exposes two orchestrations:

- `analyzeAndStore(input: AnalyzeBotAndStoreInput): Promise<GameBotReport>`:
  0. Rejects a game whose two player IDs are identical: records are keyed by `(playerId, gameId)`, so equal ids would make the black record silently overwrite the white one (two reports returned, one stored). It fails loudly instead of losing data.
  1. Calls `extractTimedMoves(input.moves, input.isBook)` to separate white and black `TimedMove[]`.
  2. Runs `analyzeBotBehavior` for each player.
  3. Upserts both players' `StoredBotReport` records atomically via `repository.saveBatch`.
  4. Returns `{ white, black }` reports.

- `aggregatePlayer(playerId: string): Promise<BotAggregateReport>`:
  1. Retrieves stored reports via `repository.listByPlayer(playerId)`.
  2. Maps records to `BotAggregateInput[]` (`{ gameId, report }`).
  3. Passes inputs to `aggregateBotBehavior` to compute the account-level behavioral signal.

### 3. Key Divergence from Engine Correlation (`AntiCheatService`)

Unlike `AntiCheatService` (which requires an injected `PositionEvaluator` engine adapter), `BotDetectionService` requires **no evaluator or engine**. Behavioral timing analysis operates entirely on wall-clock move durations (`MoveTiming`), making `BotDetectionService` lightweight and engine-independent.

### 4. Pure Domain & Deferrals

- **Pure Domain:** Pure TypeScript, zero external dependencies, no I/O, no database bindings.
- **Deferrals:** Postgres table & repository adapter, moderation REST API endpoints (`GET /v1/moderation/bot-detection/...`), automatic triggering workers, and game-loading adapters mapping real `MovePlayedEvent` streams to `MoveTiming[]` are deferred to subsequent increments.

## Consequences

- **Architectural Symmetry:** Bot detection aligns with engine-correlation architecture (`service.ts` / `repository.ts`), creating a consistent pattern across `@chess-platform/anti-cheat`.
- **Idempotency & Re-Analysis Safety:** Keying storage by `(playerId, gameId)` guarantees safe re-runs without duplicate accumulation or aggregate error trips.
- **Engine-Free Simplicity:** Decoupled timing analysis executes rapidly without engine overhead or async position evaluation delays.
