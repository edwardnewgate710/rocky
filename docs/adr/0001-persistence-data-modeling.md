# ADR 0001 — Persistence data-modeling decisions (Milestone 4)

- **Status:** Accepted
- **Date:** 2026-07-04
- **Context milestone:** M4 (API & identity / persistence)
- **Supersedes:** none
- **Related:** [`docs/DATABASE.md`](../DATABASE.md)

## Context

The M4 database architecture (`docs/DATABASE.md`) was approved. During approval the
reviewer requested five refinements. This ADR records the decisions and, for the
two cases where we adopted the *intent* of a suggestion via a different mechanism,
the reasoning — so future engineers understand why the code looks the way it does.

## Decisions

### 1. Controlled values → lookup tables + CHECK constraints (NOT native ENUM)

**Decision.** Model evolving/annotated vocabularies (`variant`, `termination`) as
**lookup tables** with FK references, and small fixed protocol/security sets
(`speed`, `result`, `role`, credential `kind`, `time_control.kind`) as **`CHECK`
constraints**. Do **not** use native PostgreSQL `ENUM` types.

**Why not native ENUM.** Enums are storage-compact but operationally rigid for a
product evolving over years:
- `ALTER TYPE ... ADD VALUE` historically cannot run inside a transaction and
  cannot be rolled back;
- enum values cannot be removed or reordered;
- ordering is definition-order, which leaks into `ORDER BY` surprises.

Lookup tables give referential integrity, a home for metadata (display name,
`enabled`, `is_draw`), and one-row extensibility. `CHECK` constraints are trivially
widened in a forward migration without enum's transactional quirks. Both fully
satisfy the reviewer's goal of eliminating unrestricted `TEXT`.

**Consequence.** The event **payload (JSONB)** still stores raw domain strings
verbatim (the TypeScript unions in `@chess-platform/*` remain the source of truth);
only **projection** columns are constrained. Adding a variant = one seed row in
migration + the domain union; no `ALTER TYPE`.

### 2. `event_version` on the event store — ADOPTED as-is

`game_events.event_version SMALLINT NOT NULL DEFAULT 1`. Reads pass each row
through an upcaster keyed by `(type, event_version)`; writes always use the current
version; historical rows are never mutated. Enables safe payload evolution.

### 3. UUIDv7 primary keys, generated in the application (NOT `uuidv4`/DB-side)

**Decision.** All synthetic PKs are **UUIDv7**, minted in `persistence` (`ids.ts`),
stored in native `UUID` columns.

**Why app-side rather than DB-side.** Postgres 16 has no built-in `uuidv7()` (PG18
adds it). Generating in the app keeps IDs available *before* insert (needed to
correlate a `GameCreated` event's `gameId` with its `games` row), avoids a DB
round-trip, and is shard-portable. The column type is a standard `UUID`, so
adopting PG18 `uuidv7()` later needs no migration.

**Why UUIDv7 over UUIDv4.** Time-ordered prefix ⇒ right-edge B-tree inserts ⇒ far
less page churn / WAL amplification at high insert volume, while retaining
collision-free client-side generation. Directly serves the millions-of-users
target.

### 4. Audit log enriched — ADOPTED as-is

`audit_log` gains `request_id`, `trace_id`, `ip`, `user_agent` (plus the existing
`actor_id`, `action`, `target`, `meta`, `ts`). Correlates audit rows with logs and
M13 OpenTelemetry traces.

### 5. Session metadata enriched — ADOPTED as-is

`sessions` gains `created_ip`, `created_user_agent`, `last_seen_at`, `last_ip`,
`last_user_agent` to power account-security features (session list, "new device"
alerts, anomalous-IP detection).

## Status of impact

- No change to the overall architecture, service map, or milestone plan.
- `persistence` implements all of the above; `api` (M4 second half) consumes it.
