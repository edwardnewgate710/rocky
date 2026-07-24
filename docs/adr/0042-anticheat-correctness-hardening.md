# ADR-0042 — Anti-Cheat Correctness Hardening (Engine Correlation)

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-24                                                       |
| **Scope**  | `@chess-platform/anti-cheat`, `@chess-platform/persistence` (M12) |

---

## Context

Earlier increments introduced engine-correlation anti-cheat scoring (`AntiCheatService`) and Postgres report persistence (`anti-cheat_reports` table, `PgAntiCheatReportRepository`). Twin correctness hardening fixes were previously applied to the move-time behavioral bot detection components (`BotDetectionService`, `PgBotBehaviorReportRepository`, `0011_bot_reports.sql`).

This ADR documents applying identical correctness hardening to the engine-correlation anti-cheat implementation.

## Decision

We apply two correctness hardening fixes to engine-correlation anti-cheat:

### 1. Reject Identical White/Black Player IDs in `AntiCheatService.analyzeAndStore`

- **Bug:** `AntiCheatService.analyzeAndStore` keys stored reports by `(playerId, gameId)`. If `input.players.white === input.players.black`, the black record in `repository.saveBatch` silently overwrote the white record. Two reports were returned by `analyzeAndStore`, but only one was persisted, corrupting downstream aggregation (`aggregatePlayer`).
- **Fix:** Added a guard as the first statement in `AntiCheatService.analyzeAndStore` mirroring `BotDetectionService.analyzeAndStore`:
  ```ts
  if (input.players.white === input.players.black) {
    throw new Error(
      `AntiCheatService.analyzeAndStore: white and black must be different players (got "${input.players.white}" for both)`,
    );
  }
  ```
  Degenerate input where white and black IDs match is rejected loudly before evaluation or storage.

### 2. Deterministic `listByPlayer` Ordering & Migration 0012

- **Bug:** `now()` is fixed per database transaction. When multiple records for a player share a transaction or creation timestamp, ordering queries solely by `created_at ASC` yields non-deterministic row ordering. This can cause paginated moderation endpoints (`/v1/moderation/anti-cheat/players/:playerId/games`) to repeat, reorder, or skip records across requests.
- **Fix:**
  1. Updated `PgAntiCheatReportRepository.listByPlayer` SQL query to order by `ORDER BY created_at ASC, game_id ASC`, introducing `game_id` as a unique tie-breaker.
  2. Added migration `packages/persistence/migrations/0012_anti_cheat_reports_index.sql`:
     ```sql
     DROP INDEX IF EXISTS anti_cheat_reports_player_created_idx;
     CREATE INDEX anti_cheat_reports_player_created_idx
       ON anti_cheat_reports (player_id, created_at, game_id);
     ```
  3. Updated `docs/DATABASE.md` §4.5 to document `(player_id, created_at, game_id)` and the `game_id` tie-breaker rationale.

## Consequences

- **Data Integrity:** `AntiCheatService.analyzeAndStore` guarantees that both players' engine correlation reports are persisted without silent overwrite when given invalid inputs.
- **Deterministic Pagination:** `PgAntiCheatReportRepository.listByPlayer` yields stable, deterministic ordering across repeated calls and paginated moderation API requests.
- **Parity Across Engines & Signals:** Engine correlation (`AntiCheatService` / `PgAntiCheatReportRepository`) and behavioral bot detection (`BotDetectionService` / `PgBotBehaviorReportRepository`) maintain identical safeguards and storage semantics.
