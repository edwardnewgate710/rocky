# ADR-0085 — Direct Messaging UI

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-08-04                      |
| **Scope**  | `packages/web`, `packages/e2e-harness` |

---

## Context

Milestone 10 shipped a complete direct messaging backend (8 REST endpoints under `/v1/messages/*`), but `packages/web` had no user interface for messaging. This increment exposes messaging as a usable feature with an inbox, conversation thread viewing and sending, and profile-based conversation entry points. Exposing this backend surface requires addressing specific architectural constraints and data modeling gaps:

1. **User-ID-Only Participant Gap**: The messaging endpoints (`GET /v1/messages/conversations` and `GET /v1/messages/conversations/:id`) return participant user IDs (`participantA`, `participantB`, `senderId`) as UUIDs, not handles or display names (`packages/api/src/presenters.ts`).
2. **Harness Wiring Gap**: three separate `ApiDependencies` fields are optional (`packages/api/src/deps.ts`), and each answers HTTP 503 when absent. The e2e harness wired none of them, and building this feature surfaced all three in sequence:
   - `messagingRepository` — every `/v1/messages/*` route returned 503.
   - `socialGraphRepository` — `/v1/social/*` returned 503, so no relationship ever loaded, so `renderSocialActions` returned early and the profile's "Message" entry point never rendered at all.
   - `graphql` — `POST /v1/graphql` returned 503, so the batched `resolvePlayers` hydration resolved nothing and every player id fell back to `shortId(...)`.

   The third was the least visible and the most significant: the tournaments and search views rely on the same hydration path and their specs pass regardless, because none of them asserts on a resolved handle. Name resolution was therefore never exercised end to end before this increment.
3. **No Realtime Push Channel**: The realtime gateway (`packages/realtime-gateway`) carries game and tournament channels only. No WebSocket channel exists for direct messaging.
4. **Tombstone Rendering**: The backend models deleted messages as tombstones (`deletedAt !== null` with cleared body). Rendering the original body of a deleted message would be a defect.

## Decision

### 1. Harness Wiring (`packages/e2e-harness`)

`packages/e2e-harness/src/harness.ts` now composes all three optional dependencies under `GAMBIT_E2E_BACKEND=1`:

- `messagingRepository`: `new InMemoryMessagingRepository(socialGraphRepository)` (from `@chess-platform/messaging`). The social graph is passed as the block checker, mirroring `packages/api/test/helpers.ts`, so block enforcement is real rather than defaulting to "never blocked".
- `socialGraphRepository`: `new InMemorySocialGraphRepository()` (from `@chess-platform/social`).
- `graphql`: `{ introspection: false }` — introspection stays off, matching the production default.

Both new package dependencies were added to `packages/e2e-harness/package.json` **and** `package-lock.json`. A workspace dependency added to only the former still builds locally, because the monorepo hoists at the root; it fails solely under `npm ci`, which is what CI runs.

### 2. Batched Player Handle Hydration

Because messaging endpoints identify participants by UUID only, `MessagesController` in `packages/web/src/app/messages-controller.ts` collects participant IDs across conversations/messages per render and resolves handles in a single batched `client.graphql.resolvePlayers(ids)` call. If a handle cannot be resolved (or the read layer is off), the UI falls back to `shortId(id)`.

### 3. Open Thread Polling & Realtime Absence

No WebSocket push channel exists for DMs. Freshness comes strictly from polling the currently open conversation thread every 5000ms via `MessagesController.startPolling(id)`. The inbox is not polled, and polling stops immediately when navigating away or disposing the controller.

### 4. Tombstone Message Placeholder Rendering

Messages with `deletedAt !== null` are rendered as placeholder text (`"[Message deleted]"`) using `.message-tombstone` in `packages/web/src/app/messages-view.ts`, rather than attempting to display the cleared body.

### 5. Profile Action Entry Point & SPA Navigation

When an authenticated user views another player's profile (`/profile/:handle`), a "Message" button is rendered in the social action bar in `packages/web/src/app/bootstrap.ts`. Clicking it calls `client.messages.openWith(profile.user.id)` and navigates to `/messages/:id` via SPA navigation (`history.pushState` + `window.dispatchEvent(new PopStateEvent('popstate'))`).

### 6. What Is NOT Covered

- **Editing and Deleting Messages**: PATCH `/v1/messages/messages/:id` and DELETE `/v1/messages/messages/:id` endpoints exist on the backend but are intentionally out of scope for this UI increment.
- **Realtime Push for DMs**: There is no WebSocket channel for messaging. Polling the open thread every 5000ms is the sole mechanism for updates in this increment.
- **Global Unread Badge in Nav**: There is no REST endpoint returning total unread messages across all conversations (`getUnreadCount` exists on `MessagingRepository` but is not exposed over REST). Summing a paginated conversation list is incomplete and invalid, so no unread badge is rendered in the nav bar.
- **Block Management UI**: Block management controls and block enforcement UI in messaging are out of scope.

## Consequences

- Wired `InMemoryMessagingRepository`, `InMemorySocialGraphRepository` and the GraphQL read layer in `packages/e2e-harness/src/harness.ts`, and added `@chess-platform/messaging` and `@chess-platform/social` to that package's dependencies and the lock file.
- Added messaging models to `packages/web/src/api/models.ts` and `MessagesApi` to `packages/web/src/api/client.ts`.
- Added `/messages` and `/messages/:id` routes to `packages/web/src/app/router.ts`.
- Implemented `MessagesController` (`packages/web/src/app/messages-controller.ts`) and pure DOM view functions (`packages/web/src/app/messages-view.ts`).
- Added nav link and `#messages` and `#conversation` sections to `packages/web/index.html`.
- Updated `packages/web/src/app/bootstrap.ts` and `packages/web/src/main.ts` for section visibility, route handlers, profile "Message" action, and controller disposal.
- Added unit tests (`packages/web/test/messages.test.ts`), client tests (`packages/web/test/api-client.test.ts`), a11y tests (`packages/web/test/a11y.test.ts`), and Playwright E2E spec (`packages/web/e2e/messages.spec.ts`).
