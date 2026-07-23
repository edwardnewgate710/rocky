# ADR-0033 — Anti-Cheat Persistence and Moderation REST API

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-23                                                       |
| **Scope**  | `@chess-platform/persistence`, `@chess-platform/api` (M12)       |

---

## Context

Increments 1–4 defined the pure domain analysis engine, account-level pooling aggregator, `EngineBackedEvaluator` adapter, and `AntiCheatService`/`AntiCheatReportRepository` ports. Persistence in Postgres and moderator-gated REST API endpoints were deferred to Increment 5.

## Decision

We implement Postgres-backed storage for anti-cheat reports and add read-only moderation endpoints to the REST API.

### Table Schema & Primary Key Rationale

We add migration `0010_anti_cheat_reports.sql` creating table `anti_cheat_reports`:

```sql
CREATE TABLE anti_cheat_reports (
  player_id  UUID        NOT NULL,
  game_id    UUID        NOT NULL,
  color      TEXT        NOT NULL CHECK (color IN ('white', 'black')),
  report     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);
```

- **No Foreign Keys:** The domain treats `player_id` and `game_id` as opaque identifiers. Analytical anti-cheat records must survive independently of referenced rows in `users` or `games` (e.g. account deletion or historical data cleanup).
- **Index Optimization:** The composite primary key `(player_id, game_id)` indexes `player_id` as a key prefix, making the `WHERE player_id = $1` filter in `listByPlayer` efficient. It does **not** cover the query's `ORDER BY created_at ASC` — Postgres still needs a separate sort without a supporting index — so a dedicated `(player_id, created_at)` index is added alongside the table.

### Atomic Batch Upsert

`PgAntiCheatReportRepository` implements `AntiCheatReportRepository`:

- `saveBatch(records)` connects to the pool and runs within an explicit SQL transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`). Both players' (white and black) reports for a game are saved atomically.
- Record upserts use `ON CONFLICT (player_id, game_id) DO UPDATE SET color = EXCLUDED.color, report = EXCLUDED.report, updated_at = now()`. Re-analyzing a game replaces the existing record rather than appending duplicates, preserving repository idempotency and preventing duplicate game errors in `aggregatePlayer`.

### Read-Only Moderation REST API

We add two endpoints to `@chess-platform/api`, gated by policy `MODERATION` (`moderator` or `admin` role required). Both validate `:playerId` as a UUID (422 on malformed input, before it can reach a `UUID` column) and record their audit entry **before** reading any report data, so a moderator can never observe a report without a durable access record for it.

1. `GET /v1/moderation/anti-cheat/players/:playerId`
   - Fetches all stored per-game reports for `:playerId` via `listByPlayer`.
   - Reuses `aggregatePlayer` from `@chess-platform/anti-cheat` to compute an account-level `PlayerAggregateReport` dynamically.
   - Records an audit log entry (`anti_cheat.aggregate.view`).
   - An empty player history returns a 200 response with a clean / 0-game / `lowConfidence: true` report (does not 404).

2. `GET /v1/moderation/anti-cheat/players/:playerId/games`
   - Returns array of `StoredPlayerReport` objects (`{ gameId, playerId, color, report }`) for the target player.
   - Records an audit log entry (`anti_cheat.games.view`).

### Deferred Pipeline

Automated background triggers, game-event listeners, and evaluation pipeline queues converting finished games to plies, calling the engine, and saving reports are deferred to Increment 6.

## Consequences

- **Atomic Analytical Storage:** Postgres persistence guarantees reliable storage for per-player engine-correlation reports with zero foreign-key cascading deletion risks.
- **Audit & Role Safety:** Moderation endpoints are strictly restricted to `moderator` and `admin` roles, and every access is recorded in the audit log.
- **Spec Integrity:** OpenAPI schema generation automatically captures both endpoints (`AntiCheatAggregateView` and `AntiCheatGameReportList`).
