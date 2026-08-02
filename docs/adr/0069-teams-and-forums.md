# ADR-0069 — Teams, Communities & Team Forums (Domain, Persistence & REST API)

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-02                                                         |
| **Scope**  | `@chess-platform/community`, `@chess-platform/persistence`, `@chess-platform/api` |

---

## Context

Milestone 10 ("Social & learning") increment 4 requires teams/communities and per-team discussion forums across the domain, Postgres persistence, and REST API.

Key architectural requirements:
1. Pure, dependency-free domain core (`@chess-platform/community`) defining teams, memberships, join requests, forum threads, and forum posts.
2. Single-owner invariant: every team has exactly one owner at all times (`owner` rank 30). Ownership cannot be abandoned without explicit transfer.
3. Role hierarchy: `owner` (30) > `admin` (20) > `member` (10). Admins can manage members and content up to their own rank, but cannot promote to or above their own rank, remove higher or equal ranks, or transfer ownership.
4. Visibility & Existence Oracle Protection: private teams are hidden from non-members. Attempting to get, list members, or view threads/posts on a private team as a non-member returns `not_found` (404) to avoid leaking team existence. `not_authorized` (403) is reserved exclusively for visible resources where the actor lacks permission.
5. Forum thread lifecycle: creating a thread atomically inserts both the thread and its first post. Threads support locking, pinning, updating title, and tombstone deletion. Posts support editing (author only) and tombstone deletion (author or team moderator).
6. Database integrity: partial unique indexes (`community_memberships_one_owner_per_team` and `community_join_requests_one_pending_per_player`), foreign key indexing, and advisory transaction locks (`lockTeam` via `pg_advisory_xact_lock(hashtextextended('team:' || team_id, 0))`) acquired before any `FOR UPDATE` row locks to prevent deadlocks.

---

## Decisions

### 1. Pure, Dependency-Free Domain Core (`@chess-platform/community`)

Created `@chess-platform/community` as an independent workspace package with zero runtime dependencies. It defines:
- `Team`, `Membership`, `JoinRequest`, `ForumThread`, `ForumPost` domain models.
- `CommunityRuleError` with exhaustive error code union (`not_found`, `not_authorized`, `invalid_slug`, `slug_taken`, `invalid_input`, `already_member`, `already_requested`, `cannot_leave_as_owner`, `invalid_role_transition`, `invalid_transition`).
- Slug validation (`SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 3..40 chars) and normalization.
- Ordering comparators (`compareThreads`, `comparePosts`, `compareMembers`, `compareTeams`) guaranteeing code-point deterministic sorting.
- `CommunityRepository` port with documented invariants and `InMemoryCommunityRepository` implementation.

### 2. Single-Owner & Role Hierarchy Invariants

- A team is created with the creator as `owner`.
- The partial unique index `community_memberships (team_id) WHERE role = 'owner'` enforces **at most
  one** owner at the database level. It cannot enforce *at least* one — no index can — so "exactly
  one" is half a storage guarantee and half an application one, and it is worth saying which half is
  which rather than claiming the database holds the whole invariant.
- `transferOwnership` demotes the current owner to `admin` **and then** promotes the target, inside
  one transaction under the team advisory lock. **The order is the mechanism, not a style choice.**
  Postgres checks a partial unique index per row as each `UPDATE` lands, so promoting first means
  two owners exist for an instant and the statement fails with a unique violation. The index cannot
  be deferred out of the problem either: only *constraints* can be `DEFERRABLE`, and a constraint
  cannot be partial.
- `leaveOrRemoveMember` blocks the owner from leaving unless ownership is transferred first (`cannot_leave_as_owner`).

### 3. Existence Oracle Protection (`not_found` vs `not_authorized`)

To protect user privacy and prevent team existence enumeration:
- Private teams return `not_found` for non-members on `getTeam`, `listMembers`, `listThreads`, `getThread`, `listPosts`, and `joinTeam`.
- `not_authorized` is returned ONLY when a user can see the resource but lacks permission to perform the target action (e.g. non-admin trying to lock a thread in a public team, or editing another user's post).

### 4. Forum Atomic Thread Creation & Tombstones

- `createThread` atomically creates a `ForumThread` record and its initial `ForumPost` record in one operation.
- Deleting a thread or post sets `deletedAt` to the current timestamp and clears content (`body = ""` for posts). Tombstoned posts cannot be re-edited or re-deleted.
- Updating thread parameters (`updateThread`) allows admins/owners to toggle `locked` and `pinned` flags, and allows thread authors or admins to update thread titles.

### 5. PostgreSQL Adapter & Concurrency Control

- Schema migration `0017_community.sql` creates tables `community_teams`, `community_memberships`, `community_join_requests`, `community_forum_threads`, `community_forum_posts`.
- `PgCommunityRepository` implements `CommunityRepository` using `pg` client/pool with transaction advisory locks (`lockTeam`).
- Advisory locks are always acquired BEFORE `FOR UPDATE` row locks to maintain consistent lock
  ordering and avoid deadlock cycles.

  This one had to be fixed rather than merely stated. `respondToJoinRequest` locked the join-request
  row first and reached for the team lock second, while `createJoinRequest` holds the team lock and
  then blocks on that same row through `community_join_requests_one_pending_per_player`. Each held
  what the other wanted next, and Postgres resolved it by killing one — the staged test returns
  `deadlock detected` against that order.

  The awkward part is why the wrong order is tempting: the team id is written down *in the row*, so
  locking the team first appears impossible. It is not. The method reads the row **twice** — once
  unlocked, purely to learn which team to lock, and once under `FOR UPDATE` afterwards, which is the
  read whose result is trusted. Any method added here later owes the same shape.

### 4a. A slug is not a UUID, and neither is a typo

`GET /v1/teams/:id` accepts a team id **or** a slug. The first implementation tried `getTeam` and
fell back to `getTeamBySlug` on `not_found`, which reads as harmless and works perfectly — against
the in-memory adapter, where an id is a plain string and a slug simply misses. Postgres compares the
same value against a `uuid` column, so a slug does not miss: it raises `invalid input syntax for
type uuid`, which is not a domain error, so the fallback is never reached and the request 500s. Two
adapters disagreed and only one of them was under test. The route now decides which lookup to run
*before* running one.

The endpoint Qodo flagged was the visible instance; the exposure was wider. **None of the 22
community routes called `parseUuid`** — every one passed a raw path parameter into a UUID column, so
`/v1/teams/oops/members` and `/v1/forum/posts/oops` were 500s too. They all validate now, which is
what the rest of the API already did: `parseUuid`'s own doc comment says it exists to reject
malformed ids "before they reach a `UUID` column where the driver would otherwise raise an opaque
cast error (surfacing as a 500)". The knowledge was in the codebase; this increment had simply
walked past it.

As a backstop, `isInvalidTextRepresentation` (SQLSTATE 22P02) maps an unparseable id to `not_found`
in the adapter. The route is still the right place to answer — a 422 says more than a 404 — but a
repository that 500s whenever a route forgets turns one missing call into an outage.

### 5a. `not_found` vs `not_authorized`, again

Cancelling a join request answered `not_authorized` to anyone who was not the requester, while an
invented id answered `not_found`. A join request is visible only to its requester and to the team's
admins, so that pair of responses is an oracle over request ids — the same defect ADR-0068 §5
records, in a new place, which is a reason to state the rule in the port doc rather than to
re-derive it per method. It is `not_found` in both adapters now, and the tests compare a real id
against an invented one side by side.

Worth noting how it was found: changing the behavior broke **no test**. Nothing covered the case at
all, in either adapter. A rule that no test exercises is a comment.
- Pagination converts `NaN` to `0` and `Infinity` to safe limits.

### 6. REST API Surface

Registered 22 REST endpoints under `/v1/teams/*` and `/v1/teams/:id/forum/*`:
- `POST /v1/teams`: Create team (201 TeamView).
- `GET /v1/teams`: List/search teams (200 TeamList).
- `GET /v1/teams/:id`: Get team by ID or slug (200 TeamView).
- `PATCH /v1/teams/:id`: Update team (200 TeamView).
- `GET /v1/teams/:id/members`: List members (200 MemberList).
- `POST /v1/teams/:id/members`: Join public team (201 MembershipView).
- `DELETE /v1/teams/:id/members/:playerId`: Leave/remove member (204). Checks player existence.
- `PATCH /v1/teams/:id/members/:playerId`: Update role (200 MembershipView). Checks player existence.
- `POST /v1/teams/:id/transfer-ownership`: Transfer ownership (200 OwnershipTransferView). Checks player existence.
- `POST /v1/teams/:id/join-requests`: Request join (201 JoinRequestView).
- `GET /v1/teams/:id/join-requests`: List join requests (200 JoinRequestList).
- `POST /v1/teams/:id/join-requests/:reqId/respond`: Accept/decline (200 JoinRequestView).
- `DELETE /v1/teams/:id/join-requests/:reqId`: Cancel (200 JoinRequestView).
- `GET /v1/teams/:id/forum/threads`: List threads (200 ForumThreadList).
- `POST /v1/teams/:id/forum/threads`: Create thread (201 ForumThreadCreateView).
- `GET /v1/teams/:id/forum/threads/:threadId`: Get thread (200 ForumThreadView).
- `PATCH /v1/teams/:id/forum/threads/:threadId`: Update thread (200 ForumThreadView).
- `DELETE /v1/teams/:id/forum/threads/:threadId`: Delete thread (200 ForumThreadView).
- `GET /v1/teams/:id/forum/threads/:threadId/posts`: List posts (200 ForumPostList).
- `POST /v1/teams/:id/forum/threads/:threadId/posts`: Create post (201 ForumPostView).
- `PATCH /v1/forum/posts/:postId`: Edit post (200 ForumPostView).
- `DELETE /v1/forum/posts/:postId`: Delete post (200 ForumPostView).

---

## Consequences

- Teams, communities, and forums are fully supported across all layers of the monorepo.
- Monorepo package purity, zero runtime dependencies for domain logic, and strict TypeScript rules are preserved.
- Full OpenAPI specification coverage and test suite verification guarantee contract correctness.
