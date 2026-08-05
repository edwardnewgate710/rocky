# ADR-0083 — Search UI

| Field      | Value               |
|------------|---------------------|
| **Status** | Accepted            |
| **Date**   | 2026-08-03          |
| **Scope**  | `packages/web`      |

---

> **Amended 2026-08-05 by ADR-0094.** The backend gap this ADR works around is closed: search hits
> now carry their own `display` metadata, so the per-result hydration described in §2 is gone and the
> `.tournament-link` primitive named in §6 is now `.row-link`. The sections below are labelled where
> they no longer describe the code. Read ADR-0094 for the current contract; this ADR remains the
> record of why the UI was first built the way it was.

## Context

Milestone 11 shipped a complete search backend supporting keyword, semantic (pgvector), and hybrid (RRF) search modes (`GET /v1/search`), but provided no user interface in `packages/web` to search the platform. Exposing this search backend in the web application requires addressing specific architectural constraints and data modeling gaps:

1. **Backend Payload Limitation (RESOLVED by ADR-0094)**: At the time of this ADR the `GET /v1/search` contract returned only `{ total: number, results: { id: string; score: number }[] }` (`packages/api/src/openapi/schemas.ts` and `packages/search/src/search.ts`) — no title, entity type field, or snippet. ADR-0094 added an optional `display` block (`type`, `title`, `subtitle`) to each hit, which is what removed the hydration below.
2. **Entity Type Resolution**: Entity types must be recovered purely from document ID namespace prefixes (`game:<uuid>`, `player:<uuid>`, `tournament:<uuid>`) defined in `packages/search/src/projections.ts`.
3. **Per-Result Hydration N+1 (RESOLVED by ADR-0094)**: Display metadata had to be hydrated from existing PUBLIC endpoints (`client.tournaments.byId`, `client.games.byId`, and `client.graphql.resolvePlayers`), because the hit carried none. It now arrives on the hit and these calls are gone.
4. **Router & SPA State**: Query parameters (`q`, `mode`) must be handled without widening `Route` in `packages/web/src/app/router.ts`, while providing full deep-linking and SPA back/forward navigation.

## Decision

### 1. Document ID Prefix Convention as Type Source

The search UI parses document IDs using `parseSearchHit` in `packages/web/src/app/search-results.ts`. Splitting on the **first** colon decomposes namespaced IDs (`game:<uuid>`, `player:<uuid>`, `tournament:<uuid>`) into an entity type and standard UUID. Unrecognized or un-prefixed IDs degrade gracefully to `type: null` rather than throwing errors.

### 2. Hydration Strategy & Backend Gap Acknowledgment (SUPERSEDED by ADR-0094)

**This section no longer describes the code.** ADR-0094 changed the contract, and `SearchController` now maps each hit straight to a row with no secondary lookups at all. What follows is the original decision, kept because it records the reasoning that made the contract change worth doing.

At the time, the search contract did not return display metadata, which represented a genuine backend gap. To respect contract purity without inventing new endpoints, `SearchController` in `packages/web/src/app/search-controller.ts` mitigated the N+1 hydration through three rules:
- **Page Size**: Queries default to `limit: 10`.
- **Parallel Entity Fetches**: `client.tournaments.byId(id)` and `client.games.byId(id)` are executed concurrently via `Promise.all`.
- **Single-Batch Player Resolution**: All player IDs across player search hits and game participant UUIDs (`whiteId` and `blackId`) are collected and resolved in a single `client.graphql.resolvePlayers(ids)` call.
- **Resilient Fallback**: A hydration failure on any single item falls back per-row to `shortId(id)` and plain text without failing the search page.

The mitigations bound the cost; they do not remove it. A search response that carried entity type, title and snippet in the hit itself would eliminate the secondary lookups outright, and that is the shape to reach for if search page latency becomes a problem. Changing the contract is deliberately out of scope here — it is a backend change with its own ADR. Tracked under "Known follow-ups (tracked)" in `docs/ROADMAP.md`.

**That follow-up was taken up in Increment 27 (ADR-0094):** the hit now carries `display`, the three fetch rules above are deleted, and a search page render costs exactly one request.

### 3. Route Contract Preservation & Query String Isolation

The client-side router in `packages/web/src/app/router.ts` defines a single `{ name: 'search' }` route for `/search`. Query parameters (`q` and `mode`) are read directly from `location.search` using `URLSearchParams` in `packages/web/src/app/bootstrap.ts`. This keeps `Route` and `parseRoute` focused on pathnames without breaking existing contract tests.

### 4. SPA Navigation Path Reuse

Submitting the header search form or toggling a search mode control navigates via `history.pushState(null, '', url)` followed by `window.dispatchEvent(new PopStateEvent('popstate'))`. Reusing the single SPA navigation handler in `packages/web/src/main.ts` avoids full page reloads (`window.location.href`) and preserves back/forward history without introducing external routing libraries.

### 5. Accessibility & Keyboard Shortcuts

A search form with `role="search"` and a `<label class="sr-only">` is added to `<nav class="nav">` in `packages/web/index.html`. No global keyboard shortcut is registered, as the application lacks a global shortcut manager.

### 6. DOM & Style Rules

- **Standard List Row Treatment**: Results render into `.panel-list` using `.panel-row` elements in `packages/web/src/style.css`, matching `ADR-0082` design rules. Containers omit `role="list"`.
- **Design Tokens**: All layout spacing uses 4/8/12/16px steps, headings use 1.25rem weight 700, and border-radius is strictly 6px.
- **Link Affordance**: Rows with valid URLs render an `<a>` carrying the shared row-link primitive, while unresolvable rows render plain text. That class was `.tournament-link` when this ADR was written; ADR-0094 renamed it to `.row-link`, since by then six non-tournament surfaces were using it.

### 7. What Is NOT Covered

- **DOM Unit Tests**: DOM rendering is verified through static markup assertions (`packages/web/test/a11y.test.ts`) and Playwright E2E tests (`packages/web/e2e/search.spec.ts`). Pure hit parsing and API client behavior are unit-tested in `packages/web/test/search-results.test.ts`, `packages/web/test/api-client.test.ts`, and `packages/web/test/tournament-routes.test.ts`.
- **Populated Index Verification (PARTLY OBSOLETE / SUPERSEDED by ADR-0086)**: Increment 19 closed the primary gap by wiring an `InMemorySearchRepository` into `packages/e2e-harness/src/harness.ts` and exposing `POST /e2e/search-index` to seed fixture documents. An E2E test in `packages/web/e2e/search.spec.ts` now asserts that a keyword search query returns a hit and renders its handle — via GraphQL hydration when written, from the hit's own `display.title` since ADR-0094. Semantic (`mode=semantic`) and hybrid (`mode=hybrid`) search modes still respond 503 in E2E tests because no vector index is wired in the harness, and live production event indexing is not exercised by this test bridge.

## Consequences

- Search form added to header nav in `packages/web/index.html`.
- `GambitClient` in `packages/web/src/api/client.ts` exposes `SearchApi.query()`.
- `SearchController` in `packages/web/src/app/search-controller.ts` manages stale-response generation guards and, until ADR-0094 removed it, parallel hydration.
- Verification passes via `npm run build`, `npm run lint`, `npm test`, and `npm run check:adr-claims`.
