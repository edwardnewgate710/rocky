# ADR-0054 — Search REST API (GET /v1/search)

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-24                      |
| **Scope**  | `@chess-platform/api` (M11)     |

---

## Context

Milestone 11 Increments 1–4 built `@chess-platform/search` (`parseSearchQuery`, `parseNaturalQuery`, the async `SearchRepository` port, `InMemorySearchRepository`, `SearchOptions`, and `SearchPage`).

To expose search capabilities to clients, `@chess-platform/api` requires a public HTTP search endpoint. This endpoint must parse natural-language search queries, execute queries against an injected `SearchRepository`, and return paginated search results according to an OpenAPI contract.

When no search index repository is configured, the endpoint must degrade gracefully rather than throwing uncaught errors or failing startup, mirroring the optional-dependency design pattern established by the anti-cheat moderation endpoints (`antiCheatAnalysis?`).

## Decision

1. **Package Dependency**:
   - Added `@chess-platform/search` dependency to `packages/api/package.json`.

2. **Optional Dependency Wiring**:
   - Added `readonly searchRepository?: SearchRepository;` to `ApiDependencies` and `RouteDeps`.
   - Threaded `deps.searchRepository` from `createApiServer` into `buildRouter`.

3. **HTTP Route (`GET /v1/search`)**:
   - Registered `GET /v1/search` with `PUBLIC` authorization policy.
   - Accepts query parameters:
     - `q` (required string): natural language or structured search query. Returns 422 if missing or blank.
     - `limit` (optional positive integer, default 20, max 100): parsed via `parseLimit`.
     - `offset` (optional non-negative integer, default 0): parsed via `parseSearchOffset`. Returns 422 if negative or non-integer.
   - 503 Guard: Throws `HttpError.unavailable('search is not configured')` when `deps.searchRepository` is absent, matching the anti-cheat 503 pattern.
   - Query Normalization: Passes `q` through `parseNaturalQuery` from `@chess-platform/search` to promote vocabulary words (e.g., `blitz`, `won`) to structured filters.
   - Executes `deps.searchRepository.query(query, { limit, offset })` and returns 200 JSON `{ total: page.total, results: page.results }`.

4. **OpenAPI Schemas**:
   - Added `SearchResult` schema (`{ id: string, score: number }`).
   - Added `SearchResults` schema (`{ total: integer, results: Array<SearchResult> }`).
   - Regenerated `packages/api/openapi.json`.

5. **Test Harness & Integration Tests**:
   - Extended `startHarness` in `packages/api/test/helpers.ts` to instantiate `InMemorySearchRepository` by default, controllable via `withoutSearch?: boolean`.
   - Added integration tests in `packages/api/test/search-api.test.ts` verifying document search, vocabulary filter promotion, limit/offset pagination, query validation errors (422), and 503 unconfigured responses.

## Consequences

- Public API clients can query the search index via `GET /v1/search`.
- Service deployments without search enabled respond cleanly with HTTP 503 Service Unavailable.
- Indexing entity projections and wiring `PgSearchRepository` in `bootstrap.ts` remain isolated follow-up increments.
