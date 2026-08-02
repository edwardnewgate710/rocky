# ADR-0071 — PGN Import/Export & Interactive Studies System (Domain, Postgres Adapter & REST API)

| Field      | Value                                                                             |
|------------|-----------------------------------------------------------------------------------|
| **Status** | Accepted                                                                          |
| **Date**   | 2026-08-02                                                                        |
| **Scope**  | `@chess-platform/studies`, `@chess-platform/persistence`, `@chess-platform/api`, `services/gateway` |

---

## Context

Milestone 10 ("Social & learning") increment 6 requires an interactive studies and PGN system across the pure domain core (`@chess-platform/studies`), Postgres persistence layer (`@chess-platform/persistence`), and REST API (`@chess-platform/api`).

Key architectural requirements:
1. Pure, dependency-free domain core (`@chess-platform/studies`) defining studies, chapters, move trees, PGN model, PGN parser, PGN serializer, ordering, and pagination.
2. Adjacency-list move tree model supporting main lines, variations, comments, and NAG (Numeric Annotation Glyph) annotations.
3. SAN move resolution through an abstract `PositionReader` port, separating domain logic from specific chess engine / board implementations.
4. Robust Postgres adapter (`PgStudiesRepository`) enforcing 7 core invariants, including advisory locking to prevent transaction deadlocks, partial unique index compliance during ownership transfers, and constraint-safe chapter reordering.
5. 21 REST API endpoints under `/v1/studies` with OpenAPI documentation, strict UUID parameter validation, route-level `MAX_PGN_BYTES` body size limits, and `STUDIES_ENABLED` opt-in feature flag.

---

## Decisions

### 1. Adjacency-List Move Tree Representation

Chapter move trees are stored as an adjacency-list graph (`study_tree_nodes` table with a `parent_id` self-referential foreign key pointing to `study_tree_nodes.id` with `ON DELETE CASCADE`).
- `parent_id = NULL` represents root moves in a chapter.
- A node with multiple children represents move variations (main line + alternative variations).
- Loading a chapter is one query for all its nodes, assembled in the adapter. Appending is one
  `INSERT`; annotating is one `UPDATE` by id. What it costs is the reverse: there is no way to fetch
  a single line without fetching the chapter, which is the right trade only because a chapter is
  bounded by what a person will actually annotate. A materialized path would make line queries cheap
  and every insert a rewrite of its descendants' paths; JSONB would make the whole tree one row and
  every annotation a full-document write.

**Two things about this representation are load-bearing and were both got wrong first.**

*A variation is a SIBLING, not a child.* `1. e4 e5 (1... c5)` means c5 could have been played
instead of e5 — both are replies to e4. Hanging the variation off the move it replaces produces a
tree that loads, renders, and is quietly wrong: it claims c5 answers e5. Nothing errors. Two
independent implementations here made exactly this mistake, which is reason enough to say so out
loud rather than assume the next reader finds it obvious.

*The first child is the mainline, so insertion order carries meaning.* `orderIndex` is assigned as
the current sibling count and export takes `children[0]` as the line actually played. The first
import implementation inserted each move's variations **before** the move itself, so the sideline
took index 0 and the move that was really played was demoted to a variation of itself. Every import
containing a `(...)` came back as a different game, silently. The move goes in first; its variations
follow, attached to the position *before* it.

### 2. SAN Resolution via `PositionReader` Port

Move validation and execution do not depend directly on board state internals. Instead, domain move application (`appendNode`, `importPgn`) delegates move legality checks and FEN calculation to a `PositionReader` port interface:
```typescript
export interface PositionReader {
  legalSans(fen: string): readonly string[];
  play(fen: string, san: string): string;
}
```
In `@chess-platform/api`, `CorePositionReader` implements this port using `@chess-platform/core`'s
`Position` engine.

**Why a port at all, and why this shape.** `Position` can *write* SAN (`toSan`) but cannot *read*
it — nothing in the codebase answers "which move is `Nbd7` here?". The obvious response is to write
a SAN parser, and the obvious SAN parser re-derives SAN's disambiguation rules: when a file letter
suffices, when a rank is needed, when both are. A second implementation of those rules is a second
opportunity to disagree with the first, and the disagreement would surface as an import that
silently picks the wrong knight.

So `resolveSan` generates the legal moves and matches each one's SAN as the engine writes it. It
cannot disagree with the writer by construction. Check and mate suffixes are ignored on both sides:
real exports disagree about `+` and `#`, those characters do not identify a move, and rejecting a
file over one would fail on a large share of genuine PGN for nothing.

### 2a. Two kinds of rejection, kept apart

A token that could not be SAN under any position is a malformed **file**: it fails while parsing,
with a byte offset and the offending token. A token that is well-formed SAN but not playable in the
position is a malformed **game**: it fails while resolving against the board, naming the move.

Collapsing them would leave whoever uploaded a thousand-line export guessing which of the two they
have. Both are tested, side by side, for that reason.

### 3. Visibility Levels (`public`, `unlisted`, `private`)

Studies support three visibility tiers:
- `public`: Visible to all users and anonymous callers. Included in public list queries (`GET /v1/studies`).
- `unlisted`: Accessible by direct study ID link (`GET /v1/studies/:id`), but excluded from public list/search queries unless caller is owner or collaborator.
- `private`: Strictly restricted to the study owner and authorized collaborators. Non-collaborators receive `404 Not Found` to prevent information leaks.

### 4. Transactional Advisory Locking & Deadlock Prevention

Concurrent operations on chapters, collaborators, or move trees acquire a transaction-scoped advisory lock on the study ID **before** acquiring any row-level `FOR UPDATE` locks:
```sql
SELECT pg_advisory_xact_lock(hashtextextended('study:' || $1::text, 0));
```
When operations receive a `chapterId` or `nodeId`, an unlocked query peeks the parent `studyId` first, acquires the advisory lock, and then executes row locking. This pre-row locking order guarantees zero transaction deadlocks under high concurrency.

### 5. Partial Unique Index & Ownership Transfer Demotion

The database schema enforces one owner per study via a partial unique index:
```sql
CREATE UNIQUE INDEX study_collaborators_one_owner_per_study
  ON study_collaborators (study_id) WHERE (role = 'owner');
```
`transferOwnership` demotes the current owner to `contributor` **before** promoting the target. The
order is the mechanism, not a preference: Postgres checks a partial unique index per row as each
`UPDATE` lands, so promoting first means two owners exist for an instant and the statement fails. It
cannot be deferred out of the problem either — only *constraints* may be `DEFERRABLE`, and a
constraint cannot be partial.

**The target must already be a collaborator**, otherwise `not_found`. Creating one on the fly reads
as convenience and is a one-way door: a transfer to a mistyped id would succeed, demote the real
owner to contributor, and leave the study owned by an account nobody can sign in as. Taking it back
is itself an owner-only action, so there is no path back.

### 5a. Chapter reordering has the same constraint, and needs a different answer

`study_chapters (study_id, order_index) WHERE deleted_at IS NULL` is unique, so swapping two
chapters by assigning their new indices directly fails the same way — verified rather than assumed:

```
ERROR:  duplicate key value violates unique constraint
DETAIL:  Key (study_id, order_index)=(1, 1) already exists.
```

`reorderChapters` therefore moves every active chapter to a negative index first and then writes the
final values, so no intermediate state collides. Deleting a chapter is the exception that needs no
such trick: compaction only ever shifts indices **downward**, and assigning them in ascending order
means the slot being written was vacated by an earlier iteration. That asymmetry is worth knowing
before someone "simplifies" the reorder to match the delete.

### 6. Upload-Path Parser Limits

This is an upload path, so the input is adversarial and the limits are part of the design rather
than hardening bolted on:

- **`MAX_PGN_BYTES` (5 MB)** is checked before a single token is read. An unbounded parser over
  untrusted input is a denial-of-service primitive.
- **`MAX_GAMES_PER_IMPORT` (64)** bounds how many chapters one request can create.
- **`MAX_VARIATION_DEPTH` (128)** bounds recursion. Without it a file of nothing but open
  parentheses produces a `RangeError` from inside the parser — a crash, not a rejection.

`POST /v1/studies/:id/import` enforces the byte cap at the route with
`Buffer.byteLength(pgn, 'utf8')` before the body reaches the parser, answering `413`. The parser
enforces all three again, because a repository is also callable from a worker that never passed
through a route.

---

## Consequences

- **Purity**: `@chess-platform/studies` remains 100% dependency-free and portable across web, CLI, and server.
- **Safety**: Postgres advisory locking and partial index handling eliminate deadlocks and constraint violations.
- **Opt-in Feature Flag**: `STUDIES_ENABLED=1` controls route activation in `bootstrap.ts` and worker runtime, serving `503 Service Unavailable` when unconfigured.
