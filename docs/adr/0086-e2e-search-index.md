# ADR-0086 — E2E Search Index Wiring & Hit Assertion

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-08-04                      |
| **Scope**  | `packages/e2e-harness`, `packages/web` |

---

## Context

Increment 16 shipped the Search UI (`packages/web/e2e/search.spec.ts`). However, as documented in ADR-0083 §7:
"**No test asserts that a query returns hits**, because nothing in the test environment can produce one. Closing that gap requires dedicated test infrastructure — indexing fixture documents through the `e2e-harness`, or seeding the search tables directly — not another spec."

Under `GAMBIT_E2E_BACKEND=1`, `ApiDependencies.searchRepository` was absent in `packages/e2e-harness/src/harness.ts`, so any search query `GET /v1/search` returned HTTP **503**. To allow E2E tests to exercise search queries end-to-end (query → hit → GraphQL player hydration → DOM render), the harness must provide an in-memory search index and a mechanism for test specs to populate fixture documents into that index.

## Decision

### 1. Harness Search Repository Composition (`packages/e2e-harness`)

`packages/e2e-harness/src/harness.ts` now instantiates `InMemorySearchRepository` (exported from `@chess-platform/search`) and wires it as `deps.searchRepository`. Because `InMemorySearchRepository` operates in-memory without Postgres or pgvector, it aligns with the harness's zero-infrastructure design.

`@chess-platform/search` is added as a workspace dependency (`file:../search`) in `packages/e2e-harness/package.json`.

### 2. Optional Dependency Pattern in `ApiDependencies`

`ApiDependencies` (`packages/api/src/deps.ts`) defines eight optional repository fields. When any of these optional dependencies is absent, its corresponding routes respond HTTP 503:
- Composed in `e2e-harness`: `messagingRepository`, `socialGraphRepository`, `graphql`, and now `searchRepository`.
- Still absent in `e2e-harness`: `semanticSearchRepository`, `communityRepository`, `achievementsRepository`, `studiesRepository`, and `learningRepository`.

These five remain absent because no current E2E test or UI workflow consumes them under `GAMBIT_E2E_BACKEND=1`. The next UI increment introducing features for each domain will wire its respective repository into the harness.

### 3. Test-Only Bridge Route (`POST /e2e/search-index`)

Rather than faking production indexing (which would require complex event listeners or polling loops), the harness exposes a dedicated test-only bridge route, `POST /e2e/search-index`, namespaced under `/e2e/` alongside `POST /e2e/games`.

It accepts a batch payload:
`{ players?: PlayerDocumentInput[], games?: GameDocumentInput[], tournaments?: TournamentDocumentInput[] }`

Documents are constructed using the official projection functions from `@chess-platform/search`:
- `playerToDocument(input: PlayerDocumentInput)`
- `gameToDocument(input: GameDocumentInput)`
- `tournamentToDocument(input: TournamentDocumentInput)`

Using real domain projections ensures that E2E test documents match the exact field structures produced in production indexing. The handler validates input arrays, projects each entity, calls `searchRepository.indexAll(...)`, and returns HTTP `201` with `{ indexed: number }`. Invalid or empty payloads return HTTP `400` using the standard error envelope `{ code: 'bad_request', message: '...' }`.

### 4. End-to-End Hit and Hydration Assertion (`packages/web/e2e/search.spec.ts`)

A new E2E test in `packages/web/e2e/search.spec.ts` verifies the complete search and rendering pipeline:
1. Registers a user via `POST /v1/auth/register` so a real user ID and handle exist in the API database.
2. Seeds the search index with that player via `POST /e2e/search-index`.
3. Navigates to `/search?q=<handle>`.
4. Asserts that a result row appears in `#search-results` carrying the resolved **handle** (not a `shortId` fallback).

Asserting on the resolved handle verifies not only that search returned a hit, but that the frontend's single-batch GraphQL `resolvePlayers` hydration successfully resolved the document ID (`player:<uuid>`) to a user handle and rendered it.

### 5. What Is NOT Covered

- **Semantic and Hybrid Search Modes**: `semanticSearchRepository` and `embeddingProvider` remain absent in the harness, so `mode=semantic` and `mode=hybrid` continue to return 503 in E2E tests.
- **Production Event-Driven Indexer**: `POST /e2e/search-index` seeds the in-memory repository directly; it does not test background event consumers or database trigger projections.

## Consequences

- Added `@chess-platform/search` dependency to `packages/e2e-harness/package.json`.
- Wired `InMemorySearchRepository` and implemented `POST /e2e/search-index` bridge route in `packages/e2e-harness/src/harness.ts`.
- Added end-to-end search hit assertion test in `packages/web/e2e/search.spec.ts`.
- Updated `docs/adr/0083-search-ui.md`, `docs/ROADMAP.md`, and `docs/PROJECT_STATE.md`.
