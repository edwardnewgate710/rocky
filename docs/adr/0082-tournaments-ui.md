# ADR-0082 — Tournaments Read-Only UI

| Field      | Value               |
|------------|---------------------|
| **Status** | Accepted            |
| **Date**   | 2026-08-03          |
| **Scope**  | `packages/web`      |

---

## Context

Milestone 9 shipped a complete tournament engine supporting Swiss, Arena, and Round Robin formats, along with standings calculations and live board broadcast presenters (`packages/api/src/tournament/presenters.ts` and `packages/api/src/tournament/live-view.ts`). However, the web application (`packages/web`) provided no user interface to discover, view details of, or watch live games in active tournaments.

Exposing the tournament system read-only in the web frontend requires addressing key architectural and design decisions:
1. **Route Hierarchy**: Determining the route structure for tournament browsing and detail views.
2. **Real-time Broadcast Mechanism**: Choosing between WebSocket streaming and HTTP polling for live tournament boards and standings.
3. **Player Identity Resolution**: Resolving bare player UUIDs to human-readable handles without coupling to REST endpoint changes.
4. **Testing and Verification Scope**: Outlining testing boundaries across unit, a11y, and E2E suites.

## Decision

### 1. Two Routes (`/tournaments` and `/tournaments/:id`)

The UI introduces two routes defined in `packages/web/src/app/router.ts`:
- `{ name: 'tournaments' }` mapped to `/tournaments` for browsing tournament summaries.
- `{ name: 'tournament'; id: string }` mapped to `/tournaments/:id` for viewing a single tournament.

A third route (e.g. `/tournaments/:id/live`) was deliberately omitted. `GET /v1/tournaments/:id/live` returns both active games (`LiveBoard[]`) and standings in a single payload. On the frontend, standings and live games are displayed on the same tournament detail page. Creating a separate route would duplicate the view hierarchy against a different API endpoint.

### 2. HTTP Polling Over WebSocket Streaming

Live updates on running tournaments (`GET /v1/tournaments/:id/live`) are driven by periodic HTTP polling (default 5000ms interval) in `packages/web/src/app/tournament-controller.ts`.

The client WebSocket protocol (`packages/web/src/net/ws-protocol.ts`) contains zero tournament-specific message types (verified zero matches). Introducing WebSocket live streams for tournaments would require additions to gateway message schemas, room routing, and server-side state. HTTP polling achieves live board updates for read-only viewers with low complexity.

### 3. Name Resolution via GraphQL Batching with `shortId` Fallback

Tournament API responses return player references as 36-character UUID strings (`playerId`, `white`, `black`). Rendering raw UUIDs hurts legibility.

Player IDs appearing in standings and live game boards are collected and resolved in a single batch request via `client.graphql.resolvePlayers(ids)` (`packages/web/src/api/graphql.ts`). If the GraphQL read layer is disabled (`GRAPHQL_ENABLED=0`), `resolvePlayers` returns an empty map without error. Render helpers in `packages/web/src/app/tournament-view.ts` fall back per row to `shortId(id)` (`id.slice(0, 8)…`), ensuring page rendering is never blocked by read-layer deployment state.

### 4. DOM and Style Conventions

- **Standard Row Treatment**: List items reuse the `.panel-row` class inside `.panel-list` in `packages/web/src/style.css`, matching the DESIGN.md requirement for unified list UI across the app.
- **Shared Render Helpers**: Shared DOM helpers (`renderEmpty`, `formatClock`, `formatTimeControl`) reside in `packages/web/src/app/render-helpers.ts` to prevent circular dependencies between `bootstrap.ts` and `tournament-view.ts`, while re-exported from `packages/web/src/app/bootstrap.ts`.
- **Keyboard & Link Operability**: Tournament list rows link to `/tournaments/:id` and live game rows link to `/game/:gameId` using standard `<a href="...">` elements for keyboard and middle-click accessibility.
- **Format-Specific Standing Rendering**: Standings render columns strictly matching the discriminated format (`ArenaStanding` vs `SwissOrRoundRobinStanding`), avoiding `undefined` output for missing fields.

### 5. What Is NOT Covered

- **Write Operations**: Creating, joining, leaving, or administering tournaments is out of scope for this increment.
- **DOM Unit Tests**: In alignment with `packages/web` testing patterns (e.g. `ADR-0081`), DOM rendering is verified through static markup accessibility assertions (`packages/web/test/a11y.test.ts`) and Playwright E2E coverage (`packages/web/e2e/tournaments.spec.ts`). Pure router logic and API client methods are unit-tested in `packages/web/test/tournament-routes.test.ts` and `packages/web/test/api-client.test.ts`.
- **Seeded Tournament Verification**: The E2E test harness does not seed active tournaments; E2E tests assert that the page cleanly renders either populated lists or empty states.

## Consequences

- Navigation bar in `packages/web/index.html` includes a "Tournaments" link.
- `GambitClient` in `packages/web/src/api/client.ts` exposes `TournamentsApi` (`list`, `byId`, `standings`, `live`).
- `TournamentController` in `packages/web/src/app/tournament-controller.ts` manages fetch lifecycle, stale-response guards via `requestGeneration`, and live polling.
- Clean verification via `npm run build`, `npm run lint`, `npm test`, and `npm run check:adr-claims`.
