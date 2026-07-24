# ADR-0040 — Bot Detection Persistence and Moderation REST API

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-24                                                       |
| **Scope**  | `@chess-platform/persistence`, `@chess-platform/api` (M12)       |

---

## Context

Increments 1–4 defined the pure domain move-time behavioral bot analyzer (`analyzeBotBehavior`), account-level pooling aggregator (`aggregateBotBehavior`), move-timing extractor (`extractTimedMoves`), and `BotDetectionService`/`BotBehaviorReportRepository` ports. Persistence in Postgres and moderator-gated REST API endpoints (read and on-demand analyze) were deferred to Increment 5.

Unlike engine-correlation anti-cheat analysis (which requires Stockfish evaluation), move-time behavioral bot detection is engine-free — it analyzes move timing distributions (`moveTimeMs`) directly from game events without requiring external engine processes or evaluator configuration.

## Decision

We implement Postgres-backed storage for behavioral bot detection reports and add read + on-demand analyze moderation endpoints to the REST API.

### Table Schema & Primary Key Rationale

We add migration `0011_bot_reports.sql` creating table `bot_reports`:

```sql
CREATE TABLE bot_reports (
  player_id  UUID        NOT NULL,
  game_id    UUID        NOT NULL,
  color      TEXT        NOT NULL CHECK (color IN ('white', 'black')),
  report     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);

CREATE INDEX bot_reports_player_created_idx
  ON bot_reports (player_id, created_at);
```

- **No Foreign Keys:** Opaque identifiers (`player_id`, `game_id`) allow analytical reports to survive independently of user/game table mutations or deletions.
- **Index Optimization:** The `(player_id, created_at)` index accelerates `listByPlayer` queries that filter by `player_id` and order by `created_at ASC`.

### Atomic Batch Upsert

`PgBotBehaviorReportRepository` implements `BotBehaviorReportRepository`:

- `saveBatch(records)` connects to the pool and executes within an explicit SQL transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`). Reports for both players are written atomically.
- Records use `ON CONFLICT (player_id, game_id) DO UPDATE SET color = EXCLUDED.color, report = EXCLUDED.report, updated_at = now()`. Re-analyzing a game replaces existing records without duplicates.

### Moderation REST API

We add three endpoints to `@chess-platform/api`, gated by policy `MODERATION` (`moderator` or `admin` role required) and audited:

1. `GET /v1/moderation/bot-detection/players/:playerId`
   - Audits access (`bot_detection.aggregate.view`) BEFORE reading.
   - Fetches stored per-game reports for `:playerId` via `repos.botReports.listByPlayer`.
   - Computes account-level aggregate via `BotDetectionService.aggregatePlayer`.
   - Returns `BotAggregateView` (200). Unanalyzed players return 200 with clean/0-game/`lowConfidence: true`.

2. `GET /v1/moderation/bot-detection/players/:playerId/games`
   - Audits access (`bot_detection.games.view`) BEFORE reading.
   - Supports `?limit=` query parameter.
   - Returns list of `BotGameReportView` (200).

3. `POST /v1/moderation/bot-detection/games/:gameId/analyze`
   - Audits access (`bot_detection.analyze`) BEFORE reading/analyzing.
   - Requires `deps.botTimingSource` (`EventStoreBotTimingSource`). If unconfigured, throws `HttpError.unavailable` (503).
   - Loads finished game timing details via `botTimingSource.load(gameId)`. Throws `HttpError.notFound` (404) if game does not exist or is not finished.
   - Invokes `BotDetectionService.analyzeAndStore({ gameId, players: { white, black }, moves })` to analyze and persist per-player reports.
   - Returns `BotGameAnalysisView` (200) containing `{ white, black }` reports.
   - **Engine-Free Unconditional Availability:** Unlike engine-correlation analysis, bot detection requires no engine or evaluator, so the endpoint is unconditionally available when the timing source is configured.

### Deferred Pipeline

Automatic triggering (auto-analyzing finished games via PubSub / background worker) is deferred to a later increment.

## Consequences

- **Engine-Free Bot Detection API:** Full read and on-demand analyze API for move-time bot detection, stored durably in Postgres.
- **Idempotent Atomic Storage:** Repositories prevent duplicate records and preserve aggregation integrity across re-analysis.
- **Audit & Security:** Every access and analyze attempt is audited prior to execution; non-moderators receive 403.
