# ADR-0124 — Private-team join requests preserve the existence boundary

| Field      | Value                                                          |
|------------|----------------------------------------------------------------|
| **Status** | Accepted                                                       |
| **Date**   | 2026-08-21                                                     |
| **Scope**  | `packages/community`, `packages/persistence`, `packages/api`   |
| **Amends** | [ADR-0069](0069-teams-and-forums.md) and [ADR-0096](0096-join-request-moderation.md) |

---

## Context

ADR-0069 made an invisible private team read as `not_found` to a non-member. Team details,
memberships, and forum resources all went through that visibility rule. `createJoinRequest` did
not: both repository adapters read the team directly, so `POST /v1/teams/:id/join-requests`
distinguished a live private team from a missing team.

The team id being a UUID is not a privacy control. IDs are copied, logged, shared, and leaked; a
person who learns one must not gain an existence probe that the ordinary team-read routes deny.
Returning the same status with different error codes, shapes, or messages would preserve the
probe, so the whole resource-dependent error result must be the same.

The requester-side lifecycle had a separate gap. Cancellation already existed at
`DELETE /v1/teams/:id/join-requests/:reqId` and was requester-scoped, but after a reload the
requester had no way to recover the pending request id. The team-scoped list is deliberately an
owner/admin moderation resource and cannot fill that role.

## Decision

### 1. Bare team ids do not authorize private-team join requests

`createJoinRequest` applies team visibility inside the `CommunityRepository` implementations, the
authoritative boundary shared by HTTP and non-HTTP callers. For a non-member, a live private team
and a missing team both raise `not_found` with the same message. The API therefore emits the same
status, error code, envelope shape, and message for both. Generated correlation ids normally differ
between requests but carry no team information; the regression supplies the same caller-controlled
`X-Request-Id` to compare the complete envelopes exactly.

Public teams remain requestable, preserving the existing visible-team behavior and duplicate
semantics. A private-team member still reaches the membership check and receives `already_member`;
the privacy rule is about actors who cannot see the team.

This does not add private-team discovery. It also does not add invitation or token support. Future
private-team onboarding requires an explicit privacy-preserving capability, such as a signed invite
or a deliberate invitation flow, designed in its own increment.

### 2. Requesters can list only their own pending requests

`GET /v1/me/join-requests` derives the player id only from the authenticated actor. It accepts no
user-id path or body parameter and returns a paginated list of that player's pending rows. Unknown
query parameters cannot change the actor.

The existing lifecycle is retained:

- `pending` rows are present;
- `accepted`, `declined`, and `cancelled` rows are absent;
- directly joining a visible public team atomically accepts that caller's pending request, so it
  cannot remain as stale moderation state;
- terminal rows remain stored and remain available through the existing owner/admin moderation
  history.

The response reuses `JoinRequestView`: request id, raw team id, the caller's own player id, status,
and lifecycle timestamps. It does not join the team record and therefore exposes no team name,
slug, description, or visibility. This is important for legacy rows and for requests created while
a team was public and made private later: the requester can recover the id needed for cancellation
without gaining a weaker private-team presentation oracle.

The pending self-list query is backed by a partial `(player_id, created_at DESC, id ASC)` index.
Because old application replicas continue writing during progressive delivery, that index is
installed with `CREATE INDEX CONCURRENTLY`. The migration ledger records the operation as pending
before the non-transactional statement, allowing an interrupted run to validate and finalize a
completed index or safely retry an invalid one.

### 3. Existing moderation and cancellation routes remain the lifecycle authorities

Owner/admin listing and response stay on the team-scoped routes from ADR-0096. Requesters cancel
through the existing DELETE route; no second cancellation API is introduced. Cancelling another
player's request remains `not_found`, preserving the request-id oracle protection already recorded
in ADR-0069.

## Consequences

- A non-member with only a private-team UUID can no longer submit a join request or confirm that
  the team exists.
- Existing pending private-team rows remain recoverable by their requester without exposing team
  presentation metadata.
- Reload recovery is available through a self resource, while cross-user enumeration is absent by
  construction.
- The web client is unchanged. It has owner/admin moderation UI but no existing requester
  join/cancel surface to restore; designing discovery or navigation would exceed this decision.
- Regression coverage compares the private-existing and missing HTTP errors side by side, and
  covers public requests, duplicates, requester isolation, spoof resistance, terminal-state
  filtering, moderation, cancellation authorization, and legacy private rows.
