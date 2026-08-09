# ADR-0107 — SPA Leaderboard Page

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-09                                                         |
| **Scope**  | `packages/web` (`router.ts`, `bootstrap.ts`, `lifecycle.ts`, `leaderboard-controller.ts`, `leaderboard-view.ts`, `index.html`, `style.css`) |

---

## Context

The backend REST endpoint `/v1/leaderboard/:variant` and the typed API client `GambitClient.leaderboard(variant, { limit })` were already implemented and tested in previous increments, but were not exposed as an accessible SPA page in the web frontend.

To complete feature parity for rating standings across supported chess variants, the frontend required a dedicated `/leaderboard` route and accessible section adhering to Gambit's Operate-mode design system.

## Decisions

### 1. Existing REST Endpoint & Bounded Fetching

- Reuses the existing REST API `GET /v1/leaderboard/:variant` and `GambitClient.leaderboard(variant, { limit })`.
- Fetches at most 100 entries per request.

### 2. Optional Handle Resolution & Short-ID Fallback

- Player user IDs returned by the REST leaderboard endpoint are resolved to handles via `GambitClient.graphql.resolvePlayers(userIds)`.
- If the optional GraphQL read-layer fails (e.g. service unavailable or unconfigured), or if specific player IDs cannot be resolved, the failure is caught silently.
- Unresolved IDs fall back to `shortId(userId)` text display.
- **Link Policy**: Resolved handles render as links to their profile route (`/profile/{handle}`, `data-route="profile"`). Bare, unresolved user IDs are rendered as plain text to prevent misleading profile route links that fail to resolve.

### 3. Product-Offered Variants Selection

- The variant selector populates options exclusively from `OFFERED_VARIANTS` and labels from `VARIANT_LABELS` which is isolated in `src/app/variant-labels.ts` to keep `api/models.ts` framework-independent.
- Intentionally omits hollow `chess960` (withheld per ADR-0099).

### 4. Stale Request Guard & Composite Lifecycle Teardown

- `LeaderboardController` maintains a `requestGeneration` counter and a `disposed` flag:
  - Switching variants increments `requestGeneration`. Late async responses from older variant selections are ignored (`isCurrent(generation)` check), preventing out-of-order overwrites (race condition safety).
  - Navigating away triggers `dispose()`, setting `disposed = true`. Pending promises that resolve post-teardown return immediately without calling view callbacks.
- Participates in composite structural teardown: Bootstrap uses a reusable DOM `bindVariantSelector` helper to bind change handlers. On teardown, the route composite disposable invokes `unbind()` followed by `leaderboardCtrl.dispose()`, keeping event listeners from leaking without controller/DOM coupling.

### 5. UI Architecture & Accessibility

- Follows the existing DOM-free controller and pure view renderer separation (`LeaderboardController` vs `renderLeaderboard` / `renderVariantSelector`).
- Enforces strict two-child composition per result row (`.row-main` containing rank plus player node, and `.count` for ratings) inside a `.panel-row` to simplify CSS layouts.
- Reuses established styling primitives and ensures the section is semantically labelled via `aria-labelledby`.
- Employs dynamic accessible roles: the results container switches to `role="status"` during the empty state to avoid invalid list ownership, and restores to `role="list"` when entries populate as `role="listitem"`. The loading indicator maintains a polite dedicated `role="status"`.

## Consequences

- Exposes variant leaderboards as an accessible, responsive SPA page.
- Keeps leaderboard teardown in the same structurally exhaustive lifecycle as the other SPA routes.
- Maintains strict disposal exhaustiveness and asynchronous race safety.

## Out of Scope

- Backend rating calculation modifications.
- Modifications to existing REST or GraphQL schemas.
- Global state management abstractions.
