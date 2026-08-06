# ADR-0088 — Team forums UI (read, start a thread, reply)

| Field      | Value                                  |
|------------|----------------------------------------|
| **Status** | Accepted                               |
| **Date**   | 2026-08-04                             |
| **Scope**  | `packages/web`, `packages/api`         |

---

## Context

Milestone 10 increment 4 (ADR-0069) shipped team forums — 7 routes — with no UI. Increment 20 (ADR-0087) shipped the Teams UI and deliberately left the forum as its own increment rather than a rushed appendix. This is that increment: read a team's threads, open one, start a thread, reply.

Scoping it surfaced a defect in the published contract, fixed here because this increment is its first consumer.

## Decision

### 1. `ForumPostView` in the OpenAPI spec was wrong, and is corrected

`forumPostView` in `packages/api/src/presenters.ts` has always emitted `editedAt`. The published schema in `packages/api/src/openapi/schemas.ts` declared `updatedAt` in its `required` list and did not mention `editedAt` at all — so the spec described a field the server never sends and omitted one it always does. A client generated from it would look for `updatedAt` and never find it.

`MessageView` in the same file had it right, which is what made the divergence visible. The schema now matches the presenter, and `packages/api/openapi.json` was regenerated with `npm run openapi` rather than hand-edited.

This is a pre-existing defect from M10 increment 4, not something this increment introduced. It is fixed here because the forum UI consumes exactly this shape, and shipping against a contract known to be false would be worse than the small scope increase.

### 2. Who may act is a pure decision, tested as a truth table

`packages/web/src/app/forum-helpers.ts` holds `canStartThread` and `canReply`, both pure over (thread, members, viewer). The rules come from the routes:

- `POST .../forum/threads` answers **403 "Only team members can create threads"**.
- `POST .../forum/threads/:id/posts` answers **403 "Only members can post or thread is locked"** — so replying requires membership **and** an unlocked thread.

Both return a reason when they refuse, and the UI renders that reason instead of a control the server would reject. Where two reasons are true at once — a non-member on a locked thread — membership wins, because it is the one that would still block them if the thread reopened.

Membership comes from `membershipOf` in `teams-helpers.ts`, reused rather than reimplemented, so the two surfaces cannot drift on who counts as a member.

### 3. Tombstones never render their content

Both a thread and a post carry `deletedAt`. `postDisplayBody` and `threadDisplayTitle` return placeholder text for a tombstone. This increment does not implement deletion, but the backend returns tombstones and rendering the body of a deleted post would be a real defect — the same rule the direct-messaging UI follows (ADR-0085).

### 4. Pinned threads sort first, client-side, and the limit is stated

`sortThreads` puts pinned threads ahead of the rest, then orders by `lastPostAt` descending. It sorts the page the API returned, not the whole set — with no pagination in this increment, a pinned thread outside the first page would not surface. That is the honest limit of doing it client-side and is listed below rather than hidden.

### 5. Not-found rather than forbidden

A private team answers `404` for every forum route, identically to a team that does not exist, and a missing thread answers `404` too. The controller maps `NotFoundError` to a dedicated state. Rendering "no permission" would confirm the resource exists and undo the Existence Oracle protection ADR-0069 built.

### 6. Loads defer on the session

The reads are public, but *who the viewer is* decides which composer appears, and the access token arrives asynchronously. Both routes defer their load on `restorePromise`, as the messaging (ADR-0085) and teams (ADR-0087) routes do. Without it a reload shows a member the non-member state.

### 7. What Is NOT Covered

- **Moderation**: updating a thread (title, `locked`, `pinned`) and deleting a thread. The UI reads `locked` and `pinned` but cannot set them, so a thread can only be locked through the API.
- **Editing and deleting posts.** The UI renders `editedAt` and honours tombstones, but creates neither.
- **Pagination** on threads and posts — both render the first page at the API's default limit. This also bounds the pinned-first ordering, per decision 4.
- **Optional dependencies still unwired in the e2e harness**: `semanticSearchRepository`, `achievementsRepository`, `studiesRepository`, `learningRepository`. Each answers 503 when absent, so the next UI increment for any of them must wire its own.

## Consequences

- `TeamsApi` in `packages/web/src/api/client.ts` gains `threads`, `thread`, `createThread`, `posts`, `createPost` — the forum routes are nested under a team, so they live on the existing class rather than a second one.
- `JoinRequestView` in `packages/api/src/openapi/schemas.ts` was the second instance of this exact defect class (declaring `updatedAt` instead of `respondedAt`), resolved in Increment 28.
- `/teams/:slug/forum` and `/teams/:slug/forum/:threadId` added to `packages/web/src/app/router.ts`. Any other path under a team slug now resolves to `not-found` instead of falling through to the team page.
- `ForumController` (`packages/web/src/app/forum-controller.ts`) loads thread, posts and members together, because the reply decision needs all three, and resolves every author id in one batched `resolvePlayers` per render.
- Pure views in `packages/web/src/app/forum-view.ts`; disposal wired in `packages/web/src/main.ts`.
- `#forum` and `#thread` sections in `packages/web/index.html`, plus a forum link on the team detail page.
- Tests: `packages/web/test/forum-helpers.test.ts` covers the decision truth table, ordering and tombstones; `api-client.test.ts` the five methods; `router.test.ts` the nested routes; `a11y.test.ts` the markup; and `packages/web/e2e/forum.spec.ts` the start-a-thread-and-reply loop across two members.
