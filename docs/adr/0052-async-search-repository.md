# ADR-0052 — Async SearchRepository Port

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/search` (M11)  |

---

## Context

Milestone 11 Increment 2 (ADR-0050) introduced the `SearchRepository` port and `InMemorySearchRepository` adapter within `@chess-platform/search` with synchronous method signatures (`index`, `indexAll`, `remove`, `clear`, `size`, `query`).

Upcoming Milestone 11 increments will add a Postgres full-text search adapter (`PgSearchRepository`) and a pgvector semantic search adapter. Database adapters require asynchronous I/O (`await pool.query(...)`) and cannot implement a synchronous interface contract. Throughout the Gambit codebase, all repository ports (e.g. `AntiCheatReportRepository`, `TournamentsRepository`, `SeeksRepository`) are async for this reason.

Because no consumers outside `@chess-platform/search` have integrated `SearchRepository` yet, updating the port signature to return Promises is a safe, contained refactoring.

## Decision

Change all methods in `SearchRepository` to return Promises:

1. **`SearchRepository` Port Signatures**:
   - `index(document: SearchableDocument): Promise<void>`
   - `indexAll(documents: readonly SearchableDocument[]): Promise<void>`
   - `remove(id: string): Promise<boolean>`
   - `clear(): Promise<void>`
   - `size(): Promise<number>`
   - `query(query: SearchQuery, options?: SearchOptions): Promise<SearchPage>`

2. **Adapter & Data Contract Stability**:
   - `InMemorySearchRepository` methods are marked `async`, returning resolved Promises with unchanged internal logic (Map-backed operations, `search` ranking, and pagination slicing).
   - Data contracts `SearchOptions` and `SearchPage` remain unchanged.

## Consequences

- Infrastructure search repository adapters backed by external databases (Postgres full-text tsvector/pg_trgm, pgvector semantic search) can implement `SearchRepository`.
- `InMemorySearchRepository` continues to serve as a zero-dependency, pure-memory reference implementation for unit testing, satisfying the async contract with trivially-resolved Promises.
- Maintained consistency with repository port conventions across all monorepo packages.
