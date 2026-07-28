# ADR-0056 — Live Incremental Game Search Indexing

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-28                                                       |
| **Scope**  | `@chess-platform/api`, `@chess-platform/persistence`, `services/gateway` (M11) |

---

## Context

Milestone 11 Increment 7 delivered entity search projections, a keyset backfill source (`SearchBackfillSource`), and the `reindex-search` CLI script. However, the search index was static and only updated when an operator manually executed `npm run reindex-search`. Newly finished games were not indexed automatically, causing `GET /v1/search` to become stale over time.

## Decision

1. **Single-Game Read Path (`packages/persistence/src/search-backfill.ts`)**:
   - Added `findGame(id: string): Promise<GameDocumentInput | null>` to `SearchBackfillSource`.
   - Implemented in `PgSearchBackfillSource` (`packages/persistence/src/pg/search-backfill.ts`) using bound parameters (`WHERE g.id = $1::uuid`) and reusing the existing `users` JOIN + column selection from `listGames`.

2. **Package Boundary & Local Structural Subscriber Port (`packages/api/src/search/index-worker.ts`)**:
   - Guardrail 5 prohibits `@chess-platform/api` from depending on `@chess-platform/realtime-gateway`.
   - Instead of importing `PubSub` or `gamesEndedChannel` from `realtime-gateway`, `SearchIndexWorker` consumes a local structural `SearchIndexSubscriber` port:
     ```ts
     export interface SearchIndexSubscriber {
       subscribe(channel: string, handler: (msg: unknown) => void): () => void;
     }
     ```
   - At composition time in `services/gateway/src/serve.ts`, `PubSub` and `gamesEndedChannel()` satisfy this port without introducing an `api` -> `realtime-gateway` package edge.

3. **Live Worker Architecture (`SearchIndexWorker`)**:
   - **Type Guard**: Defensive payload validation (`isGameEndedMessage`) for event messages crossing process boundaries without `as any`.
   - **FIFO Bounded Dedup Set**: Maintains a `seen` Set capped at `MAX_SEEN = 10_000` with FIFO eviction (Set insertion order).
   - **Error Containment**: Indexing failures log cleanly and remove `gameId` from `seen` to allow subsequent event retries. Throwing `onError` callbacks are contained and do not crash the worker or surface unhandled promise rejections.
   - **Dedup Slot Released On Every Non-Indexing Path**: `seen` is also cleared when the game is *not indexed* — see item 4. The dedup set exists to suppress duplicate **work**, never to record a permanent decision.
   - **Deterministic Test Seam**: Includes `await worker.drain()` hook tracking in-flight indexing promises.

4. **Aborted / Not-Yet-Visible Game Handling**:
   - A game is not indexed when `findGame` returns `null`, or when it returns `result: '*'`.
   - **Rationale**: search results are intended for completed games (`1-0`, `0-1`, `1/2-1/2`), so an aborted game must not enter the index.
   - **Critical subtlety — the two cases are indistinguishable here.** The `ended` broadcast is published by the gateway's `GameAuthority`, while the `games` projection row (with `result`) is written by a *different* process. When the broadcast wins that race, `findGame` returns `COALESCE(result, '*') = '*'` for a game that is genuinely finished.
   - Therefore the worker **removes the id from `seen` on both non-indexing paths**. Retaining it would make a transient projection lag permanent: the game would stay absent from the index until an operator reran `reindex-search`. Releasing the slot costs at most one cheap re-read on a redelivery, and still leaves genuinely aborted games unindexed.
   - Regression tests cover both orderings (`index-worker-race.test.ts`).

5. **Gateway Hosting (`services/gateway/src/serve.ts`)**:
   - Gated on environment variable `SEARCH_INDEXER=1` (off by default).
   - Unconditionally suppressed when `SEARCH_ENABLED=0`.
   - Integrated into the graceful shutdown lifecycle (`searchIndexWorker.stop()`).
   - **Operational constraint — set `SEARCH_INDEXER=1` on exactly ONE replica.** Dedup is process-local, so every replica with the flag set subscribes to `gamesEndedChannel()` and indexes every finished game. Because indexing is an idempotent upsert this is *wasteful, not corrupting* (one extra read + write per game per extra replica), but the Helm chart defaults to `gateway.replicas: 2`, so the flag must not be applied fleet-wide unguarded. This matches the existing constraint on `TOURNAMENT_REPORTER` (ADR-0025), whose dedicated single-replica Deployment is tracked as technical debt; distributed leadership should be solved once for all four gateway-hosted workers (`TOURNAMENT_REPORTER`, `BOT_AUTO_ANALYZE`, `ANTICHEAT_AUTO_ANALYZE`, `SEARCH_INDEXER`) rather than per worker.

6. **Scope Deferrals**:
   - Live indexing for players and tournaments (no current event channel) and player-scoped authenticated search ("games I won") remain deferred to Increment 9.
   - Distributed leadership / consumer-group coordination for gateway-hosted workers is deferred and tracked as technical debt (see item 5).

## Consequences

- Finished games are indexed in real-time upon `gamesEndedChannel()` broadcast when `SEARCH_INDEXER=1`.
- `@chess-platform/api` maintains zero dependencies on `@chess-platform/realtime-gateway`.
- `SearchIndexWorker` is verified idempotent, bounded in memory, and resilient to errors.
- A game whose projection row lags the `ended` broadcast is still indexed on redelivery instead of being silently dropped until the next manual reindex.
- Unset `SEARCH_INDEXER` or `SEARCH_ENABLED=0` keeps the worker disabled safely.
- Enabling `SEARCH_INDEXER` on more than one replica multiplies indexing reads/writes per game without changing the resulting index.
