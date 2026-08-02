# ADR-0068 — Direct 1:1 Messaging (Domain, Persistence & REST API)

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-02                                                         |
| **Scope**  | `@chess-platform/messaging`, `@chess-platform/persistence`, `@chess-platform/api` |

---

## Context

Milestone 10 ("Social & learning") increment 3 requires direct 1:1 player messaging between any two players.

Key architectural requirements:
1. Domain core (`@chess-platform/messaging`) must be pure and dependency-free, avoiding imports of `@chess-platform/social`.
2. Block enforcement: direct messaging must strictly respect social graph blocks in either direction without creating a hole in the block system.
3. Message lifecycle: support sending, editing (sender only), tombstone deleting (sender only; body cleared, timestamp retained), and per-participant monotonic read state.
4. Privacy & Authorization: non-participants must not distinguish whether a conversation ID exists or not (`not_found` error for both).
5. Relational persistence & indexing: PostgreSQL adapter with pair-level transaction locks (`pg_advisory_xact_lock`), single-statement idempotent upserts (`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`), monotonic read markers, FK indexing, and safe handling of `NaN` / `Infinity` pagination parameters.

---

## Decisions

### 1. Pure, Dependency-Free Domain Core (`@chess-platform/messaging`)

Created `@chess-platform/messaging` as an independent workspace package with zero runtime dependencies.

Instead of importing `@chess-platform/social`, block checking is inverted via a narrow port defined in the package:
```ts
export interface BlockChecker {
  isBlockedBetween(a: PlayerId, b: PlayerId): Promise<boolean>;
}
```
The persistence adapter and API layer wire `PgSocialGraphRepository` (or `InMemorySocialGraphRepository`) into this port.

### 2. Conversation Normalization & Idempotency

Conversations represent the unordered pair of two distinct participants. A conversation is keyed on the code-point normalized tuple `[participantA, participantB]` where `participantA < participantB`.

`getOrCreateConversation` executes an idempotent single-statement SQL upsert:
```sql
INSERT INTO messaging_conversations (id, participant_a, participant_b, created_at, last_message_at)
VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), $4, $4)
ON CONFLICT (LEAST(participant_a, participant_b), GREATEST(participant_a, participant_b))
DO UPDATE SET participant_a = messaging_conversations.participant_a
RETURNING id, participant_a, participant_b, created_at, last_message_at
```
This guarantees that concurrent initializations for the same pair resolve to the exact same conversation row without lost updates or race conditions.

### 3. Tombstone Deletion Model

Deleting a message (`deleteMessage`) sets `deletedAt` to the current timestamp and clears `body` to an empty string (`""`). It is never a hard delete, ensuring thread layouts stay consistent for both participants. Deleted messages:
- Cannot be edited (`invalid_transition`).
- Cannot be deleted twice (`invalid_transition`).
- Are excluded from unread count calculations.

### 4. Monotonic Read State & Unread Counts

Each participant maintains an independent `lastReadAt` timestamp per conversation (`messaging_reads`). Updating read status uses PostgreSQL `GREATEST`:
```sql
INSERT INTO messaging_reads (conversation_id, participant_id, last_read_at)
VALUES ($1, $2, $3)
ON CONFLICT (conversation_id, participant_id)
DO UPDATE SET last_read_at = GREATEST(messaging_reads.last_read_at, EXCLUDED.last_read_at)
RETURNING conversation_id, participant_id, last_read_at
```
This guarantees that delayed or out-of-order client requests can never move `lastReadAt` backwards.

Unread counts count non-tombstoned messages sent by the *other* participant with `sentAt > lastReadAt`. A participant's own messages never increment their unread count.

### 5. `not_found` and `not_authorized` are a security decision, not a style choice

Anything the caller is not a participant in reads as `MessagingRuleError('not_found')` → HTTP 404:
a conversation, its thread, marking it read, and any message inside it. `not_authorized` → 403 is
reserved for one case — a participant acting on the *other* participant's message in their own
thread. They can already list that message, so the 403 discloses nothing they did not have.

The distinction is load-bearing rather than cosmetic. A 403 where a 404 belongs is an existence
oracle: try an id, and the status code answers "is this real?" — and these ids are UUIDv7, which
embed a millisecond timestamp, so ids near a known one are cheap to enumerate rather than
astronomically unlikely to guess.

The first draft of this increment got it wrong in a way worth recording, because the port's own
contract contradicted itself: one clause promised `not_authorized` for a non-participant marking a
conversation read, while another promised `not_found` "so callers cannot distinguish". Both were
implemented, in different methods. `editMessage`/`deleteMessage` had the same hole for a message in
a stranger's thread. The port doc now states one rule and the tests assert the two answers a
stranger can get are identical — a real id and an invented one, checked side by side, because that
is the comparison an attacker makes and therefore the one the test has to make.

### 6. Relational Schema & Indexing (`0016_messaging.sql`)

Three tables support messaging persistence:
- `messaging_conversations`: Stores conversation metadata and `last_message_at`.
- `messaging_messages`: Stores messages, including `edited_at` and `deleted_at` timestamps.
- `messaging_reads`: Stores per-participant read markers `(conversation_id, participant_id, last_read_at)`.

Every referencing foreign key side is indexed — Postgres does not do it automatically, and without
it deleting one account sequentially scans these tables. But *dedicated* indexes are not what that
requires. An index on `(a, b, c)` serves any query leading with `a`, so the three list indexes
double as the FK indexes for `participant_a`, `participant_b` and `conversation_id`; only
`sender_id` and `participant_id` need one of their own. Narrow duplicates alongside the composites
would have cost a write on every insert and bought nothing. This is the only moment that choice can
be made: the migration runner records a checksum and refuses to re-run an edited migration, so
"clean it up later" is not available.

### 7. Lock order, and the deadlock it prevents

`getOrCreateConversation` takes the advisory pair lock, then locks the conversation row through its
`ON CONFLICT DO UPDATE`. `sendMessage` originally did the reverse — `SELECT ... FOR UPDATE` on the
conversation, then the pair lock — so each path held what the other wanted next. Postgres detects
the cycle and resolves it by killing one side with SQLSTATE 40P01; the user sees a 500 on a message
that should have sent.

The fix is not a bigger lock but a smaller one: `sendMessage` reads the conversation without
`FOR UPDATE`. Nothing between that read and the insert needs the row to hold still, because the
only column it writes is `last_message_at` and that write is `GREATEST(last_message_at, $1)` — an
atomic expression rather than a read-modify-write. `GREATEST` also earns its place independently:
conversations are ordered by that column, so a message committing late with an earlier timestamp
must not drag a thread backwards past messages already in it.

**The rule for anything added here later: take the pair lock before any row lock.**

The staged test holds the pair lock from outside, lets `sendMessage` get as far as it can, then
reaches for the conversation row. Against the original lock order it fails with `deadlock detected`
from Postgres itself.

### 8. One definition of the pair lock key

The advisory key expression lives in `packages/persistence/src/pg/pair-lock.ts` and both the social
graph and messaging adapters call it. This is not tidiness. `sendMessage` checks for a block by
reading `social_blocks` on a different connection, where at READ COMMITTED a block committing a
moment later is invisible; the only thing that closes that window is `block()` and `sendMessage()`
queueing behind the *same* advisory key. Duplicated, the two expressions can drift apart and the
mutual exclusion disappears with no test failing and no error raised — the block check simply
starts reading stale rows again. One definition makes that impossible rather than unlikely.

### 9. A player id that belongs to nobody is a 404, not a 500

`parseUuid` proves a `playerId` is well-formed. Nothing proves the player exists — so the `users`
foreign key is what catches it, and an unmapped SQLSTATE 23503 is not a `MessagingRuleError`, which
means `mapMessagingError` rethrows it and the route answers 500 for what is really "no such
player". `getOrCreateConversation` maps it to `not_found`.

The same hole was in the social graph adapter from increment 2, on `follow`, `block` and
`sendFriendRequest`, and is fixed here rather than left in place: it is the identical defect, one
file away, and the recognizer for both codes now lives in `pg/sqlstate.ts` so `'23503'` never has
to be recognized on sight at a call site.

Both fixes were checked by breaking the recognizer and re-running: the tests fail with the raw
`violates foreign key constraint` the user would otherwise have received.

**The adapter mapping alone was not enough, for a reason worth stating.** It makes Postgres answer
correctly, but the foreign key is the *only* thing performing that check — and the in-memory adapter
has no users table to key against, so it would cheerfully open a conversation with a player who does
not exist. Two adapters, two answers, from a port that says nothing about the question. So
`POST /v1/messages/conversations` checks the target through `repos.users` before calling the
repository, where the answer is the same whichever adapter is wired in; the FK mapping stays as the
backstop for a player deleted between the check and the insert.

The social routes from increment 2 have the same in-memory divergence, and it is left alone
deliberately: production wires `PgSocialGraphRepository`, so the FK mapping added above gives real
callers the right status, and the in-memory adapter is reached only by tests and fakes. Recorded
rather than silently expanded into.

### 10. `getOrCreateConversation` does not upsert

Increments 1–2 established a rule — idempotent writes are one `INSERT ... ON CONFLICT DO UPDATE`,
never a read followed by a conditional write — because `unfollow`/`unblock` delete without the pair
lock, so there is always a concurrent writer to race.

That reasoning does not carry here, and applying the rule anyway costs something real. Nothing
except this method inserts into `messaging_conversations`, every caller for a pair is queued behind
the pair lock, and rows leave only by `users` cascade, which takes the foreign-key path above rather
than racing this one. There is no second writer to defend against — and opening a chat that already
exists is the *common* case on this path, so `DO UPDATE SET col = col` would write a dead tuple and
a WAL record every time a user clicks a conversation they already have.

So the shape is a `SELECT`, then an `INSERT` only when absent. The rule from increment 2 still
stands where its premise does; it is the premise that has to be checked each time, not the rule
that has to be applied each time.

### 11. `listConversations` is one query

The natural shape — page the conversations, then ask each row for its unread count and last message
— is two extra round trips per row, so a 50-item inbox costs 101 queries and the cost scales with a
page size the *caller* picks. The unread count is a correlated subquery over the already-joined read
marker and the last message is a `LEFT JOIN LATERAL ... LIMIT 1` riding the same index the thread
listing uses.

---

## Consequences

- Direct 1:1 messaging is fully supported with domain purity, transactional persistence, and REST endpoints.
- Conversation opening and message sending serialize per pair on a shared advisory lock, in a fixed
  lock order. Message editing and deletion take a row lock only and no pair lock — they cannot
  cross a block boundary, so there is nothing for a pair lock to protect.
- Zero drift across OpenAPI schemas and REST route implementations.
