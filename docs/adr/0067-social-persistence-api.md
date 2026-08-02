# ADR-0067 — Social graph persistence & REST API

| Field      | Value                                              |
|------------|----------------------------------------------------|
| **Status** | Accepted                                           |
| **Date**   | 2026-08-01                                         |
| **Scope**  | `@chess-platform/persistence`, `@chess-platform/api` |

---

## Context

Increment 1 (ADR-0066) shipped `@chess-platform/social`: a pure, dependency-free domain package defining follow edges, a friend-request state machine, block enforcement, and the `SocialGraphRepository` port.

This increment connects the domain to relational persistence and HTTP REST endpoints, mirroring the design path taken for search (ADR-0053 and ADR-0054).

The persistence adapter and API surface must guarantee:
1. All seven domain invariants specified in `packages/social/src/repository.ts`.
2. Atomic multi-table updates during blocking (`block()`).
3. Correct collation behavior without invalid Postgres DDL.
4. Secure authentication, authorization, server-generated IDs, and protocol error mapping.
5. Graceful degradation (503 Service Unavailable) when the social graph repository is not configured.

---

## Decision

### 1. Database Schema (`packages/persistence/migrations/0015_social_graph.sql`)

Three tables persist the social graph state:
- `social_follows`: Stores directed follow edges `(follower_id, followee_id, followed_at)`.
- `social_blocks`: Stores directed block edges `(blocker_id, blocked_id, blocked_at)`.
- `social_friend_requests`: Stores friend request states `(id, requester_id, addressee_id, status, created_at, responded_at)`.

All player columns are typed `UUID REFERENCES users(id) ON DELETE CASCADE`. CHECK constraints (`not_self`) enforce distinct players at the database level. Partial unique indexes enforce one pending request per pair and one accepted request per pair.

### 2. Collation Rationale (No `COLLATE "C"`)

`COLLATE "C"` is **NOT** specified on UUID columns in SQL. Postgres UUID is a native 128-bit scalar type rather than a collatable string type; specifying a collation on UUID fields raises a Postgres syntax error (`collations are not supported by type uuid`). Plain `ORDER BY ... ASC` on UUID compares byte-wise, which naturally matches the character code-point order of `compareIds` in TypeScript.

### 3. Transaction Safety & Precedence Enforcement (`PgSocialGraphRepository`)

- `block()` runs inside a single Postgres transaction (`BEGIN ... COMMIT`). It deletes follow rows in both directions, updates open pending friend requests to `cancelled` and accepted friend requests to `ended`, and upserts the block edge.
- `follow()` and `sendFriendRequest()` verify that no block exists between the players inside the same transaction prior to performing inserts.
- `sendFriendRequest()` traps unique constraint violations (`23505`) and converts them into `SocialRuleError('already_exists')`.

**A transaction is not by itself enough, and two places needed more than one.**

*`respondToFriendRequest` read on one pool connection and wrote on another.* Both callers of a
concurrent accept/cancel see `pending`, both compute a legal transition, and the second `UPDATE` —
which carried no `WHERE status` guard — silently overwrites the first. An accepted friendship could
be turned into a cancellation that was never valid at the moment it was applied. The read now
happens inside the transaction with `FOR UPDATE`, so the second caller sees the committed status and
is refused with `invalid_transition`, which is the answer it should get. `block()` likewise takes
`FOR UPDATE` on the request rows it is about to transition.

*`follow` could outlive a block.* Checking "is there a block?" and inserting the follow inside one
transaction still races at READ COMMITTED: `follow` reads no block, `block` commits its teardown,
`follow` inserts — and the blocked player is left following the person who blocked them, the exact
outcome blocking exists to prevent. Row locks cannot close it, because the row `follow` would need
to lock is a block row that does not exist yet, and a phantom cannot be locked.

`follow`, `sendFriendRequest` and `block` therefore take `pg_advisory_xact_lock` keyed on the
**unordered pair** before doing anything else. Keying on the pair rather than on a player means
unrelated blocks never queue behind each other; a hash collision costs two unrelated pairs a little
serialization and nothing else.

**How this is tested, and one thing that did not work.** Firing two `respondToFriendRequest` calls
with `Promise.allSettled` does *not* reproduce the lost update — they serialize on the pool and never
interleave, and that version of the test passed against the broken adapter. The interleaving has to
be staged: an outside transaction locks the row and resolves it, the adapter is then allowed to read,
and only afterwards does the holder commit. That test fails against the pre-fix adapter and passes
against this one, which is the only reason to believe the fix does anything.

**Idempotency is one statement, not two.** `follow()` and `block()` both began as
"write if absent, otherwise read back the existing timestamp". Two statements, and the gap between
them is reachable: `unfollow()` and `unblock()` delete on their own connection without the pair
lock. `follow()` failed loudly — `ON CONFLICT DO NOTHING` takes no lock on the row it conflicts
with, so a delete committing in between left the follow-up `SELECT` empty and the request crashed
on `rows[0]`. `block()` failed **silently**, which is worse: its `SELECT` still saw the old row
version while an uncommitted `DELETE` held it, so it concluded "already blocked", skipped the
`INSERT`, and returned a `BlockEdge` for a block that ceased to exist moments later — a caller told
they were protected, with no block row to protect them.

Both are now a single `INSERT ... ON CONFLICT ... DO UPDATE SET <col> = <table>.<col> RETURNING`.
`DO UPDATE` locks the conflicting row, so a concurrent delete waits its turn instead of racing;
assigning the column to itself is what preserves the original timestamp, since re-following must
not reset `followed_at`. `unfollow()` and `unblock()` deliberately do **not** take the advisory pair
lock: with the upsert holding a row lock there is no read-then-write left to protect, and every
interleaving now ends in a coherent state.

The `block()` defect is covered by a staged test — an outside transaction holds an uncommitted
`DELETE` on the block row while `block()` runs, and the assertion is on the state after both settle.
It fails against the two-statement version with `isBlockedBetween === false`. The `follow()` crash
is not stageable from outside (it needs a pause *between* two statements of the adapter's own
transaction, which no external lock can create), so it rests on the structural argument above
rather than on a test; claiming otherwise would be claiming a test that cannot exist.

**`Infinity` had to be handled explicitly.** ADR-0066 records that the domain needs no special case
for it — `slice(Infinity)` yields nothing and an infinite limit means "all remaining". That
reasoning is about `Array.slice` and does not survive the trip to SQL: `pg` serializes `Infinity` as
the string `"Infinity"`, and Postgres answers `invalid input syntax for type bigint: "Infinity"`. An
infinite limit is therefore the *absence* of a `LIMIT` clause, and an infinite offset is
`Number.MAX_SAFE_INTEGER`. The HTTP layer rejects both before they reach here (`parseOffset` and
`parseLimit` require integers), so this is a port-contract fix, not a live bug — but an adapter that
diverges from its port only stays harmless until the next caller.

### 3a. Indexes the foreign keys need

Postgres does not index the *referencing* side of a foreign key, so every `ON DELETE CASCADE` here
implies an index that has to exist deliberately. Three were missing:

- `social_blocks (blocked_id)` — also the reverse leg of `isBlockedBetween`, which runs on **every**
  follow and **every** friend request. Without it the hottest read in this increment scans the table.
- `social_friend_requests (requester_id)` and `(addressee_id)` — the four query-serving indexes on
  this table are all partial (`WHERE status = 'pending'` / `'accepted'`), which is right for the
  queries but leaves rows in the other three statuses uncovered. Deleting one account would have
  sequentially scanned the table twice.

### 4. REST API Surface (`@chess-platform/api`)

Exposes 12 HTTP endpoints under `/v1/social/...`:
- `POST /v1/social/follows/:playerId` — Follow a player
- `DELETE /v1/social/follows/:playerId` — Unfollow a player
- `GET /v1/social/players/:playerId/followers` — List a player's followers (Public)
- `GET /v1/social/players/:playerId/following` — List players followed by a player (Public)
- `POST /v1/social/friend-requests` — Send a friend request (Server generates request ID via `uuidv7()`)
- `POST /v1/social/friend-requests/:id/respond` — Accept, decline, or cancel a friend request
- `GET /v1/social/friend-requests/incoming` — List incoming pending friend requests (Caller's own only)
- `GET /v1/social/friend-requests/outgoing` — List outgoing pending friend requests (Caller's own only)
- `GET /v1/social/friends` — List caller's friends (Caller's own only)
- `POST /v1/social/blocks/:playerId` — Block a player
- `DELETE /v1/social/blocks/:playerId` — Unblock a player
- `GET /v1/social/blocks` — List caller's blocked players (Caller's own only)

All six list endpoints accept `?limit=` and `?offset=`, and both are declared in the route docs so
they reach the generated `openapi.json`. The first draft parsed `offset` without documenting it,
which is the failure mode where a parameter exists but no generated client can discover it. The
`offsetParam()` helper sits next to `limitParam()` so the pair is declared the same way everywhere,
and the offset parser this increment added is the one the search routes now share rather than a
second copy of the same six lines.

### 5. Security & Authorization

- The actor ID is strictly derived from `requireAuth(ctx).userId`. Client body/path values are never accepted as the acting user.
- Followers and following lists are public. Friend requests, friends lists, and blocks lists are strictly private to the caller's own account.
- `SocialRuleError` is mapped via helper `mapSocialError`:
  - `self_relation` -> 422 Unprocessable Entity
  - `blocked` -> 403 Forbidden
  - `already_exists` -> 409 Conflict
  - `not_found` -> 404 Not Found
  - `invalid_transition` -> 409 Conflict
  - `not_authorized` -> 403 Forbidden
- When `socialGraphRepository` is absent, all `/v1/social/*` routes respond 503 Service Unavailable.
