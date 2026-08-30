# ADR-0138 — Wiring the durable analysis cache to production

| Field      | Value                                                                 |
|------------|-----------------------------------------------------------------------|
| **Status** | Accepted                                                              |
| **Date**   | 2026-08-29                                                            |
| **Scope**  | api composition root, persistence (retention), migrations, observability |

---

## Context

ADR-0135 shipped the durable Postgres analysis cache as **infrastructure only** and said so plainly:
"`packages/api` composes no durable cache here… the default remains the in-process LRU." It then
named three preconditions that had to be met before wiring, and this ADR is the record of meeting
them.

Two of the three were still open. The third was closed by the engine work that followed:

- **Fingerprint identity.** ADR-0135 §7 objected that `computeFingerprint` hashed option *names*,
  so two workers differing only in `EvalFile` or `SyzygyPath` shared a fingerprint — an isolation the
  process-scoped LRU provided by accident and a shared table would remove. The durable-orchestration
  work changed `computeFingerprint` to hash full option *descriptors* (name, type, advertised
  default, bounds, values) and added `analysisCacheFingerprint`, which folds the *configured* option
  values into the identity. **This precondition is discharged**, with one narrow residue recorded
  under Consequences.
- **Retention.** Still open. Addressed by Decision 4.
- **A statement timeout on the pool.** Still open. Addressed by Decision 2.

Until now the cost of the gap was invisible but real: every replica started cold, every entry died
with the process that made it, and every deploy discarded the fleet's accumulated analysis. The
expensive deep searches the cache exists to avoid were repeated per process and per deploy.

## Decision

### 1. The composition root owns the cache; the engine still knows nothing about a database

`createPgDependencies` builds the tier and hands it to `createAnalysisFromEnv` **as a factory, not a
value**. The factory is called only after the engine-configured check passes, so a deployment with no
engine binary opens no connection pool and starts no sweeper for a table nothing in the process would
ever read.

The tier is assembled in `packages/api/src/analysis/durable-cache.ts` and consists of exactly four
things: the pool, the ADR-0135 adapter, the retention sweeper, and the observability both halves
report to. Whatever is created there is released there. `analysis/composition.ts` accepts the tier
through an interface and stays free of the `pg` driver, which is what lets its tests build a whole
engine with no database.

Nothing about the engine changes. `AnalysisCache` is still the seam, `PgAnalysisCache` still
implements it, and the cache-first flow, single-flight coordination, cancellation isolation and
result validation are exactly the ones already shipped.

### 2. The cache runs on its own small pool, bounded in both directions

The bound ADR-0135 §7 asked for is `statement_timeout: 250ms`, set on a **dedicated** four-connection
pool rather than the API's shared one.

It has to be a separate pool. `statement_timeout` from `PoolConfig` is a connection-level setting, so
putting it on the shared pool would bound every unrelated repository query too. The alternatives are
worse: `SET LOCAL` requires an explicit transaction, turning a one-round-trip lookup into
BEGIN/SELECT/COMMIT on the hottest path in the subsystem, and a plain `SET` leaks the setting to
whichever borrower receives that client next.

**The value is derived, not chosen.** `DEFAULT_ANALYSIS_LIMITS.defaultTimeMs` is 1000ms, so a search
this cache exists to avoid costs about a second. The lookup is a single primary-key probe; waiting
more than a quarter of the search's own budget to *maybe* skip it is a worse trade than simply
running the search.

`connectionTimeoutMillis` is set to the same value, and that is not decoration. `statement_timeout`
is enforced by PostgreSQL only once a statement is in flight; a saturated pool leaves `pool.query`
waiting in a Node-side queue that, by default, has no bound at all. Setting only the server-side
timeout would leave exactly the indefinite stall ADR-0135 §7 asked for a timeout to prevent.

### 3. Startup and request time are different failures, and only one of them fails open

- **Request time** keeps ADR-0135 §6 unchanged: every fault is absorbed, the request becomes a miss,
  the engine computes, and the fault is reported.
- **Startup** does not probe. `pg.Pool` connects lazily and a boot-time `SELECT 1` would turn a
  database that happens to be slow at that instant into a failed deploy, for a component whose entire
  failure story is "carry on without it". A database that is actually down is already reported by the
  API's readiness check and by the fault counter as soon as requests arrive.
- **Configuration** cannot fail silently, because durable caching is on exactly when the caller
  supplies a connection string and has not set `ANALYSIS_CACHE_DURABLE=0`. `createPgDependencies`
  resolves that string the same way it built the main pool, so a deployment with a broken
  `DATABASE_URL` fails loudly at the main pool before the cache is asked anything. Every outcome is
  logged with its reason, so an absent durable tier is never left to be inferred from a missing
  metric.

Cache availability is therefore an **optional optimization at request time** and a **decided
configuration at startup** — not a required dependency, and not a silent fallback.

### 4. Retention is a bounded periodic sweep, and nothing more

A row is eligible when `updated_at < now() - ttl`, default 30 days, configurable and clamped to a
year. The sweep runs hourly on the tier's own pool, deleting at most 500 rows per statement and 20
batches per tick.

`updated_at` moves only when a dominating search replaces the row, so the window measures age since
the entry last got *stronger*, not since it was last read. Touching rows on read would turn every
cache hit into a row-locking write on the platform's hottest positions. The honest consequence is
that a popular position expires on schedule however often it is read, costs one recomputation, and is
then cached for another full window — a trade this ADR takes deliberately.

The engine fingerprint is the primary invalidator and the TTL is its backstop. An engine upgrade
changes the fingerprint, so every row from the old build becomes unreachable at once; nothing then
refreshes those rows, so they age out and the sweep removes them. That is the growth this policy
exists to bound.

**The delete is one statement**, choosing its batch with `FOR UPDATE SKIP LOCKED`:

```sql
WITH expired AS (
  SELECT fingerprint, variant, multi_pv, fen FROM engine_analysis_cache
   WHERE updated_at < $1 ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED
)
DELETE FROM engine_analysis_cache c USING expired e WHERE c.fingerprint = e.fingerprint AND …
```

`SKIP LOCKED` does two jobs. It makes concurrent sweepers claim disjoint batches instead of
contending — which is why no advisory lock elects a single sweeper, and why adding one was rejected
as a lock to release correctly on every failure path in exchange for avoiding work that is already
correct when duplicated. And it makes the sweep pass over a row another transaction is writing rather
than deleting it on the strength of a snapshot that is about to be out of date: an unlocked subquery
would delete a row a stronger search was landing at that moment, whereas the skipped row is simply no
longer eligible by the next tick, because that write is what refreshed it.

Migration `0027` adds the `updated_at` index the sweep needs. It is a plain transactional
`CREATE INDEX` rather than the online-index directive, because the table is empty in every deployment
— ADR-0135 shipped it and nothing has ever written to it — so building on zero rows is immediate and
the concurrent path would buy nothing for its two-phase pending state.

Retention is the one cache operation that **does not** absorb its failures. `get` and `set` absorb
because `EngineManager.analyze` calls them unguarded on the request path; retention runs on a timer
no request awaits, so its owner can be told — and needs to be, because a sweep that quietly reported
"nothing deleted" forever would be indistinguishable from a clean table while the table grew without
bound.

### 5. Two observability sources, kept apart because neither implies the other

The engine observer says what the **request** did — hit, miss, coalesced, computed, cancelled. The
adapter's `onError` hook says whether the **database** misbehaved — read, write, payload — and the
sweeper adds `retention`.

They cannot double-count, and the reason is worth stating because it is counter-intuitive.
`PgAnalysisCache` absorbs every fault and returns normally, so a failed read reaches the orchestrator
as `undefined` and is recorded as `cache_miss` — never as `cache_read_failure`, which fires only for
a cache that *throws*. A failed write is stranger still: `set` resolves, so the orchestrator records
`cache_write_completed` for a write that never landed. **An operator watching engine events alone
would see a healthy cache with a poor hit rate throughout a total database outage.** The fault
counter is the only signal that can tell those apart, which is exactly why ADR-0135 §6 made supplying
the hook the composition root's job.

Every label is a closed enum from a union type in the engine or the adapter, so the series count is
fixed at build time. Nothing identifying can leak even by mistake: neither the event nor the fault
hook carries a FEN, a cache key, a game, a user or a request id — those fields do not exist on the
signals. Logged errors carry the SQLSTATE and a message truncated to 200 characters with control
characters flattened. Levels follow what the signal means: `read` and `write` are `warn` because the
platform is still answering every request correctly, `payload` is `error` because a row that cannot
be believed does not resolve on its own, and a sweep failing three ticks in a row escalates from
`warn` to `error` because that means the table is no longer being trimmed.

### 6. Single-flight stays process-local, and the docs say so

`AnalysisOrchestrator` coalesces identical in-flight requests within one process. Nothing in
PostgreSQL coordinates two replicas, so **two processes racing the same cold position both compute
it**. Both results are correct, the stronger survives the dominance-guarded upsert, and the cost is
one duplicated search on a cold miss.

No distributed lock is added. It would have to be held for the length of a multi-second search, which
makes every failure mode of the lock a failure mode of analysis, in exchange for saving duplicated
work that only occurs on the first request for a position after an engine upgrade. The behaviour is
asserted by a test rather than merely described, so the claim cannot quietly become false.

## Consequences

- The durable tier costs four PostgreSQL connections per API replica on top of the main pool. A
  deployment scaling replicas must size `max_connections` for both.
- **The in-process LRU is not layered in front of the durable cache.** When the durable tier is
  composed it replaces the LRU rather than sitting behind it. A two-tier cache would need its own
  reconciliation of the two tiers' dominance rules — a stale local entry could shadow a stronger
  durable row — and the latency it would save is sub-millisecond against a search costing a second.
  What is lost is cache hits during a sustained database outage, where every request recomputes.
  Deferred, deliberately, and recorded here rather than in a comment.
- **The residue of ADR-0135's fingerprint precondition.** Option *values* the platform configures are
  now part of the cache identity, and an engine binary advertising a different default for `EvalFile`
  changes its fingerprint. What is still not covered is an operator replacing the file *behind* an
  unchanged advertised path — same binary, same advertised default, different weights. That is a
  deployment practice rather than a code path, and no fingerprint derived from the UCI handshake can
  see it.
- Retention deletes generate dead tuples; standard autovacuum settings are assumed. A deployment that
  turns autovacuum off for this table would see it bloat regardless of the sweep.
- No CI job currently has both an engine binary and a database: `analysis-smoke` installs Stockfish
  without `DATABASE_URL`, and `postgres-integration` has a database and no engine. The composed path
  is therefore proven with the engine package's own `FakeEngineTransport` against a real PostgreSQL
  server, which exercises every line of the wiring except the UCI subprocess. Closing that last gap
  needs a workflow change and is out of this ADR's scope.
- ADR-0135 §7's three preconditions are discharged; that section is superseded by this ADR rather
  than edited, in the same way ADR-0135 superseded ADR-0002's "no change to the persistence
  contract".

## Alternatives considered

- **Share the API's main pool.** Rejected: the timeout is the point, and it cannot be scoped to the
  cache on a shared pool without either a transaction per lookup or a setting that leaks to the next
  borrower.
- **Opportunistic cleanup on the write path.** Rejected: it puts delete latency and delete failures on
  the request path, which is the one place this design keeps them out of.
- **An advisory lock electing one sweeper.** Rejected: `SKIP LOCKED` already makes concurrent sweeps
  disjoint and correct, so the lock would add a release obligation on every failure path for no
  correctness gain.
- **A `last_read_at` column for LRU-style retention.** Rejected: it makes every cache hit a write.
- **Probing the database at boot and refusing to start.** Rejected: it converts a transient database
  blip into a failed deploy for a component that is explicitly optional at request time.
