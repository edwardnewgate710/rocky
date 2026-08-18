# 119. Truthful OpenAPI 3.1 Nullability, and All-or-Nothing Rate-Limit Admission

Date: 2026-08-18

## Status

Accepted

Corrects two cross-cutting defects that predate and outlive [ADR-0113](0113-analysis-endpoint.md)
(analysis endpoint), [ADR-0115](0115-move-explanation-api.md) (move explanation) and
[ADR-0118](0118-mistake-prediction.md) (mistake prediction), all three of which inherited the second
one.

## Context

Two things were wrong in ways no test could see, because in both cases every test asserted the
behaviour the defect did not change.

### 1. The published contract described 47 fields as non-nullable, and sent them null

`packages/api/openapi.json` declares `"openapi": "3.1.0"`, and 47 of its fields carried
`nullable: true`.

`nullable` is an OpenAPI **3.0** keyword. It existed because 3.0's schema dialect was JSON Schema
Draft 4, which had no way to express a union of a type and `null`. OpenAPI 3.1 dropped the dialect
in favour of JSON Schema 2020-12, where `type` takes an array — and dropped `nullable` with it. It
is not a 3.1 keyword, not an alias for anything, and not reserved: it is an unrecognised annotation
that every conforming reader ignores.

So the document did not say those fields were nullable. It said they were **not** nullable, and
carried a note nobody reads. A client generated from that spec types `PublicUser.country` as
`string`, and is wrong for every user who has not set a country;
`MistakePredictionResponse.centipawnLoss` as `integer`, and is wrong for every delivered checkmate —
the exact value ADR-0118 went to some trouble to make honestly nullable on the server side.

Two of the 47 were wrong a second way, which the migration exposed rather than introduced.
`LiveBoard.status.winner` and `TeamDetailView.viewerRole` are nullable **enums**, and `enum` is an
independent constraint rather than a refinement of `type`. `{type: ['string','null'], enum: ['w','b']}`
admits neither `'x'` nor `null` — the enum rejects what the type just allowed. Widening only the type
would have moved the lie rather than removed it.

Separately: nothing verified that the committed `openapi.json` matched what the server actually
serves. No test, no CI step. The artifact could have drifted a whole release behind and every suite
would have stayed green.

### 2. Multi-bucket rate limiting charged the first bucket before asking the second

The `RateLimiter` port offered `check(key, limit)`, which decided and consumed in one step. A route
guarded by two buckets therefore called it twice:

```ts
const userCheck = await rateLimiter.check(userKey, perUser);   // charges
if (!userCheck.allowed) throw HttpError.rateLimited(...);
const ipCheck = await rateLimiter.check(ipKey, perIp);         // charges
if (!ipCheck.allowed) throw HttpError.rateLimited(...);        // ...and the user already paid
```

Six routes had that shape: `/v1/auth/login` (ip, handle), `/v1/auth/password-reset/request`
(ip, target), `/v1/auth/webauthn/login/options` (ip, handle), `/v1/analysis` (user, ip),
`/v1/analysis/mistake-prediction` (user, ip) and `/v1/ai/move-explanation` (user, ip).

The victim is concrete. On a shared NAT — a university, an office, a mobile carrier — the per-IP
bucket saturates from collective traffic. Every co-located account then spends its own private
per-user quota at full speed on requests the IP ceiling never lets run, receiving nothing but 429s
and having paid for each one. Within a minute a user who made no successful request has no quota
left.

Reversing the order does not fix this, it only moves the victim: with IP first, one abusive account
drains the bucket its neighbours share before its own limit stops it.

A third, adjacent instance turned up in the same audit. `/v1/analysis` charged quota **above** its
body parsing, so a malformed FEN or an out-of-range `multiPv` — neither of which reaches an engine —
cost a slot. That is the ordering the Qodo review of PR #134 established for the two endpoints
written after it; this one predates it and never received the same treatment.

## Decision

### Nullability: `type: [T, 'null']`, built by one helper, with the keyword unrepresentable

`JsonSchema.type` in `packages/api/src/openapi/types.ts` widens to `SchemaType | readonly SchemaType[]`,
`enum` widens to admit `null`, and `nullable?: boolean` is **removed from the interface**. That
removal is the load-bearing part: the keyword cannot come back by accident, because there is no
longer a property to set. `tsc` rejects it.

The single replacement is `nullable(schema)`, in that same file so the ban and its remedy are one
thing to read:

- a typed schema widens to a union, carrying `format`, `minimum`, `description` and every other
  sibling through untouched;
- a schema with an `enum` **also gains `null` as a member**, for the reason above;
- a `$ref` becomes `anyOf: [ref, {type: 'null'}]`. JSON Schema 2020-12 permits `$ref` siblings, so
  `{$ref, type: ['object','null']}` is syntactically legal and semantically wrong — it asserts both
  constraints at once, and `null` fails the referenced schema. No such field exists in the document
  today; the helper handles it correctly rather than waiting to be wrong later.

All 47 sites were converted (35 authoring sites in `packages/api/src/openapi/schemas.ts`, two of
which are the shared `nullableString` / `nullableInt` constants that expand to 14 of the 47), and
`packages/api/openapi.json` was regenerated by `npm run openapi`. It is never hand-edited.

**Nullable is not optional, and this change touched only nullability.** A nullable field is always
present and may hold `null`; an optional field may be absent. They are independent axes, and the
document contains all four combinations — `CreateSeekRequest` alone carries three of them. No
`required` array was altered. The generated diff was verified structurally, key by key, to be
exactly the type-union rewrite: no key added, none removed, no constraint dropped.

### Rate limiting: one admission method, taking every bucket at once

`RateLimiter.check(key, limit)` is **replaced** by:

```ts
admit(requests: readonly RateLimitRequest[]): RateLimitResult | Promise<RateLimitResult>
```

A `peek()` / `commit()` pair was rejected. Two calls cannot be made race-free against each other,
and an API that looks two-phase while its halves race is worse than the sequential code it replaces
— it moves a visible bug to an invisible one. Handing every bucket to one call lets the
implementation decide before it commits, which is the only place the guarantee can actually live.

Deleting `check` rather than keeping it alongside `admit` is deliberate and is the structural half
of the fix: with no single-key consuming method on the port, **sequential multi-bucket consumption
is not expressible**. The same reasoning as ADR-0118's engine composition, where making a second
engine pool unrepresentable did more than any test could.

The contract, held by tests against both implementations:

- **All or nothing.** Every bucket admits and every one is charged, or none is.
- **Distinct keys.** A key may appear at most once; naming it twice throws.
- **Atomic.** Two concurrent requests racing for one remaining slot: exactly one wins.
- **Rejection is free.** A refused request charges nothing, anywhere.
- **Order-independent.** The answer does not depend on the order of `requests`.

`InMemoryRateLimiter.admit` is **synchronous**, and that is where its atomicity comes from: the
event loop runs it to completion, so nothing observes the gap between measuring and committing. It
measures every bucket without writing — including declining to roll over a lapsed window, which
would be a write on the rejection path — and commits only if all admit.

`PgRateLimiter.admit` makes each bucket a conditional upsert: the `WHERE` on the conflict action
lets the update happen only if the request fits, so a refusal returns no rows and **writes
nothing**. The row lock is still taken, which is what serialises two requests racing for one slot.
Two or more buckets then go in one transaction that rolls back if any refuses, with keys **sorted**
first: `ON CONFLICT DO UPDATE` locks the conflicting row, so two transactions touching the same
pair in opposite orders would deadlock, and a total order over the keys removes the cycle. A single
bucket keeps a one-statement path that takes no pooled client at all — five of the eleven limited
routes are single-bucket, and `/v1/auth/refresh` is the hottest of them.

The first version of this incremented unconditionally and decided afterwards, clamping the counter
at `maxRequests + 1`. That left a refusal persisting a charge for a request that never ran — a
direct contradiction of the "rejection is free" clause above, and a disagreement with the
in-memory limiter, which writes nothing. Raising a limit underneath such a bucket, as during a
rolling configuration change, then handed the next caller fewer slots than the new limit promised.
Raised in the Qodo review of PR #137 and fixed by the conditional upsert, which needs no clamp
because the counter can no longer pass the cap.

The wait a refusal reports is read in a **separate statement**. Carrying it in a trailing
`SELECT` inside the upsert looked tidier and was wrong: `ON CONFLICT DO UPDATE` can inspect a row
committed by a concurrent transaction after the statement began — Postgres steps outside the
statement snapshot for exactly that purpose — while an ordinary `SELECT` in the same statement
cannot. A request that lost a race to create the bucket was therefore refused by a row its own
`SELECT` could not see, and reported a one-second fallback for a bucket that stayed full for the
rest of its window; against a ten-minute window it advised 1s instead of 600s. Reproduced against
PostgreSQL 16 before the fix. Under READ COMMITTED every statement takes a fresh snapshot, so a
second statement — issued before any `ROLLBACK` — sees the row that actually refused. Raised
independently by both the Qodo and CodeRabbit reviews of PR #137.

The transaction also sets `lock_timeout` (2s) and `statement_timeout` (5s). The critical section is
one upsert per bucket and should finish in microseconds; the timeouts bound the pathological case,
because a transaction stuck behind a saturated hot key holds a pooled client and that pool is
shared with every repository in the process. Without them, contention on one rate-limit row could
become connection starvation across the API. Also raised in the Qodo review.

### `Retry-After`: the longest truthful wait

When several buckets refuse at once, `retryAfterSeconds` is the **maximum** among them. Returning
the first one found would be order-dependent, and returning the shorter would send the client back
to a second refusal — advice that costs them a request to discover is wrong. Every existing
assertion in `packages/api/test/rate-limit.test.ts` was unaffected, because in each of those cases
only one bucket is saturated.

Status codes, error codes, the `Retry-After` header and the response body shape are otherwise
unchanged. This is a fix to accounting, not to the public contract.

### Validation still comes before the charge

`/v1/analysis` now parses its body before it admits, joining the two endpoints that already did.
The order on the expensive routes is: authenticate → structural validation → domain validation →
combined admission → engine or provider work.

`/v1/auth/register` deliberately keeps its charge **above** validation. That is an abuse-control
decision rather than an oversight — the point of a registration limit is to bound attempts from an
address whether or not they are well formed — and it is single-bucket, so the defect this ADR
corrects does not apply to it.

## Blast-radius audit

Every production caller of the port, classified:

| Route | Buckets | Class |
|---|---|---|
| `POST /v1/auth/login` | ip, handle | multi — migrated |
| `POST /v1/auth/password-reset/request` | ip, target | multi — migrated |
| `POST /v1/auth/webauthn/login/options` | ip, handle | multi — migrated |
| `POST /v1/analysis` | user, ip | multi — migrated, plus charge moved below validation |
| `POST /v1/analysis/mistake-prediction` | user, ip | multi — migrated |
| `POST /v1/ai/move-explanation` | user, ip | multi — migrated |
| `POST /v1/auth/register` | ip | single — unaffected; charge stays above validation by design |
| `POST /v1/auth/refresh` | ip | single — unaffected |
| `POST /v1/auth/webauthn/register/options` | ip | single — unaffected |
| `POST /v1/auth/webauthn/register/verify` | ip | single — unaffected |
| `POST /v1/auth/webauthn/login/verify` | ip | single — unaffected |

All eleven now go through one local `admit` helper in `packages/api/src/routes.ts`, which is the
file's only caller of `rateLimiter.admit`.

`RateLimiter` in `packages/ai-orchestrator/src/rate-limiter.ts` is a **different abstraction** with
the same name — per-user and global counters for provider calls, not the HTTP admission port. It
has its own semantics and no multi-bucket sequencing, and is out of scope.

## Consequences

**Good.** The published contract is now true for 47 fields, including the two nullable enums it was
wrong about twice over. A client generated from it types nullable fields correctly. The committed
artifact is pinned to the generator by a test, so it can no longer drift. Quota is charged only for
requests that run, so a saturated shared address no longer drains its neighbours' private budgets.
`Retry-After` no longer advises a wait that will not be long enough.

**Costs.** `admit` is a wider signature than `check`, and single-bucket callers pay one array
literal for it. Multi-bucket admission on Postgres costs a transaction — three round trips instead
of two, and a pooled client checked out for their duration rather than a single pooled statement —
on five auth and analysis routes; the single-bucket fast path keeps the hottest route at one
statement and no checkout. The transaction is two upserts and sub-millisecond, so the checkout is
short, but it is a second resource the route now holds and worth naming before it is measured under
load.

The row locks have a capacity consequence of their own, raised in the CodeRabbit review of PR #137.
Every multi-bucket admission holds a lock on each bucket row until COMMIT or ROLLBACK, so a hot
shared key — a per-IP bucket behind a large NAT is the obvious one — serialises every concurrent
admission naming it, across all replicas, refusals included. That is inherent to counting correctly
in one place rather than a defect, and the critical section is two statements long. It is named here
because it is the thing to look at first if admission latency ever becomes interesting, and because
the shared-NAT case is exactly the population this increment was fixing. `nullable(...)` is a call where a property used to be, which is slightly more to read at each
site and the reason the constants `nullableString` and `nullableInt` were kept.

**Duplicate keys are refused, not resolved.** An earlier draft of this contract said a key named
twice is charged twice. It reads as reasonable and is not order-independent: given
`[{k, max: 5}, {k, max: 1}]` the second entry measures a cumulative two units against a limit of
one and refuses, while `[{k, max: 1}, {k, max: 5}]` admits — the same list in two orders giving two
answers, in direct contradiction of the order-independence property. Both implementations had it.
No caller wants several units of one bucket, so the case throws rather than being given a
resolution rule nobody asked for. Raised in the Qodo review of PR #137.

**A deliberate consequence worth naming.** A login refused by the per-handle bucket no longer also
charges the per-IP bucket. Under the old code an attacker exhausting one handle would burn their own
IP quota doing it, and so lock themselves out of other handles sooner. That was a side effect of the
defect, not a designed property, and it fell on shared addresses at least as hard as on attackers.
The property that actually matters is unchanged: at most N attempts per IP per window reach the auth
service, because attempts against *different* handles are admitted by both buckets and charged to
both. What is no longer charged is work that was never done.

**Not addressed.** Fixed-window limiting still permits a 2× burst across a window boundary; that is
unchanged and is a separate decision. A `null` in a `oneOf` branch has no representation problem but
also no instance in this document, so nothing was built for it.

## Guards

- `packages/api/test/openapi-nullability.test.ts` — the served document is 3.1 and contains **zero**
  `nullable` keys anywhere; each shape (string, integer, `format`, enum) is pinned; all four
  optional/nullable combinations are asserted against real fields; every nullable schema in the
  document is checked in bulk, with the count pinned at 47 so a silently dropped one fails; the
  committed `packages/api/openapi.json` is asserted equal to the generator's output; and `nullable()`
  itself is exercised for the array, object, `$ref` and idempotence cases the document does not
  contain.
- `packages/api/test/rate-limit-atomicity.test.ts` — all-or-nothing in both directions, order
  independence, the longest-wait retry policy, a lapsed window not rolled over on the rejection path,
  a duplicate key refused, capacity never exceeded, a concurrent race for the final slot, and
  the defect end-to-end on `/v1/auth/login` and `/v1/analysis`.
- `packages/api/test/rate-limit-structure.test.ts` — `rateLimiter.admit` has exactly one call site;
  no handler admits twice; each of the six multi-bucket routes names both its buckets inside one
  call; and the three expensive routes parse before they charge. It reads `routes.ts` through the
  TypeScript parser rather than by matching text: a guard standing in for a deleted method should
  not itself be approximate, and two text-matching versions were each shown to miss a real evasion
  during the CodeRabbit review of PR #137.
- `packages/api/test/pg-security.integration.test.ts` — the same all-or-nothing, last-slot and
  longest-wait properties against a **real** PostgreSQL server under concurrency, including two
  requests handing the same key pair over in opposite orders to prove the sort is what prevents a
  deadlock, a refused single-bucket admission asserted against the *stored* counter, a duplicate
  key, and the loser of a bucket-creation race being told the real remaining window. Gated on
  `DATABASE_URL`, and run by the `postgres integration` CI job. Verified by mutation: removing the
  transaction, committing a refusal, removing the sort, reporting the first wait instead of the
  longest, removing the conditional guard so a refusal writes again, accepting duplicate keys, and
  moving the retry lookup back inside the admitting statement are each caught here and by nothing
  else.
- `packages/api/test/pg-observer.ts` and its focused tests — the deterministic synchronisation the
  creation-race test uses, added in the follow-up below.

## Follow-up (2026-08-18, M15 Increment 7): the creation-race test now proves it raced

The bucket-creation-race test above shipped in Increment 6 sequenced by a wall-clock sleep: start
the losing admission, `setTimeout(…, 300)`, then commit the holder. That was raised as a nitpick in
the CodeRabbit review of PR #137 and is recorded here because it was a real hole, not a style
preference.

A sleep cannot fail loudly. If the losing statement had not yet reached the server when the holder
committed, the race simply did not happen — and the test passed anyway, because both orderings end
with the same stored row, the same refusal and the same `Retry-After`. No assertion in the test
could distinguish them. So the test that existed to prove the snapshot fix worked could go green
without exercising the snapshot at all, and would have kept doing so under CI load, which is
exactly when the ordering is least likely to hold.

That is now measured rather than assumed. `packages/api/test/pg-observer.ts` polls
`pg_stat_activity` from a third connection and resolves only once the specific backend running the
admission is reported blocked, on a lock of the expected kind, **by the specific backend holding
the row**. All three conditions are required: `wait_event_type = Lock` alone would also match a
lock no part of the test created.

The lock is a `transactionid` lock, not a row lock. A conflicting `ON CONFLICT` waits on the
*transaction* that inserted the uncommitted tuple, because until that transaction ends nobody can
say whether the key is taken. A helper looking for a literal row lock would have waited forever;
this was verified against PostgreSQL 16.14 rather than reasoned about.

The wait is bounded (5s default) by a ceiling that sits **outside** the polling loop. The first
version read the clock only between polls, which bounds nothing if a poll never returns: an
exhausted pool or a stalled server would have hung the run rather than failed it — the opposite
of the one guarantee the helper exists to give, and a claim this ADR was already making. Raised
in the Qodo review of PR #138 and pinned by a test that occupies the observer pool.

It throws on expiry with the expected backend, the expected
blocker, the last observed wait state, the elapsed time and the poll count — and deliberately
without `pg_stat_activity.query`, connection strings, or any other session, so a CI failure does
not print credentials or unrelated activity into a public log. The bound is a failure ceiling, not
a duration: measured over 10 runs the blocked state became visible in 2.1-3.4 ms, on the first
poll every time. The test got faster as well as honest.

The observation is asserted, which is what makes it load-bearing rather than decorative. Mutation
testing pins that, and the two controls are the interesting half:

| Mutation | Result |
| --- | --- |
| The wait call is deleted, assertions kept | caught (compiler: nothing assigns the evidence) |
| The observer returns on its first poll without checking anything | caught by its focused tests |
| The wrong backend is observed | caught |
| The holder commits before the block is observed | caught |
| The observer treats its own timeout as success | caught by its focused tests |
| The ceiling moves back inside the loop, so a stalled poll is unbounded | caught |
| The lock row stops being required, so the evidence can be incomplete | caught (compiler) |
| *Control:* the assertions are deleted, the wait kept | survives — the wait still throws, so the assertion is not what enforces it |
| *Control:* no synchronisation at all, and the holder commits before the admission is even issued | **survives** |

The last row is the point. With the race made impossible, the test still passes — which is direct
evidence that the sleep-based version could report success having proved nothing. Neither control
is a gap: they delete the guard rather than the behaviour, and they are listed because they are
what shows the guard earns its place.

Each focused test builds its own uuid-named scratch table. A fixed name would let one test drop a
table another was using and would make the cleanup capable of destroying a pre-existing table of
the same name; also raised in the Qodo review of PR #138.

The returned evidence is **total**: the wait does not report success until the ungranted `pg_locks`
row is visible alongside the activity row, and both fields are non-nullable so the compiler rejects
any version that stops requiring it. `pg_stat_activity`, `pg_blocking_pids()` and `pg_locks` are
three separate reads of server state inside one statement and are not atomic with respect to each
other, so the lock row can in principle lag. The first version tolerated that in the helper while
the test asserted the row was always present — two claims that cannot both be true, and one of them
had to be a latent flake. Requiring the row makes them agree, at a cost of at most one extra 5 ms
poll; it was not reproducible in 200 forced races, which bounds the risk rather than disproving it.
Raised in the Qodo review of PR #138.

No production code changed in this follow-up. The limiter, the port, the SQL and the HTTP contract
are exactly as this ADR describes them.
