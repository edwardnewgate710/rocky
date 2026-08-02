# ADR-0070 — Achievements System (Domain, Postgres Persistence, REST API & Live Awarding)

| Field      | Value                                                                             |
|------------|-----------------------------------------------------------------------------------|
| **Status** | Accepted                                                                          |
| **Date**   | 2026-08-02                                                                        |
| **Scope**  | `@chess-platform/achievements`, `@chess-platform/persistence`, `@chess-platform/api`, `services/gateway` |

---

## Context

Milestone 10 ("Social & learning") increment 5 requires a comprehensive achievements system across the domain, Postgres persistence, REST API, and live awarding from finished game events.

Key architectural requirements:
1. Pure, dependency-free domain core (`@chess-platform/achievements`) defining definitions, progress, evaluation rules, ordering, and pagination.
2. 15 honest achievement definitions across categories (`games`, `wins`, `streaks`, `speed`, `tournaments`, `social`, `special`).
3. Single SQL statement idempotent atomic progress updates that prevent timestamp drift (`unlocked_at` set once when `progress >= target` is reached, never updated on subsequent increments).
4. Pure functional evaluator (`evaluateGameAchievements`) evaluating finished game summaries into domain award intents without side effects or clock reads.
5. Live awarding worker (`AchievementsAwardWorker`) subscribing to `games:ended` channel with FIFO dedup, in-flight tracking, and error containment.
6. Public REST API (`GET /v1/achievements`, `GET /v1/players/:playerId/achievements`, `GET /v1/players/:playerId/achievements/summary`).
7. Why global leaderboard endpoint `GET /v1/achievements/leaderboard` is deferred (unindexed dynamic points aggregation across all users is expensive under high write load; materialization or Redis caching deferred to a dedicated milestone).

---

## Decisions

### 1. Pure, Dependency-Free Domain Core (`@chess-platform/achievements`)

Created `@chess-platform/achievements` as a workspace package with zero runtime dependencies. It defines:
- `AchievementTier` (`bronze`, `silver`, `gold`), `AchievementDefinition`, `PlayerAchievement`, `PlayerAchievementView`, `AchievementSummary`.
- `AchievementRuleError` with code union (`unknown_achievement`, `invalid_progress`, `not_found`).
- Catalogue of 15 definitions exported in `ACHIEVEMENT_CATALOGUE`.
- Pure evaluator `evaluateGameAchievements(game, playerState)`.
- Code-point deterministic ordering (`comparePlayerAchievements`: `unlockedAt` DESC, then definition key ASC in code-point order).
- `AchievementsRepository` port with documented invariants and `InMemoryAchievementsRepository` implementation.

### 2. Single SQL Statement Atomic Idempotent Progress Update

In `PgAchievementsRepository`, progress updates run a single `INSERT ... ON CONFLICT DO UPDATE`:
```sql
INSERT INTO achievement_progress (player_id, achievement_key, progress, unlocked_at)
VALUES ($1, $2, LEAST($3::integer, $4::integer), CASE WHEN $4::integer >= $3::integer THEN $5::timestamptz ELSE NULL END)
ON CONFLICT (player_id, achievement_key) DO UPDATE SET
  progress = LEAST($3::integer, achievement_progress.progress + EXCLUDED.progress),
  unlocked_at = COALESCE(
    achievement_progress.unlocked_at,
    CASE WHEN (achievement_progress.progress + EXCLUDED.progress) >= $3::integer THEN $5::timestamptz ELSE NULL END
  )
RETURNING player_id, achievement_key, progress, unlocked_at
```
`COALESCE(achievement_progress.unlocked_at, ...)` guarantees that `unlocked_at` is preserved once set, avoiding read-then-write race conditions and locking overhead.

### 3. Hidden Achievements Rule

Achievements marked `hidden: true` are excluded from the public catalogue listing (`GET /v1/achievements`). For player achievements (`GET /v1/players/:playerId/achievements`), hidden achievements are omitted when unearned (`unlockedAt === null`) and included once unlocked (`unlockedAt !== null`), maintaining a uniform public view shape without leaking unearned secret achievements.

### 4. Live Awarding Worker (`AchievementsAwardWorker`)

Hosted in `services/gateway` behind `ACHIEVEMENTS_ENABLED=1` **plus** `DATABASE_URL`. Opt-in, matching
`SEARCH_INDEXER` and `BOT_AUTO_ANALYZE` rather than the `SEARCH_ENABLED` kill switch: a worker that
writes to the database on every finished game should start because an operator asked for it, not
because a commit landed. It also keeps the "requires DATABASE_URL" warning meaningful — defaulted on,
every gateway without a database would log it about a subsystem nobody requested.
- Subscribes to `games:ended` channel via pubsub.
- Maintains a FIFO `seen` set (`MAX_SEEN = 10_000`) and `inFlight` promise map for game deduplication.
- Ignores malformed event payloads defensively.
- Containment: errors during game fetching or awarding are reported via `onError` callback without throwing or stopping worker subscription.

### 5. Non-Goal: Global Achievements Leaderboard

`GET /v1/achievements/leaderboard` is intentionally omitted in this increment. Computing live leaderboard rankings across all users requires summing points per player across `achievement_progress`, which cannot use single-player index scanning and scales poorly with total registered users. Leaderboarding will be addressed in a future increment using a materialized view or Redis zset leaderboard.
