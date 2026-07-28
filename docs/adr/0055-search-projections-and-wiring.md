# ADR-0055 — Search Projections, Backfill, Production Wiring & Vocabulary Realignment

| Field      | Value                                                            |
|------------|------------------------------------------------------------------|
| **Status** | Accepted                                                         |
| **Date**   | 2026-07-28                                                       |
| **Scope**  | `@chess-platform/search`, `@chess-platform/persistence`, `@chess-platform/api` (M11) |

---

## Context

Milestone 11 Increments 1–6 built `@chess-platform/search`, `PgSearchRepository`, `search_documents` DB table, and `GET /v1/search` endpoint. However:

1. `createPgDependencies` in `packages/api/src/bootstrap.ts` never instantiated `PgSearchRepository`, causing `deps.searchRepository` to remain `undefined` in production deployments and `GET /v1/search` to respond with 503 Service Unavailable.
2. No projection mappers existed to translate game, player, and tournament entities into `SearchableDocument` records.
3. No mechanism existed to page and backfill stored entities from PostgreSQL into `search_documents`.
4. Initial natural vocabulary mapped speed terms (`blitz`, `rapid`, `bullet`) to `field: 'variant'`, causing search filter mismatches against real game documents where speed and variant are distinct (`variant: 'standard'`, `speed: 'blitz'`).
5. Player-relative terms (`won`, `lost`, `white`, `black`) were mapped to filters (`result: 'win'`, `color: 'white'`) that could never match objective game documents (`result: '1-0'`, `'0-1'`, `'1/2-1/2'`).

## Decision

1. **Entity Projections (`packages/search/src/projections.ts`)**:
   - Added `gameToDocument`, `playerToDocument`, and `tournamentToDocument` in `@chess-platform/search` without adding external runtime dependencies.
   - Defined minimal local structural input interfaces (`GameDocumentInput`, `PlayerDocumentInput`, `TournamentDocumentInput`).
   - Used namespaced primary key IDs (`game:<id>`, `player:<id>`, `tournament:<id>`) to share a single index without ID collisions.
   - Every document carries a canonicalized `type` field (`game` | `player` | `tournament`).
   - `gameToDocument` includes player-identifying fields (`white`, `black`, and `winner` for finished games, or `winner: 'draw'` for draws), enabling explicit queries like `white:magnus` or `winner:hikaru`.

2. **Natural Vocabulary Realignment & Player-Relative Query Deferral (`packages/search/src/natural.ts`)**:
   - **Speed buckets**: `bullet`, `ultrabullet`, `blitz`, `rapid`, `classical`, `correspondence` map to `field: 'speed'`.
   - **Variants**: `standard`, `chess960` (`960`), `kingofthehill` (`koth`), `atomic`, `crazyhouse`, `threecheck`, `horde`, `racingkings` map to `field: 'variant'`. `antichess` is removed (absent from database variant enum).
   - **Entity Types**: `game`/`games`/`match`/`matches` map to `field: 'type', value: 'game'`. `player`/`players`/`user`/`users` map to `field: 'type', value: 'player'`. `tournament`/`tournaments` map to `field: 'type', value: 'tournament'`.
   - **Objective Results**: `draw`/`draws`/`drew`/`drawn`/`tie`/`tied` map to `field: 'result', value: '1/2-1/2'`.
   - **Removal of Player-Relative Terms**: Removed `won`/`win`/`wins`/`winning`, `loss`/`lost`/`losses`/`lose`, and `white`/`black` from `NATURAL_VOCABULARY`.
   - **Increment 8 Deferral**: Resolving player-relative queries ("games I won") requires user context to resolve side-to-move, which belongs in Increment 8 (authenticated user-scoped search mode). Unauthenticated natural search degrades gracefully by ignoring relative words so `"blitz games I won"` evaluates to `speed:blitz` + `type:game`.

3. **Security & PII Protection**:
   - `GET /v1/search` is an unauthenticated public route.
   - Player projections strictly index public fields (`handle` and optional `country`).
   - `email`, `email_hash`, and `flags` are explicitly excluded from player search documents. Verified via automated regression test.

4. **Dedicated Backfill Read-Path Port (`SearchBackfillSource`)**:
   - Declared `SearchBackfillSource` in `packages/persistence/src/search-backfill.ts` rather than widening existing repository interfaces (`GamesRepository`, `UsersRepository`, `TournamentsRepository`).
   - Implemented `PgSearchBackfillSource` in `packages/persistence/src/pg/search-backfill.ts` using **keyset (cursor) pagination** (`WHERE id > $1 ORDER BY id ASC LIMIT $2`).
   - All parameters use bound SQL parameters ($1, $2, ...) and inputs are sanitized/bounded to prevent invalid or infinite `LIMIT` values.
   - JOINed `users` on `games.white_id` and `games.black_id` to resolve player handles.

5. **Absolute Operator Kill Switch (`packages/api/src/bootstrap.ts`)**:
   - Wired `PgSearchRepository(pool)` inside `createPgDependencies`.
   - Hardened `SEARCH_ENABLED=0` to act as an **absolute kill switch**: when `SEARCH_ENABLED=0`, `deps.searchRepository` is set to `undefined` unconditionally (overriding any injected repository), degrading `GET /v1/search` to HTTP 503.

6. **Reindex Core Helper & CLI (`packages/api/src/search/reindex.ts`)**:
   - Extracted pure reindexing loop into `reindexAll(source, repo, batchSize)`.
   - Verified idempotency and pagination via unit tests running `reindexAll` twice against in-memory fakes.
   - Reduced `packages/api/src/scripts/reindex-search.ts` CLI script to a thin wrapper executing `reindexAll`.

7. **End-to-End Round-Trip Testing (`packages/search/test/search-roundtrip.test.ts`)**:
   - Created dedicated round-trip test indexing projected documents into `InMemorySearchRepository` and executing `parseNaturalQuery`.

## Consequences

- `GET /v1/search` queries like `"blitz games"` match real projected game documents (`speed: 'blitz'`, `type: 'game'`).
- `SEARCH_ENABLED=0` unconditionally disables search and surfaces HTTP 503.
- `reindexAll` is verified idempotent across multiple runs.
- Player-relative search queries are formally deferred to Increment 8 (authenticated search mode).
- Player search documents contain zero PII.
