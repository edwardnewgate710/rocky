# ADR-0066 — Pure-domain social graph core (@chess-platform/social)

| Field      | Value                      |
|------------|----------------------------|
| **Status** | Accepted                   |
| **Date**   | 2026-08-01                 |
| **Scope**  | `packages/social`          |

---

## Context

Milestone 10 ("Social & learning") begins with the social graph: directed follow edges, symmetric friend requests with consent, and user blocking. Following the design principles of `@chess-platform/search` (ADR-0049–ADR-0052), this increment lays the foundation as a pure, dependency-free domain package (`@chess-platform/social`).

The domain logic must remain isolated from HTTP statuses, SQL schemas, network I/O, or system clock calls (`Date.now()`). All timestamps are supplied as parameter inputs (`at: Date`), guaranteeing deterministic execution across all environments and unit tests.

Crucial domain questions required formal architectural decisions:
1. What happens when a user blocks another user while existing relationships (follows, pending requests, active friendships) exist?
2. How should crossing friend requests (A sends to B while B has a pending request to A) be handled?
3. How are entity IDs and timestamps generated and handled?
4. How should the domain port (`SocialGraphRepository`) be structured to accommodate future async storage adapters?
5. How is deterministic total ordering achieved across paginated list queries?

## Decision

### 1. Pure, dependency-free domain package (`@chess-platform/social`)
Created `@chess-platform/social` in `packages/social/` with zero runtime dependencies (only `typescript` and `@types/node` as devDependencies, matching `@chess-platform/search`).

### 2. Relation primitives & self-relation guard (`src/relation.ts`, `src/errors.ts`)
- `PlayerId` is defined as a string alias.
- `assertDistinct(a, b)` enforces that `a !== b`, throwing `SocialRuleError('self_relation')`. All public mutation functions execute this assertion first.
- `normalizePair(a, b)` normalizes pairs into a canonical ascending tuple `[min(a,b), max(a,b)]`, so a symmetric relation cannot be recorded or answered differently depending on which player is named first. `involvesPair(request, a, b)` in `src/friendship.ts` is its one consumer: friend requests are stored with a direction but must be *found* without one, whether the question is "are these two friends", "is there already a request between them", or "which rows must this block tear down".
- Blocks do **not** use it. A `BlockEdge` is genuinely directed — the record has to say who blocked whom so the right person can undo it — so `isBlockedBetween` tests both directions explicitly rather than collapsing them.
- `SocialRuleError` exposes a `code: SocialErrorCode` string property (`self_relation`, `blocked`, `already_exists`, `not_found`, `invalid_transition`, `not_authorized`). Upper layers (e.g. REST API in Increment 2) map error codes to protocol HTTP statuses without the domain learning about HTTP.

### 3. Block precedence ("Block beats everything", `src/block.ts`)
A block is recorded as a directed edge `BlockEdge` (`blockerId`, `blockedId`, `blockedAt`), but its enforcement is strictly symmetric: neither party may follow or send friend requests to the other (`isBlockedBetween`).

Calling `block(blockerId, blockedId, at)` atomically tears down all existing relations:
- Removes follow edges in both directions (`blockerId -> blockedId` and `blockedId -> blockerId`).
- Transitions any `pending` friend request between the pair:
  - If `blockerId` was the requester, the request transitions to `cancelled` with `respondedAt: at`.
  - If `blockerId` was the addressee, the request transitions to `declined` with `respondedAt: at`.
- Transitions any active `accepted` friendship to `ended` with `respondedAt: at`. Historical request records are retained for auditability; they are never deleted.

### 3a. `ended` is its own status, not a reuse of `declined`
`FriendRequestStatus` is `pending | accepted | declined | cancelled | ended`. The three terminal
states are kept apart because they answer different questions afterwards: the addressee refused,
the requester withdrew, or the friendship existed and a block tore it down. Folding the last into
`declined` would make the record claim the addressee refused a request they had in fact accepted —
and this ADR argues in decision 5 that preserving exactly that kind of history is worth rejecting a
convenience elsewhere. The two positions have to agree.

The transition lives in `terminateFriendship(request, at)` in `src/friendship.ts`, **not** in the
repository. It is deliberately not a `FriendRequestAction`: no party requests it, and it is the only
move out of a state `applyFriendRequestAction` treats as terminal. Keeping it beside the state
machine means every status transition the package permits is defined in one file; a repository that
assembled the record itself would be writing around those rules, and the next such shortcut would
not be reviewed against them at all.

### 4. `unblock` restores nothing
`unblock(blockerId, blockedId)` removes the block edge. It explicitly does **not** restore previously torn-down follow edges or friendships. The pair must re-establish their relationships manually.

### 5. Reject crossing friend requests (`src/friendship.ts`)
`sendFriendRequest` throws `SocialRuleError('already_exists')` if a `pending` request already exists between the pair in **either** direction.

Auto-accepting crossing requests was rejected because doing so would create two request rows where only one was ever responded to, corrupting the historical audit trail regarding who accepted whom. A client receiving `already_exists` for an opposite request is informed that a request exists and should accept the pending incoming request instead.

### 6. Caller-supplied request IDs and timestamps
All entity IDs (`request.id`) and dates (`at: Date`) are supplied by the caller. No non-deterministic I/O calls (`crypto.randomUUID()` or `Date.now()`) exist in domain logic. `sendFriendRequest` throws `SocialRuleError('already_exists')` if the supplied request ID is already present.

### 7. Async-from-the-start repository port (`src/repository.ts`)
Defined `SocialGraphRepository` with `Promise`-returning signatures from the beginning, avoiding retrofitting costs when persistence adapters land in Increment 2. `InMemorySocialGraphRepository` implements this port with Map and Array backing stores.

### 8. Deterministic tie-broken list ordering & pagination (`src/ordering.ts`, `src/pagination.ts`)
`paginate<T>(all, options)` enforces non-negative clamping for `limit` and `offset`. Every list
query sorts before paginating, through one shared comparator in `src/ordering.ts`:

- Primary: timestamp descending (`followedAt`, `createdAt`, `respondedAt`, `blockedAt`).
- Tie-break: counterpart `PlayerId` ascending.

The tie-break is mandatory rather than tidy. Timestamps collide routinely here — a single `block`
call stamps several torn-down relations with one `at` — and a sort with no total order leaves those
rows in an arbitrary, unrepeatable sequence. Paginating an unrepeatable sequence drops and
duplicates rows.

**"Ascending" means code-point order, not locale collation.** `compareIds` compares with `<`/`>`;
the first draft of this package used `String.prototype.localeCompare`, which orders `'a'` before
`'B'` and therefore disagrees with `<` on any id set that mixes case or non-ASCII. It also
disagreed with `normalizePair`, which was already using `<` — two different meanings of "ascending"
inside one package. The unit tests could not catch it because every fixture id was lowercase ASCII,
where the two orders coincide.

The consequence for Increment 2 is concrete: the SQL must be
`ORDER BY <timestamp> DESC, <counterpart_id> COLLATE "C" ASC`. A default collation would order rows
differently from the in-memory adapter, which is the same class of drift the tie-break exists to
prevent.

### 9. Authorization must not depend on the type system

`applyFriendRequestAction` looks the action up in one table that pairs the resulting status with the
side entitled to take it, and throws `invalid_transition` for anything not in that table.

The first draft used an `if`/`else if` chain for authority and a separate ternary chain for the next
status. An action matching neither branch therefore **skipped the authority check entirely and fell
through to `cancelled`** — so any string other than `accept` or `decline` cancelled a pending request
with no check on who sent it. TypeScript excludes that, but increment 2 puts this value in a REST
request body, and a cast, a JavaScript caller or a deserialized payload all cross that boundary
unchecked.

The lookup uses `Object.hasOwn` rather than a truthiness test: `TRANSITIONS['toString']` returns an
inherited function from `Object.prototype`, so a bare existence check waves through `toString`,
`constructor` and `__proto__`. That was a real hole in the first version of this fix, and the tests
cover those three keys by name.

### 10. Pagination defines `NaN`, because that is the shape malformed input arrives in

`Math.max` propagates `NaN`, so a `NaN` offset made `slice` return nothing while `total` still
reported the true count — a caller saw "47 results" above an empty list, with no error raised
anywhere. `Number(queryParam)` yields `NaN` for unparseable input, so this is not a theoretical
value.

`paginate` now normalizes explicitly: a `NaN` offset is treated as absent, a `NaN` limit clamps to 0
(an unparseable page size means "nothing", not "everything" — the safer failure, and consistent with
a negative limit), and fractions truncate. `Infinity` needs no special case: an infinite limit
already means "all remaining" and an infinite offset already means "past the end".

`@chess-platform/search` has the same latent hole in its own `paginate`, but it is unreachable —
`parseLimit` (`packages/api/src/http/validate.ts:120`) rejects non-integers with a 422 before any
value gets there. It is left alone rather than changed as a side effect of this increment.

## Consequences

- The social graph domain rules are fully deterministic, pure, and testable without mocks or database dependencies.
- Increment 2 HTTP layer can map `SocialErrorCode` values directly to HTTP status codes (e.g. `blocked` -> 403, `self_relation` -> 422, `already_exists` -> 409, `not_found` -> 404).
- Postgres adapters in Increment 2 reproduce the ordering with
  `ORDER BY <timestamp> DESC, <counterpart_id> COLLATE "C" ASC` — the explicit collation is part of
  the contract, not a detail (see decision 8).
- **Nothing populates this graph yet.** The package is domain logic and an in-memory adapter; there
  is no table, no route and no wiring into `bootstrap.ts`. It is not reachable by a user until
  Increment 2, and the root `build:server` chain is deliberately left untouched for that reason.
