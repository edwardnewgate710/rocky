# ADR-0087 — Teams UI (browse, view, join, leave)

| Field      | Value                                        |
|------------|----------------------------------------------|
| **Status** | Accepted                                     |
| **Date**   | 2026-08-04                                   |
| **Scope**  | `packages/web`, `packages/e2e-harness`       |

---

## Context

Milestone 10 increment 4 (ADR-0069) shipped teams, memberships, join requests and team forums — 20 routes under `/v1/teams/*` — with no user interface at all. This increment exposes the smallest slice that is genuinely usable on its own: discover a team, look at it, join it, leave it.

Three constraints shaped the work.

1. **Membership identifies players by id only.** `MembershipView` (`packages/api/src/presenters.ts`) carries `playerId` as a UUID, and `TeamView.createdBy` likewise. Neither carries a handle, so names have to be hydrated separately.

2. **Three routes answer errors the UI can predict.** Joining a private team is `403`, joining twice is `409`, and the owner leaving is `409`. A UI that renders the button anyway produces a control the server refuses.

3. **`ApiDependencies.communityRepository` is optional** (`packages/api/src/deps.ts:87`) and the e2e harness did not wire it, so every team route answered `503` under `GAMBIT_E2E_BACKEND=1`. This is the fifth optional dependency the harness has needed; see "What Is NOT Covered".

## Decision

### 1. Names hydrate through the existing batched read layer

`TeamsController` resolves every member id in one `client.graphql.resolvePlayers(ids)` call per render, falling back to `shortId(id)` per row, exactly as the search, tournament and messaging controllers do (ADR-0074's pattern). No new endpoint, and no per-row request.

### 2. The offered action is computed, not guessed

`teamAction` in `packages/web/src/app/teams-helpers.ts` is a pure function over (team, members, viewer id) returning `join`, `leave`, or `none` with a reason. The rules:

- **Signed out** — no action, and the page says to sign in. Browsing and viewing stay available, since both routes are public.
- **Not a member, public team** — offer Join.
- **Not a member, private team** — no Join, and the page explains that joining is by request and that the request flow does not exist yet. A button that always answers 403 is worse than no button.
- **Member** — offer Leave. Membership is checked *before* visibility, because a member of a private team can still leave it.
- **Owner** — no Leave, and the page says ownership must be transferred first.

**Ownership is read from the viewer's own membership row, never from `team.createdBy`.** Ownership transfers, so the creator is not necessarily the current owner; keying off `createdBy` would offer Leave to precisely the person the server refuses. A unit test pins this by giving the team a `createdBy` who is not the owner.

### 3. A private team renders as not found, never as forbidden

`GET /v1/teams/:id` answers `404` for a private team the caller cannot see. That is deliberate Existence Oracle protection from ADR-0069, so the controller maps `NotFoundError` to a dedicated `onNotFound` state rather than an error message. Rendering "you do not have permission" would confirm the team exists and undo the backend's protection.

Detection uses the typed `NotFoundError` from `packages/web/src/net/errors.ts` rather than sniffing a status code, which is what that module exists for.

### 4. The detail load waits for the session

The team routes are public, so the data loads fine unauthenticated — but *which action to offer* depends on knowing the viewer. The access token arrives asynchronously via `auth.restore()`, so the detail route defers its load on `restorePromise` exactly as the messaging routes do (ADR-0085). Without it, a signed-in user reloading the page would be offered the signed-out affordance.

### 5. Harness wiring

`packages/e2e-harness/src/harness.ts` now composes `InMemoryCommunityRepository` as `communityRepository`. The e2e spec creates its fixture team through the real `POST /v1/teams` endpoint — unlike search indexing, team creation is a genuine product route, so no bridge route was added.

### 6. What Is NOT Covered

- **Creating and editing teams from the UI.** `POST /v1/teams` and `PATCH /v1/teams/:id` exist and are used only by the e2e fixture.
- **Roles and moderation** — `PATCH /v1/teams/:id/members/:playerId`, `transfer-ownership`, and removing another member. Their absence is why the owner is shown an explanation rather than a Leave button.
- **Private-team join requests** — the four `join-requests` routes. This is the single largest gap: private teams are visible in the UI but cannot be joined through it.
- **The team forum entirely** — 7 routes for threads and posts. It is deliberately its own next increment rather than a rushed appendix to this one.
- **Pagination.** Both lists render the first page at the API's default limit. Neither the team list nor the member list offers a next page.
- **Optional dependencies still unwired in the harness**: `semanticSearchRepository`, `achievementsRepository`, `studiesRepository` and `learningRepository`. Each answers 503 when absent, so the next UI increment for any of them must wire its own — the pattern that cost three separate discoveries in ADR-0085.

## Consequences

- `TeamsApi` added to `packages/web/src/api/client.ts`, exposed as `client.teams`.
- Team types in `packages/web/src/api/models.ts` narrow `visibility` and `role` to literal unions, matching `packages/community/src/model.ts` rather than the presenter's bare `string`.
- `/teams` and `/teams/:slug` added to `packages/web/src/app/router.ts`, preferring the slug because the backend accepts either and the slug is readable.
- `TeamsController` (`packages/web/src/app/teams-controller.ts`) and pure views (`packages/web/src/app/teams-view.ts`), with disposal wired in `packages/web/src/main.ts`.
- Nav link and `#teams` / `#team` sections in `packages/web/index.html`.
- Tests: `packages/web/test/teams-helpers.test.ts` covers the action truth table, `packages/web/test/api-client.test.ts` the five client methods, `packages/web/test/a11y.test.ts` the markup, and `packages/web/e2e/teams.spec.ts` the browse-join-appear loop.
