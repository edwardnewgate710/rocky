# ADR-0135 — Durable Postgres analysis cache

| Field      | Value                                                        |
|------------|--------------------------------------------------------------|
| **Status** | Accepted                                                     |
| **Date**   | 2026-08-28                                                   |
| **Scope**  | persistence, migrations, engine cache port (documentation)   |

---

## Context

ADR-0002 Decision 4 defined `AnalysisCache` as a **port** and shipped an in-process LRU plus a null
cache, deferring a durable backend to a later ADR "if durable caching is justified later". It named
that future decision **ADR-0003**. That number was taken by ADR-0003 (legal moves contract) before
the durable cache was written, so the prediction is stale numbering rather than a reservation; this
ADR is the decision ADR-0002 deferred, and it is **ADR-0135**. ADR-0002's consequence "no change to
the approved `persistence` contract" is superseded here, in the way it anticipated: by an ADR that
carries a `docs/DATABASE.md` addendum.

The in-process LRU is correct but process-scoped. Every worker starts cold, an entry dies with the
process that made it, and nothing is shared between replicas — so the expensive deep searches that
caching exists to avoid are repeated per process and per deploy.

This ADR delivers the durable backend as **infrastructure only**. Nothing in the API composes it.
Production wiring is deliberately a later phase, for the reasons in §7.

## Decision

### 1. Identity is the whole of what makes two searches interchangeable

The table is keyed on `(fingerprint, variant, multi_pv, fen)` — the four fields of `AnalysisKey`, as
separate columns rather than the concatenated `cacheKeyString`. Separate columns cannot be made
ambiguous by a delimiter appearing inside a component, and they let isolation be asserted per field.

No field is dropped and none is weakened. A result from engine build A is never served for build B, a
variant never leaks into another, and a one-line search never answers a three-line request.

**FEN is stored exactly as the caller supplied it.** The platform defines no canonical FEN
normalization contract for cache identity, so normalizing here would invent one. Two spellings of the
same position therefore cache separately: that costs a recomputation, never a wrong answer.

### 2. Rows record what a search reached, not what it was asked for

`achieved_depth`, `achieved_nodes` and `achieved_time_ms` hold `CacheMeta.limits` — which
`EngineManager` derives with `achievedLimits`, at the *minimum* across MultiPV lines. They are stored
as three comparable columns, outside the JSON payload, because they are the only basis on which a
later request may be answered.

`NULL` means the search reached no stated bound in that dimension. It satisfies only a request that
asks nothing of it. A row with all three `NULL` could answer no request at all and is refused by a
`CHECK`.

### 3. A hit must satisfy the request in every stated dimension

The read predicate is `limitsSatisfy(stored, requested)` from the port, expressed in SQL:

```sql
AND ($5::int IS NULL OR (achieved_depth IS NOT NULL AND achieved_depth >= $5::int))
```

`IS NOT NULL` is what makes an absent measurement fail closed instead of reading as an adequate one.
Every dimension clause is two-valued for every combination of stated/unstated and `NULL`/non-`NULL`,
so a row is never silently skipped by SQL three-valued logic.

### 4. An entry may only be replaced by one that could serve every request it could serve

The replacement rule is the read predicate with its arguments swapped —
`limitsSatisfy(incoming, stored)` — evaluated inside `ON CONFLICT (...) DO UPDATE ... WHERE`.

This is the answer to "depth 20 exists, depth 10 finishes later": the depth-10 write does not
dominate, so it does not land, and the depth-20 request still hits the depth-20 analysis. The same
holds for nodes and for time.

Two writes that dominate each other in neither direction — deeper but on fewer nodes — leave the
incumbent in place. Which one that is depends on arrival order, which no cache controls; what does
not depend on arrival order is that **every surviving row truthfully achieved what it claims**, and
that the loser costs a recomputation rather than a wrong answer.

Merging two searches' limits into one row was rejected outright: it would claim a search that never
ran, which is the exact defect `achievedLimits` was written to stop.

**Concurrency.** The predicate is evaluated under the row lock Postgres takes on the conflicting row,
against the committed version the losing writer re-reads. Two writers cannot both observe "I am
stronger" and both overwrite. No application-level read-then-write is involved, so there is no
window to lose.

### 5. Payloads are versioned and validated, never cast

`results` is a JSONB array written by an explicit field-by-field projection, so a field the contract
does not name cannot ride along into the database and an absent optional stays absent instead of
becoming `null`. `payload_version` records the serialization contract.

On read, every field is validated against the `EngineResult` contract. A payload that fails — wrong
shape, unknown evaluation type, a fractional depth, a version this build does not speak — is a
**miss**, reported as a distinct `payload` fault. Casting unverified JSON to `EngineResult` would let
a malformed evaluation reach a caller with no way left to tell it from a real one.

The *set* of lines is held to the same standard as the fields, in both directions: `EngineResult`
documents one result per requested line "ordered best-first (`multipv` 1..N)", so a payload whose
lines are misordered, duplicated, gapped, or absent is refused on write and on read. The empty array
is the case that makes this more than tidiness: it satisfies every per-field check, and
`EngineManager.analyze` returns a hit with `if (cached) return cached`, where `[]` is truthy — so an
empty stored payload would be served as a successful analysis to callers such as
`packages/ai-features/src/endgame-trainer.ts` and `packages/ai-features/src/opening-explorer.ts`,
which go straight to `results[0]`. A search that found no lines can answer nothing.

`payload_version` is deliberately not pinned to a single value by the schema: a rolling deploy must
be able to write a newer version against a schema an older reader still runs on. A newer payload
version always wins the upsert and an older one never overwrites a newer, so the build that can still
read a row does not lose it to one that cannot.

### 6. A cache is an optimization: fail open, but never silently

`EngineManager.analyze` calls `get` and `set` **unguarded**. A throw from this adapter would turn a
database blip into a failed analysis — strictly worse than the recomputation a miss costs. Every
fault is therefore absorbed:

| Failure | Behaviour | Reported as |
|---|---|---|
| Read failure (unreachable/refused) | miss | `read` |
| Write failure | resolves, nothing stored | `write` |
| Limits that cannot be stored truthfully | not written | `write` |
| Malformed or unreadable stored payload | miss | `payload` |

Absorbed is not silent: every fault goes to an injected `onError`. `payload` is kept distinct from
`read` because corruption and an unreachable database are different alerts with different causes. The
hook is optional because this package has no logging dependency and choosing one belongs to the
composition root — supplying it is how a deployment stops a silently dead cache from looking like a
merely cold one. A reporter that throws is contained, since a failing logger must not re-break what
was just absorbed.

The one thing never absorbed is a wrong answer.

### 7. Not wired to production in this phase

`packages/api` composes no durable cache here, and nothing changes for existing callers: the default
remains the in-process LRU. Two preconditions must be met before wiring, and both are properties of
the platform rather than of this adapter:

- **`computeFingerprint` hashes option _names_, not their values.** It is
  `sha256(name + version + sortedOptionNames)`. Two workers on the same build with different
  `EvalFile`, `SyzygyPath` or comparable option **values** produce the *same* fingerprint. The
  in-process LRU never exposed this: entries could not outlive their process or cross a machine, so
  differing configurations were isolated by accident. A shared, durable table removes that accident.
  Sharing analysis between differently-configured workers is a correctness question about the
  fingerprint, and it must be settled before this cache is composed — not by weakening identity here.
- **Retention.** This table has no TTL, consistent with ADR-0002 ("TTL only on ephemeral tiers"), and
  no eviction. Unbounded growth is acceptable for an unwired table and is not acceptable in
  production; a retention policy is part of wiring.
- **A statement timeout on the pool.** Failing open protects the caller from an error, not from a
  wait. `EngineManager.analyze` awaits `get` before it will search, so a query that hangs on lock
  contention rather than failing would stall the analysis indefinitely — worse than the throw this
  adapter exists to prevent. The bound belongs on the pool the composition root supplies
  (`statement_timeout`), which is why it is a wiring precondition and not a constant here.

## Consequences

- `docs/DATABASE.md` gains the `engine_analysis_cache` table (§4.21). This is the addendum ADR-0002
  required of the durable-cache decision.
- The engine keeps defining the port and learns nothing about Postgres. `packages/persistence`
  implements it, so the dependency direction is unchanged.
- `packages/persistence/src/analysis-cache.ts` holds the payload contract and is driver-free, so the
  encoding rules are testable without a database and a consumer that only needs the contract does not
  pull in `pg`. The adapter lives at `packages/persistence/src/pg/analysis-cache.ts`, behind the
  existing `/pg` subpath convention.
- The engine port is imported **type-only**, so no runtime dependency edge is created. This follows
  the existing precedent for `@chess-platform/core`, which four persistence modules already import
  type-only without declaring it. As with `core`, the emitted declarations carry the reference —
  `dist/analysis-cache.d.ts` names `@chess-platform/engine` — so a consumer typechecking against
  them needs it resolvable; `packages/api`, the only consumer of both, already declares it. Declaring
  these edges properly would touch the root lockfile and is left as its own change.
- **Rollback.** Migrations are forward-only and checksummed, so 0026 is not un-applied by the runner.
  Because the table is new, referenced by no foreign key and read by no composed code, reverting the
  application code is sufficient to stop all use of it; the table can then be left in place at no
  cost, or dropped out of band with `DROP TABLE engine_analysis_cache`, which no other relation
  depends on. Discarding the contents costs recomputation only.
- Nothing about the in-process LRU changes. Its own `set` still replaces unconditionally, which its
  docstring describes as a deeper search superseding a shallower one; the durable tier is the one
  that makes that promise true. Aligning the LRU is a separate change to engine behaviour and is not
  smuggled in here.

## Alternatives considered

- **One row per achieved-limit combination.** Preserves incomparable results instead of keeping the
  incumbent, so hit rates would be strictly better. Rejected for this phase: it grows without bound
  per hot position and it answers the replacement question by avoiding it, when the question is the
  point of the design.
- **Read the row, decide in TypeScript, then write.** Rejected: two writers can both read "I am
  stronger" before either writes, and the stronger result loses. The comparison has to happen where
  the lock is.
- **Merge the limits of successive writes into one row.** Rejected as untruthful; see §4.
- **Pin `payload_version` to 1 with a `CHECK`.** Rejected: it makes a rolling deploy that introduces
  version 2 unable to write, and it makes the "unknown version is a miss" path untestable.
