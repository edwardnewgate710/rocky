# ADR-0083 — Search UI

| Field      | Value               |
|------------|---------------------|
| **Status** | Accepted            |
| **Date**   | 2026-08-03          |
| **Scope**  | `packages/web`      |

---

## Context

Milestone 11 shipped a complete search backend supporting keyword, semantic (pgvector), and hybrid (RRF) search modes (`GET /v1/search`), but provided no user interface in `packages/web` to search the platform. Exposing this search backend in the web application requires addressing specific architectural constraints and data modeling gaps:

1. **Backend Payload Limitation**: The `GET /v1/search` contract returns only `{ total: number, results: { id: string; score: number }[] }` (`packages/api/src/openapi/schemas.ts` and `packages/search/src/search.ts`). There is no title, entity type field, or snippet returned in search results.
2. **Entity Type Resolution**: Entity types must be recovered purely from document ID namespace prefixes (`game:<uuid>`, `player:<uuid>`, `tournament:<uuid>`) defined in `packages/search/src/projections.ts`.
3. **Per-Result Hydration N+1**: Display metadata must be hydrated from existing PUBLIC endpoints (`client.tournaments.byId`, `client.games.byId`, and `client.graphql.resolvePlayers`).
4. **Router & SPA State**: Query parameters (`q`, `mode`) must be handled without widening `Route` in `packages/web/src/app/router.ts`, while providing full deep-linking and SPA back/forward navigation.

## Decision

### 1. Document ID Prefix Convention as Type Source

The search UI parses document IDs using `parseSearchHit` in `packages/web/src/app/search-results.ts`. Splitting on the **first** colon decomposes namespaced IDs (`game:<uuid>`, `player:<uuid>`, `tournament:<uuid>`) into an entity type and standard UUID. Unrecognized or un-prefixed IDs degrade gracefully to `type: null` rather than throwing errors.

### 2. Hydration Strategy & Backend Gap Acknowledgment

The search contract does not return display metadata, which represents a genuine backend gap. To respect contract purity without inventing new endpoints, `SearchController` in `packages/web/src/app/search-controller.ts` mitigates the N+1 hydration through three rules:
- **Page Size**: Queries default to `limit: 10`.
- **Parallel Entity Fetches**: `client.tournaments.byId(id)` and `client.games.byId(id)` are executed concurrently via `Promise.all`.
- **Single-Batch Player Resolution**: All player IDs across player search hits and game participant UUIDs (`whiteId` and `blackId`) are collected and resolved in a single `client.graphql.resolvePlayers(ids)` call.
- **Resilient Fallback**: A hydration failure on any single item falls back per-row to `shortId(id)` and plain text without failing the search page.

The mitigations bound the cost; they do not remove it. A search response that carried entity type, title and snippet in the hit itself would eliminate the secondary lookups outright, and that is the shape to reach for if search page latency becomes a problem. Changing the contract is deliberately out of scope here — it is a backend change with its own ADR. Tracked under "Known follow-ups (tracked)" in `docs/ROADMAP.md`.

### 3. Route Contract Preservation & Query String Isolation

The client-side router in `packages/web/src/app/router.ts` defines a single `{ name: 'search' }` route for `/search`. Query parameters (`q` and `mode`) are read directly from `location.search` using `URLSearchParams` in `packages/web/src/app/bootstrap.ts`. This keeps `Route` and `parseRoute` focused on pathnames without breaking existing contract tests.

### 4. SPA Navigation Path Reuse

Submitting the header search form or toggling a search mode control navigates via `history.pushState(null, '', url)` followed by `window.dispatchEvent(new PopStateEvent('popstate'))`. Reusing the single SPA navigation handler in `packages/web/src/main.ts` avoids full page reloads (`window.location.href`) and preserves back/forward history without introducing external routing libraries.

### 5. Accessibility & Keyboard Shortcuts

A search form with `role="search"` and a `<label class="sr-only">` is added to `<nav class="nav">` in `packages/web/index.html`. No global keyboard shortcut is registered, as the application lacks a global shortcut manager.

### 6. DOM & Style Rules

- **Standard List Row Treatment**: Results render into `.panel-list` using `.panel-row` elements in `packages/web/src/style.css`, matching `ADR-0082` design rules. Containers omit `role="list"`.
- **Design Tokens**: All layout spacing uses 4/8/12/16px steps, headings use 1.25rem weight 700, and border-radius is strictly 6px.
- **Link Affordance**: Rows with valid URLs render `<a class="tournament-link">`, while unresolvable rows render plain text.

### 7. What Is NOT Covered

- **DOM Unit Tests**: DOM rendering is verified through static markup assertions (`packages/web/test/a11y.test.ts`) and Playwright E2E tests (`packages/web/e2e/search.spec.ts`). Pure hit parsing and API client behavior are unit-tested in `packages/web/test/search-results.test.ts`, `packages/web/test/api-client.test.ts`, and `packages/web/test/tournament-routes.test.ts`.
- **Populated Index Verification (PARTLY OBSOLETE / SUPERSEDED by ADR-0086)**: Increment 19 closed the primary gap by wiring an `InMemorySearchRepository` into `packages/e2e-harness/src/harness.ts` and exposing `POST /e2e/search-index` to seed fixture documents. An E2E test in `packages/web/e2e/search.spec.ts` now asserts that a keyword search query returns a hit and renders the resolved handle via GraphQL hydration. Semantic (`mode=semantic`) and hybrid (`mode=hybrid`) search modes still respond 503 in E2E tests because no vector index is wired in the harness, and live production event indexing is not exercised by this test bridge.

## Consequences

- Search form added to header nav in `packages/web/index.html`.
- `GambitClient` in `packages/web/src/api/client.ts` exposes `SearchApi.query()`.
- `SearchController` in `packages/web/src/app/search-controller.ts` manages stale-response generation guards and parallel hydration.
- Verification passes via `npm run build`, `npm run lint`, `npm test`, and `npm run check:adr-claims`.
