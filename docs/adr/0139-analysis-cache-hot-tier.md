# ADR-0139 — A process-local hot tier in front of the durable analysis cache

| Field      | Value                                              |
|------------|----------------------------------------------------|
| **Status** | Accepted                                           |
| **Date**   | 2026-08-30                                         |
| **Scope**  | api analysis composition, cache observability      |

---

## Context

ADR-0138 wired the durable Postgres analysis cache to production. It did so by handing `tier.cache`
to `createAnalysisEngine`, where the trailing `...options` spread lands after the factory's own
`cache:` entry and therefore **replaces** it. That was the intended behaviour and the composition
test asserts it, because a durable cache that the engine never consults is the bug ADR-0138 existed
to prevent.

The side effect was not intended. `createAnalysisEngine` builds `new InMemoryLruCache(...)` from
`ANALYSIS_CACHE_ENTRIES`, and in a durable deployment that object is constructed, immediately
overwritten, and never called. Production has had **no in-process cache at all** since ADR-0138
landed: every analysis lookup, including the same position requested twice in the same second, is a
PostgreSQL round trip through a pool bounded at four connections with a 250ms statement timeout.

The durable tier is the right place for analysis to *live* — it survives the process, which is the
whole argument of ADR-0135. It is the wrong place to ask twice in a row.

## Decision

### 1. A composite behind the existing port, not a change to the path

`HotAnalysisCache` in `packages/api/src/analysis/hot-cache.ts` implements `AnalysisCache` and wraps
the durable adapter. `createAnalysisCacheComposition` returns the composite as `tier.cache`, so the
engine receives one cache exactly as before and `createAnalysisFromEnv` is untouched — the source
assertion in `packages/api/test/analysis-cache-composition.test.ts` still holds unchanged.

This is the property that makes the tier safe to add. `AnalysisOrchestrator` keeps the single-flight
map, the cancellation ledger and the result validation; the composite is called from *inside* a
flight, by the same two calls the durable adapter used to receive, and everything it returns is
re-checked by `isAnalysisResultSet` before a caller sees it. Nothing above it can tell which tier
answered.

Three placements were considered and are recorded under Alternatives. The decisive question was
which of them changes a call the orchestrator makes. Only this one changes none.

### 2. Retention keeps the durable adapter, not the composite

`AnalysisCacheRetention` is constructed with the `PgAnalysisCache` directly. `deleteExpired` is the
adapter's own, runs off the request path, and belongs to the tier that owns rows; routing it through
the front tier would be asking a cache with no storage to sweep a table.

### 3. The hot deadline is this tier's own, short, absolute, and not configurable

**The durable tier supplies no expiry metadata to inherit.** Its `SELECT` carries no expiry
predicate at all, and rows die only when the sweeper deletes them by `updated_at`; `get` returns
`EngineResult[]` and nothing else. A front tier therefore cannot learn when the row it just read is
due to be swept. This was verified before it was designed around.

So the deadline is one this tier owns: `HOT_CACHE_TTL_MS`, sixty seconds, fixed at insertion and
**never renewed by a read**.

Absolute rather than sliding is the whole of the safety argument. A sliding deadline would make a
frequently-requested position immortal in memory, which is exactly how a hot tier outlives the
retention policy it sits under. With an absolute one, a position asked for a thousand times a second
still leaves this tier after a minute, and the extra staleness the tier can introduce is at worst
`HOT_CACHE_TTL_MS` — under one part in forty thousand of the 30-day default window, and under one
part in a thousand of the shortest window an operator can configure.

It is a constant rather than a setting for the reason `packages/api/src/analysis/durable-cache.ts`
already gives about the statement timeout: a safety bound's only interesting values are the derived
one and a wrong one. Here the point is sharper — raising it is the one change that could let a
process serve an analysis the retention policy meant to retire.

This is deliberately **not** a second, contradictory TTL policy. The invariant that makes the two
coherent is that the hot deadline is strictly shorter than any retention window, so the hot tier can
only ever be a bounded-staleness view of what the durable tier would have returned at insertion. A
test asserts the two orders of magnitude directly, so the relationship cannot silently invert.

**The deadline is measured on a monotonic clock**, which is the one place this subsystem departs from
`SystemClock`. The engine's `Clock` documents "wall clock is fine", and for a watchdog it is — a
backward step makes a timeout fire late and the next tick corrects it. Here the deadline is not a
timeout but the bound this whole section rests on, so a wall clock that steps back an hour would hold
entries an hour past a deadline this ADR calls absolute. `performance.now()` counts from process
start and no NTP correction moves it. Nothing in this tier compares against a stored timestamp — the
durable tier's `updated_at` comparison stays on the wall clock where it belongs, because that one
really is comparing against a recorded time. Raised in the CodeRabbit review of PR #19.

### 4. Capacity reuses `ANALYSIS_CACHE_ENTRIES`, clamped

The hot tier holds at most `settings.hotEntries`, read from the same `ANALYSIS_CACHE_ENTRIES` the
engine's fallback LRU reads, because it is the same question: how many analyses this process keeps in
memory. Only one of the two tiers is ever live — the fallback when there is no durable cache, the hot
tier when there is — so a deployment that tuned the number gets the number it tuned either way, and
the variable stops being silently ignored in exactly the deployments that have a durable cache.

It is clamped to `MAX_HOT_CACHE_ENTRIES` (5,000) rather than validated, following the same
convention this file already applies to the retention window: a cache size is not worth refusing to
boot over, and the clamp is what stops a mistyped variable from making the cache the reason a
container is killed.

### 5. Hot population happens before the durable write, and independently of it

`set` stores into memory first, then delegates unchanged.

The value is already trustworthy at that point: `AnalysisOrchestrator.compute` runs
`isAnalysisResultSet` over the engine's output and throws `ProtocolError` before it ever calls `set`,
so a failed, cancelled, or malformed computation never reaches this line. Making the hot entry wait
on the durable write would tie the optimization to the thing it is meant to survive — a database
outage would cost the recomputation *and* the in-process hit, which is the opposite of failing open.

The durable call is unchanged: same arguments, same order relative to the caller, same error
propagation. A database outage therefore increments exactly the counters it did before ADR-0139.

### 6. Dominance is read against live entries only

Insertion honours the same rule the durable `ON CONFLICT DO UPDATE` applies — an entry may only be
replaced by one that could serve every request it could serve — so a depth-10 search finishing second
does not displace a depth-20 result.

Expiry is checked **before** dominance, and the order is load-bearing. An expired incumbent is not an
incumbent: reading dominance against it would let a stale deep entry block a fresh shallow one for as
long as new writes kept arriving, leaving the key holding a value nothing may serve and nothing may
replace.

A live entry that is merely *too weak* for the request in hand is left where it is. Deleting it would
let one deep request throw away an entry that is still answering every shallow one.

### 7. A durable hit records the requested limits, not the row's

The durable `get` does not report what the stored row actually achieved, so a populated entry records
the caller's **requested** limits as its own.

That is deliberately an under-claim, and under-claiming is the only safe direction. The durable tier
returned the value precisely because the stored search satisfied `requested`, so anything `requested`
can satisfy the real row can satisfy too. A later, stronger request therefore misses here and reaches
the durable row that may well answer it, costing one lookup. Recording anything larger would let this
tier promise a depth no search behind it ever reached.

### 8. Expiry is lazy; the tier owns no timer

Entries are dropped on the access that finds them expired, and on eviction. There is no sweep, no
`setInterval`, and no handle — so this tier cannot keep a process alive and adds nothing to the
shutdown sequence except `clear()`, which drops what it holds so that "the cache tier is released"
means the same thing for both halves.

### 9. A third counter, because `cache_hit` stopped answering the question

With two tiers behind one port, the orchestrator's `cache_hit` no longer distinguishes "answered from
this process's memory" from "answered by PostgreSQL" — both reach it as the same event. That single
number is now an average of two very different things.

`analysis_cache_hot_total` carries the difference, labelled by a closed `HotCacheOutcome` union:
`hit`, `miss`, `durable_hit`, `expired`, `evicted`. Together they answer the two operational
questions the merged counter cannot: is the hot tier earning its memory, and is a rising miss rate
capacity pressure or entries ageing out? The label set is fixed at build time in the same way every
other label in `cache-observability.ts` is, and the signal carries no key, FEN, fingerprint, user or
request id to leak.

## Consequences

- Production regains an in-process cache, and `ANALYSIS_CACHE_ENTRIES` stops being dead configuration
  in durable deployments.
- A repeated analysis costs a `Map` lookup instead of a pooled round trip against a table whose reads
  are already bounded at 250ms. The saving is largest exactly where the pool is most contended.
- **The tier can serve a value up to `HOT_CACHE_TTL_MS` after the durable row that produced it was
  deleted or superseded.** This is a missed optimization, not a correctness problem: analysis is
  deterministic for a given identity, a superseding row is a *stronger* search of the same position,
  and the weaker answer this tier may briefly keep serving is one the durable tier itself served
  moments earlier. The bound is absolute and does not grow with traffic.
- Cross-process single-flight still does not exist, and this ADR does not add it. Two replicas racing
  a cold position still both compute it; ADR-0138 §6 stated that and it remains true. A hot tier is
  per-process by definition and makes the duplication no worse.
- No schema change, no migration, no new dependency, and no change to any package outside
  `packages/api`.
- The engine's own `InMemoryLruCache` is left exactly as it is, and remains the cache for deployments
  with no durable tier. Unifying the two was considered and rejected — see Alternatives.

## Alternatives considered

- **A tier inside `AnalysisOrchestrator` (`packages/engine`).** Rejected: it moves the cache read
  relative to the in-flight map, which is the one piece of this subsystem whose correctness is
  hardest to re-establish, and it teaches the engine about cache tiering that ADR-0002 Decision 4
  deliberately put behind a port.
- **A tier inside `PgAnalysisCache` (`packages/persistence`).** Rejected: it couples an in-process
  memory cache to a driver adapter, and makes a behaviour with no database in it testable only with
  one.
- **A layer above `EngineManager.analyze`, in `AnalysisService`.** Rejected outright: it sits in front
  of single-flight, so a burst of identical cold requests would become a burst of engine searches —
  and every caller that reaches the engine another way, including anti-cheat, would bypass it.
- **Extending `InMemoryLruCache` with a TTL and using it for both tiers.** Rejected for this
  increment: the fallback LRU is the *only* cache in the deployments that use it, so imposing a
  sixty-second deadline on it would take away most of its value to solve a problem those deployments
  do not have.
- **Inheriting a per-entry deadline from the durable tier.** Rejected because it is not available:
  the durable `SELECT` returns no timestamp and `get` returns no metadata. Adding one would mean a
  schema-shaped change to the read path, which this increment explicitly is not.
- **A sliding deadline renewed on each hit.** Rejected: it maximizes hit rate by making the hottest
  entries the ones that can outlive retention indefinitely, which inverts the safety property this
  tier most needs.
- **Sizing the cache by estimated bytes rather than entry count.** Rejected: this repository has no
  reliable object-size estimator, and inventing one would put a guess in charge of a memory bound.
- **A periodic sweep of expired entries.** Rejected: lazy expiry costs nothing on the paths that
  would have touched the entry anyway, and a timer is the one way this tier could keep a process
  alive past shutdown.
