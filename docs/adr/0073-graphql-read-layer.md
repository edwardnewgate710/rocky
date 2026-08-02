# ADR-0073 — Read-Only GraphQL Layer

| Field      | Value                                                                 |
|------------|-----------------------------------------------------------------------|
| **Status** | Accepted                                                              |
| **Date**   | 2026-08-02                                                            |
| **Scope**  | `@chess-platform/api`, `@chess-platform/persistence`                  |

---

## Context

Milestone 10 increment 8 closes the milestone with the piece deferred back in M4: a GraphQL
endpoint (`docs/PROJECT_STATE.md` §4.1, "REST-first for M4; GraphQL deferred to M10–M11").

The seven increments before this one produced seven subsystems — social graph, messaging, teams and
forums, achievements, studies, courses — each with its own REST surface. A profile screen wants a
player with their followers, their teams, their achievements and their studies. Over REST that is
five round trips whose results the client stitches together, and the stitching is where the client
learns things the server never meant to tell it.

The endpoint is `POST /v1/graphql`, behind `GRAPHQL_ENABLED=1`.

---

## Decisions

### 1. Queries only. No mutations, no subscriptions.

Every write in this system has an authorization rule that took an increment to get right, and in
three cases took a second pass to remove an existence oracle from. Exposing those writes through a
second transport means reviewing each one again against a different execution model. REST already
covers writes and its routes are the ones with the tests.

The parser refuses `mutation` and `subscription` by name, so this is a property of the code and not
a convention someone can drift away from.

### 2. Authorization belongs to the repositories, never to a resolver

Every M10 read port already takes an actor id and already decides what that actor may see. A
resolver's whole job is to pass `ctx.actorId` through and return the answer.

This is the load-bearing decision in the increment. The alternative — resolvers that check
visibility themselves — produces a second copy of every rule in ADRs 0066–0072, and the copy that
drifts is the copy that leaks. Concretely:

- `Query.study` calls `getStudy(id, actorId)`; the private-study rule is the adapter's.
- `Query.course` calls `getCourseBySlug(slug, actorId)`; the unpublished-course rule is the adapter's.
- `Player.studies` passes the profile owner as `ownerId` and the **caller** as the actor. Passing the
  owner as the actor is the obvious bug and it lists every private study to anyone who asks, so
  there is a test that fails when the two are swapped.

**There are no exceptions, and one was removed to keep it that way.** The first version of
`Query.player` filtered out players who had blocked the caller. Review caught it, and it was wrong
twice over: ADR-0066 §3 scopes a block to "neither party may follow or send friend requests to the
other" — an *interaction* rule — and no REST read consults `isBlockedBetween`, so
`GET /v1/users/:handle` serves that profile to anyone. The filter was GraphQL inventing a visibility
rule the domain does not have, which is precisely the second copy this decision exists to prevent.
It is gone, and `packages/api/test/graphql.test.ts` now asserts that GraphQL and REST return the
*same* profile for a blocked pair, so the two fail if they ever drift apart.

To make the equivalent mistake harder, the repository bundle is not a field on `ResolverContext`.
Resolvers reach subsystems only through accessors that either return the repository or fail the
field. A resolver holding the bundle can write `if (repos.social)` and silently skip a check when
the subsystem is switched off — turning a disabled feature into a quietly weakened rule. The
accessors have no such branch.

### 3. `not_found` and `not_authorized` are reported identically

Every M10 domain error type carries both codes. `toFieldError` maps both to the single message
`not found`.

Distinguishing them would rebuild the existence oracle that increments 3 and 4 removed from the REST
routes (ADR-0069 §4): an unauthorized caller who can tell "this exists but is not yours" from "this
does not exist" can confirm ids by reading the error text. Ids are UUIDv7 and therefore partly
ordered, which makes confirmation cheaper than it looks.

This rule is unit-tested directly rather than through the endpoint. An end-to-end assertion cannot
see it — the studies adapter already answers `not_found` for an unauthorized read, so the
integration test passes whether or not GraphQL flattens the codes. Only the direct test fails when
the rule is removed, which was found by mutation-testing the integration test and watching it pass
against deliberately broken code.

### 4. Batching is per request, and the cache lifetime is the point

`BatchLoader` coalesces every `load()` issued in one microtask tick into a single call, and caches
per key.

**The cache must not outlive the request.** Its key is an id; an id says nothing about who was
allowed to see the row. A loader shared across requests would eventually serve one caller a row that
was fetched under another caller's authority. `createLoaders` is therefore called inside the request
handler and referenced by nothing that outlives it.

Coalescing depends on the executor resolving sibling fields and list items with `Promise.all`. A
sequential executor flushes a batch of one per node and silently restores the N+1 — the two files
are coupled, and the call-count test is what keeps them honest.

**This required a new repository method.** `UsersRepository.findByIds` was added, because dedup
alone cannot bound the call count: 200 distinct followers are 200 distinct ids, and without a
multi-key read that is 200 queries no loader can fold. The Postgres implementation filters
non-canonical ids before `= ANY($1::uuid[])`, because the cast applies to the whole array and one
malformed element would fail the read for every other id batched with it (SQLSTATE 22P02) — a case
the in-memory `Map` cannot reproduce, so it is pinned by a DB-gated test.

Today there is exactly one loader, for players. That is the only relationship in this schema where
the same entity is reached from many nodes.

### 5. Three limits, enforced before execution

A GraphQL endpoint without limits is a denial-of-service primitive the caller gets to program. Each
bound closes a hole the others do not:

| Limit | Default | What it stops |
|---|---|---|
| Depth | 8 | Recursive nesting — work multiplied without lengthening the document |
| Complexity | 1000 | Breadth: many list fields, each with a large `limit`. List fields multiply their subtree by the page size they will request, so raising `limit` raises the bill |
| Aliases | 50 | The same field requested hundreds of times. Depth and complexity each see one field; aliasing makes it a hundred |

Validation and costing produce the **execution plan**, so there is no code path that resolves a
field without having costed it first. A limit enforced during execution is not a limit — the work it
was meant to prevent has already happened. Each limit test asserts the repositories were *not
called*, which is the only assertion that can tell the two apart.

Two smaller bounds sit in the parser: a 16 KB query cap and a maximum argument-value nesting of 8,
so a pathological `[[[[…]]]]` cannot exhaust the stack before any limit has run.

### 6. Introspection is off by default, and what it returns is ours, not the spec's

Any `__`-prefixed field is refused unless `GRAPHQL_INTROSPECTION=1`. Rejection messages name the
field the caller wrote but never list the fields that exist, so a rejected query cannot be used to
enumerate the schema while introspection is off.

When enabled, `__schema` returns `{ queryTypeName, types { name fields { name type list } } }`.
**This is not spec-compliant introspection**: it reports each field's type as a plain string and says
nothing about nullability, arguments, or scalar types, because the schema model does not record
them. A client expecting the standard `__Schema` shape will not find it. It exists so our own tooling
can enumerate what is queryable; calling it GraphQL introspection would be describing a feature this
code does not have.

### 7. A missing subsystem is a field error, not a request error

Each M10 repository is independently feature-flagged. A query selecting `team` and `study` with
studies switched off answers `team` and reports an error on `study`. Failing the whole request would
let one unconfigured subsystem take out every unrelated field in every query.

### 8. No new runtime dependency

The parser, validator, executor and loader are written here — roughly 1,800 lines across eight
files in `packages/api/src/graphql/`, a large share of it comment. This repo keeps its
domain packages dependency-free deliberately, and a query parser is the one place where a
dependency's behaviour becomes our attack surface. The accepted subset is small enough to own.

**What the subset excludes**, each refused with a clear parse error rather than misparsed:

- **Fragments**, named and inline. A fragment may spread another fragment, so a document can describe
  a cyclic or exponentially-expanding selection *before* anything measurable as depth exists.
  Bounding that safely needs cycle detection and expansion accounting; refusing it needs one line,
  and no client asks for fragments today.
- **Directives** (`@include`, `@skip`) — no present-day caller.
- **Block strings** — no argument in this schema takes prose.
- **Multiple operations per document** — silently executing the first is worse than refusing.

---

## Consequences

- A profile view is one round trip instead of five, and the client no longer stitches together
  authorization decisions it should not be making.
- Adding a field to the schema is a resolver plus a cost. Adding one that reads a repository without
  passing the actor is a hole, and the reviewer's job is to check exactly that.
- The limits are conservative. Raising them is a deliberate change with a test to update, which is
  the intended friction.
- Anyone extending this to mutations must revisit decision 1: the read-only property is what makes
  the rest of these decisions sufficient.

## Verification

- `packages/api/test/graphql.test.ts` — 29 tests. Eight rules were mutation-tested: each was broken
  in turn and the covering test confirmed to fail. That pass is what caught the flattening test
  described in decision 3 proving nothing.
- `packages/persistence/test/users-batch.integration.test.ts` — DB-gated; verified to fail when the
  UUID filter is removed.
- `npm run build`, `npm run lint`, `npm run check:build-order`, `npm test` clean from the repo root;
  with Postgres, `persistence` 39/39 and `api` 350/350.
