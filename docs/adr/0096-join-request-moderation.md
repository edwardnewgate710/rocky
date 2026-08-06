# ADR-0096 — Team join-request moderation (owner/admin half)

| Field      | Value                                                        |
|------------|--------------------------------------------------------------|
| **Status** | Accepted                                                     |
| **Date**   | 2026-08-06                                                   |
| **Scope**  | `packages/community`, `packages/persistence`, `packages/api`, `packages/web` |

---

## Context

Private team join requests had four API routes (`GET /v1/teams/:id/join-requests`, `POST /v1/teams/:id/join-requests`, `POST /v1/teams/:id/join-requests/:reqId/respond`, `DELETE /v1/teams/:id/join-requests/:reqId`) but no UI in `packages/web`.

The requester half ("my pending join requests") remains blocked on an open API decision. However, the owner/admin moderation half is reachable via existing endpoints and could ship independently to give team managers complete visibility and control over pending join requests.

## Decisions

### 1. Moderation half ships alone
The owner/admin moderation flow operates entirely on team-scoped routes (`GET /v1/teams/:id/join-requests` and `POST /v1/teams/:id/join-requests/:reqId/respond`). It does not require requester-side views ("my requests") or public team existence disclosure (respecting `ADR-0069`). Shipping moderation alone resolves team owner pain immediately without unblocking the requester API decision.

### 2. Server-side status filtering before pagination
Previously, `listJoinRequests` in `packages/community/src/repository.ts` and `packages/persistence/src/pg/community.ts` returned all requests regardless of status, paginated. Filtering for pending requests on the client side caused a failure mode where pending requests beyond page 1 of history were hidden from the moderator, creating a false empty queue.

We widened `listJoinRequests` to accept an optional `status` parameter (`PageOptions & { status?: JoinRequestStatus }`) and applied the status filter in the SQL `WHERE` clause and in-memory list before applying pagination (`paginate`). `GET /v1/teams/:id/join-requests` in `packages/api/src/routes.ts` validates `status` against allowed enum values using `oneOf` (returning 422 for unknown status values).

### 3. Extract `appendPanelRow` to `render-helpers.ts`
`appendPanelRow` and `RowAction` previously lived inside `packages/web/src/app/bootstrap.ts`. To allow `packages/web/src/app/teams-view.ts` to render pending join request rows using the exact same row structure and `aria-label` accessibility conventions without duplicating code or creating new CSS rules, `appendPanelRow` and `RowAction` were moved to `packages/web/src/app/render-helpers.ts` and exported.

### 4. The busy/failure rule lives in a seam, not in a closure

`TeamsController.respondToJoinRequest` reports failure by **returning `false`**, not by throwing — it catches the error and surfaces it through `onError` itself. The first implementation disabled the queue's buttons before the request and relied on the team reload to repaint them, which only happens on success. A failed response therefore left every button in the queue disabled until the viewer navigated away, with the error message sitting next to a queue they could no longer act on. `POST /v1/teams/:id/join-requests/:reqId/respond` answers **409** when the request is no longer pending, which is what a second admin answering first looks like — routine on a moderation queue, not an edge case.

The rule is now owned by `createJoinRequestQueue` in `packages/web/src/app/teams-helpers.ts`: render busy before the request, and render not-busy again when the response reports failure. It takes the renderer and the responder as functions and touches neither the DOM nor the client, so `packages/web/test/teams-helpers.test.ts` asserts the real sequence (`[true, false]` on failure, `[true]` on success) against the exported function rather than a copy of it. This is the same move ADR-0092 made for the disposal list, for the same reason: logic reachable only from inside `bootstrap` does not get a real test, and the first attempt at one asserted against a re-declaration of the production logic inside the test body — it passed with the fix fully reverted.

Unit tests pin the rule; they cannot pin that `bootstrap` still *uses* the seam. Verified: replacing the factory call with an inline handler that never repaints on failure leaves all 455 `packages/web` unit tests green. A Playwright test in `packages/web/e2e/teams.spec.ts` closes that by intercepting the respond call with a 409 and asserting the row survives with both buttons enabled.

### 5. The viewer's own role comes from the server, not from a page of other people

Added in the PR review. The client decided both "may I moderate" and "may I join or leave" by searching the member list it had already fetched. That list is capped at 50 and sorted owner → admin → member (`compareMembers` in `packages/community/src/ordering.ts`), so on a large team the viewer is simply not in it:

- an admin behind 50 other admins never saw the moderation queue — no error, nothing to retry;
- worse and pre-existing, an **ordinary member** of a team with more than 50 members sorts after every owner and admin, so `teamAction` decided they were not a member and offered them a Join button for a team they were already in.

`GET /v1/teams/:id` now returns `TeamDetailView`, which adds `viewerRole` (`owner` / `admin` / `member`, or `null` for a non-member or signed-out caller), resolved through the existing `getMembership`. One lookup, and only for a signed-in caller. `teamAction` takes the role instead of the member list, so neither answer depends on which page the client happened to read. Membership is a fact about the viewer, not something to infer from a page of other people.

While pinning that contract: `TeamView` listed `updatedAt` in its `required` array, and neither the `Team` domain type nor `teamView` has ever had such a field. That is the third instance of the divergence ADR-0088 fixed for `ForumPostView` and M14 increment 28 fixed for `JoinRequestView`, and it survived for the same reason — every route test reads the response and none read the schema. Removed, with a coupling test in `packages/api/test/openapi.test.ts` covering both `TeamView` and `TeamDetailView`.

### 6. Explicitly out of scope
The requester-side half ("my join requests" route, public private-team view, or changes to `findVisibleTeam` / `ADR-0069`) remains untouched and out of scope.
