# ADR-0050 — SearchRepository Port & In-Memory Paginated Adapter

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/search` (M11)  |

---

## Context

Milestone 11 Increment 1 (ADR-0049) established the pure `@chess-platform/search` domain package with a stateless `search(query, documents)` function over a caller-supplied document array.

To integrate search across domain services (games, openings, players, studies), the platform requires a stateful repository abstraction (`SearchRepository`) for document indexing, deletion, and paginated query evaluation. Infrastructure implementations like Postgres full-text search and pgvector semantic search will fulfill this interface in future increments. To maintain purity and zero external dependencies, an in-memory adapter is needed now.

## Decision

Define the stateful `SearchRepository` port and `InMemorySearchRepository` adapter within `@chess-platform/search`:

1. **`SearchOptions` & `SearchPage` Data Contracts**:
   - `SearchOptions`: optional pagination parameters `limit` (max page size) and `offset` (leading hits to skip). Negative values clamp to `0`. Omitted `limit` returns all matching hits.
   - `SearchPage`: `{ total: number, results: readonly SearchResult[] }`, where `total` is the hit count matching the query across the entire index prior to pagination, and `results` is the sliced page of ranked results.

2. **`SearchRepository` Port**:
   - `index(document: SearchableDocument): void`: Inserts or replaces a document by `id` (upsert semantics).
   - `indexAll(documents: readonly SearchableDocument[]): void`: Upserts a list of documents.
   - `remove(id: string): boolean`: Removes a document by `id`, returning `true` if it existed and was removed.
   - `clear(): void`: Removes all indexed documents.
   - `size(): number`: Returns the total count of currently indexed documents.
   - `query(query: SearchQuery, options?: SearchOptions): SearchPage`: Evaluates a `SearchQuery` against the index and returns the requested paginated page along with total hits.

3. **`InMemorySearchRepository` Adapter**:
   - Holds an in-memory `Map<string, SearchableDocument>` keyed by `document.id`.
   - Delegates query evaluation to Increment 1's `search(query, Array.from(this.docs.values()))`.
   - Slices the full ranked result set using deterministic start (`Math.max(0, offset ?? 0)`) and end (`limit === undefined ? allHits.length : start + Math.max(0, limit)`) bounds.
   - Preserves deterministic ranking (score DESC, `id` ASC) and immutability (never mutates index state or query inputs).

## Consequences

- Domain and application services can depend strictly on the dependency-free `SearchRepository` interface for document indexing and paginated searching.
- The `InMemorySearchRepository` provides a fast, zero-dependency, pure-memory reference implementation for unit testing and local operation.
- **Search Roadmap**: Postgres full-text search (pg_trgm / tsvector) and pgvector semantic embeddings adapters implementing `SearchRepository` are explicitly deferred to later Milestone 11 increments.
