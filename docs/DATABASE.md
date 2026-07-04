# Gambit — Database Architecture

> **Status:** **APPROVED** (Milestone 4 gate). This is the contract the
> `persistence` package implements and the `api` package consumes. Revised after
> approval to incorporate five reviewer refinements (controlled-value modeling,
> event schema versioning, UUIDv7, richer audit log, richer session metadata) —
> see [`docs/adr/0001-persistence-data-modeling.md`](adr/0001-persistence-data-modeling.md).

This document defines the durable data layer for Gambit: the storage engine, the
event store that makes the M3 game authority durable, the relational schema, the
migration strategy, the repository seams, concurrency/consistency rules, and the
testing approach. It refines and makes concrete the abbreviated model in
`docs/ARCHITECTURE.md` §5.

---

## 1. Goals & non-goals

**Goals**

1. Make games **durable and exactly reconstructable** from an append-only event
   log, so the M3 `GameAuthority` can persist, rehydrate, and resume any game via
   the existing `Game.fromEvents(...)` path — with **zero changes to the domain
   packages**.
2. Provide the relational foundation M4 needs: identity (argon2id + passkeys +
   sessions/refresh rotation), RBAC, users/profiles, seeks/lobby, **Glicko-2
   ratings per variant**, and leaderboards.
3. Keep the storage engine behind **narrow repository interfaces** so the domain
   and API never import a driver. This mirrors the existing `PubSub` / `Transport`
   seam pattern from M3.
4. Be correct first, then scalable: a schema that runs on a single Postgres today
   but partitions, shards, and adds read-replicas without a rewrite (target:
   millions of users, 100k+ concurrent connections).

**Non-goals (deferred, tracked)**

- GraphQL read models — deferred to M10–M11 (roadmap decision).
- Search / pgvector embeddings — M11 (columns reserved, not populated).
- Kafka/NATS event streaming — M14. The event store here is the system of record;
  streaming is an optional downstream projection later.
- Multi-region active/active — post-M14.

---

## 2. Engine decision: PostgreSQL (single primary + read replicas)

**Decision:** PostgreSQL 16 is the primary system of record for **both** the game
event log and all relational projections.

**Reasoning**

- **One transactional boundary for events + projections.** When a game ends we
  must append the terminal event *and* update the `games` projection, ratings, and
  leaderboards. Postgres lets us do the event append and its projection update in
  a single ACID transaction, eliminating a whole class of "event stored but
  projection lost" bugs. A separate event-store product (e.g. EventStoreDB) would
  reintroduce cross-store consistency problems for no near-term benefit.
- **Append-only ordering is trivial and cheap.** A composite primary key
  `(game_id, seq)` gives per-game total ordering, gap/dup rejection, and clustered
  locality — exactly the access pattern (`load all events for one game, in order`)
  that `Game.fromEvents` needs.
- **Scales the way this workload scales.** Writes are dominated by move events,
  which are tiny and always scoped to one `game_id`; this partitions cleanly by
  time and shards cleanly by `game_id` hash later. Reads are dominated by "one
  game" and "one user's recent games", both index-friendly.
- **Operational maturity:** partitioning, logical replication, `LISTEN/NOTIFY`,
  strong JSONB, extensions (`pgcrypto`, later `pgvector`) — all first-party.

**Rejected alternatives**

- *MongoDB / document store:* weaker multi-document transactions historically, and
  we specifically want relational integrity for identity/ratings/RBAC.
- *A dedicated event-store DB alongside Postgres:* dual-write consistency burden.
- *SQLite:* fine for tests, not for the concurrency target.

**Caching (not the source of truth):** Redis (already assumed by M3 for pub/sub)
holds leaderboards (sorted sets) and hot session lookups; it is always rebuildable
from Postgres and is introduced where a measured hotspot justifies it, not
speculatively.

### 2.1 Primary keys: application-generated UUIDv7

**Decision:** all synthetic primary keys are **UUIDv7**, generated in the
`persistence` package (not the database), stored in native `UUID` columns.

- **Why UUIDv7 over random UUIDv4:** UUIDv7 is time-ordered (48-bit Unix-ms prefix
  + random tail). Time-ordered keys insert at the "right edge" of the B-tree, so we
  keep v4's collision-free client-side generation **and** get v2/bigserial-like
  index locality — far less page churn and WAL write amplification at high insert
  rates (games, events, sessions, audit rows). This directly serves the "millions
  of users" target.
- **Why generate in the app, not the DB:** Postgres 16 has no built-in `uuidv7()`
  (that lands in PG18). Generating IDs in `persistence` (a small, dependency-free
  helper, unit-tested for monotonicity and RFC-9562 layout) keeps IDs available
  *before* the insert (needed to correlate the `GameCreated` event's `gameId` with
  the `games` row), avoids a DB round-trip, and stays portable across shards.
- **Compatibility:** UUIDv7 is a standard UUID; columns stay `UUID`, and if we later
  adopt PG18's native `uuidv7()` the wire format is identical — no migration.
- **Exception:** `game_id` originates in the domain/authority (the caller supplies
  it when creating a game); `persistence` provides a UUIDv7 generator that callers
  use, but the store treats `game_id` as an opaque UUID it does not mint.

### 2.2 Controlled values: lookup tables + CHECK, not native ENUM

Several columns hold values from a fixed vocabulary (`variant`, `speed`, `result`,
`termination`, `role`, `kind`, `time_control.kind`). The reviewer asked us to stop
using unrestricted `TEXT`. We do — using **lookup tables** and **`CHECK`
constraints**, and *deliberately not* native Postgres `ENUM` types.

- **Why not native `ENUM`:** enums are compact but operationally awkward for an
  evolving product — `ALTER TYPE ... ADD VALUE` historically cannot run inside a
  transaction and cannot be reverted; values cannot be removed or reordered; and
  enum ordering is definition-order, not semantic. For a platform that will add
  variants and refine terminations over years, this rigidity is a liability.
- **Lookup tables** (a `code TEXT PRIMARY KEY` catalog + FK) for vocabularies that
  **evolve or carry metadata**: `variants` (add a variant → one seed row, referential
  integrity everywhere it's used) and `terminations`. This gives FK enforcement,
  a natural place for display names/flags, and trivial extension.
- **`CHECK` constraints** for **small, fixed, security- or protocol-defined** sets
  where a whole table is overkort and the set changes only with a code+migration
  change anyway: `speed`, `result`, `role`, credential `kind`. A `CHECK` is easy to
  widen in a migration (`DROP`/`ADD CONSTRAINT`) without enum's transaction quirks.

The **event payload (JSONB) keeps the raw domain strings** verbatim (the
TypeScript union types in `@chess-platform/*` remain the source of truth); only the
relational **projection** columns are constrained by lookup/CHECK. This keeps the
immutable log faithful while making query-side columns safe.

---

## 3. The event store (the heart of M4)

### 3.1 Ordering model — `seq`, not `ply`

The domain's `GameEvent` union mixes move events (which carry a chess `ply`) with
non-move events (`GameCreated`, `DrawOffered`, `DrawDeclined`, `GameEnded`, which
have **no** `ply`). Therefore the durable log is ordered by a **monotonic
per-game append sequence `seq`** (0-based), *not* by chess ply.

- `seq` is the storage ordering key and the optimistic-concurrency token.
- `ply` remains a pure chess concept and lives **inside the event payload** for
  `MovePlayed` events. It is never the storage key.
- Reconstruction is: `Game.fromEvents(rows ORDER BY seq ASC map(r => r.payload))`.
  This returns byte-identical state to the live authority (M2 already proves exact
  reconstruction from the in-order event array).

### 3.2 Table: `game_events` (append-only, system of record)

```sql
CREATE TABLE game_events (
  game_id        UUID        NOT NULL,
  seq            INTEGER     NOT NULL,           -- 0-based per-game append index
  type           TEXT        NOT NULL,           -- GameEvent discriminant
  event_version  SMALLINT    NOT NULL DEFAULT 1, -- payload schema version (see §3.4)
  payload        JSONB       NOT NULL,           -- the exact GameEvent object
  server_ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, seq),
  CONSTRAINT game_events_seq_nonneg CHECK (seq >= 0),
  CONSTRAINT game_events_version_pos CHECK (event_version >= 1)
);
-- Integrity guard: seq 0 must be a GameCreated event (enforced in the repository
-- and asserted by an integration test).
```

- **Append-only:** no `UPDATE`/`DELETE` in normal operation (enforced by a
  role-level revoke in production; a `BEFORE UPDATE/DELETE` trigger raises in all
  environments as defense in depth).
- **Optimistic concurrency = correctness.** An append supplies the `expected_seq`.
  Because `(game_id, seq)` is unique, two racing appends for the same `seq` → one
  wins, the other gets a unique-violation the repository surfaces as
  `ConcurrencyError`. This complements (does not replace) the authority's existing
  per-game command serialization; it makes correctness hold even across process
  restarts and multiple authority nodes.

### 3.3 `EventStore` repository interface

```ts
export interface StoredEvent {
  readonly gameId: string;
  readonly seq: number;
  readonly version: number;    // payload schema version (default 1)
  readonly event: GameEvent;   // typed from @chess-platform/game
  readonly serverTs: number;
}

export interface EventStore {
  /** Append events after `expectedSeq` (the caller's last known seq, -1 for a new
   *  game). Atomic: all-or-nothing. Throws ConcurrencyError on seq conflict. */
  append(gameId: string, expectedSeq: number, events: readonly GameEvent[]): Promise<number>; // returns new last seq
  /** Load the full ordered log for a game (for Game.fromEvents). */
  load(gameId: string): Promise<StoredEvent[]>;
  /** Load events with seq > afterSeq (resume / spectator catch-up). */
  loadSince(gameId: string, afterSeq: number): Promise<StoredEvent[]>;
  /** Whether any events exist for a game. */
  exists(gameId: string): Promise<boolean>;
}
```

- **Two implementations, one interface** (same pattern as M3's `InMemoryPubSub`):
  - `InMemoryEventStore` — deterministic, dependency-free; used by domain/unit
    tests and local dev.
  - `PostgresEventStore` — production, backed by `game_events` via `pg`.
- Events are appended at `event_version = 1` today; the write path accepts a
  version so a future migration can emit v2 payloads without touching v1 rows.
- **M3 integration (non-breaking):** `GameAuthority` gains an *optional*
  `EventStore` dependency. When present, `createGame`/`applyNow` also
  `append(...)`, and a new `loadGame(gameId)` rehydrates via
  `Game.fromEvents(store.load(...))`. When absent, behaviour is exactly today's
  in-memory path — so all 26 existing M3 tests keep passing unchanged. **This
  wiring is performed in the deployable service (M14);** M4 ships the store, its
  two implementations, and the round-trip acceptance test.

### 3.4 Event schema evolution (`event_version`)

Events are immutable once written, but their *shape* may need to evolve (e.g. a
future `MovePlayed` gains a field). We handle this without rewriting history:

1. Every row records the `event_version` its `payload` was written under.
2. On read, the repository routes each row through an **upcaster** keyed by
   `(type, event_version)` that maps an old payload to the current in-memory
   `GameEvent` shape. v1 → current is the identity today.
3. New writes always use the current version. Old rows are never mutated.

This keeps `Game.fromEvents` fed with current-shape events regardless of when a
game was recorded, and keeps upgrades backward-compatible and reversible.

---

## 4. Relational schema (projections + identity)

### 4.1 Lookup / catalog tables

```sql
CREATE TABLE variants (          -- evolving vocabulary (add a variant = 1 seed row)
  code        TEXT PRIMARY KEY,  -- 'standard','chess960','kingofthehill',...
  name        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE terminations (      -- evolving/annotated vocabulary
  code        TEXT PRIMARY KEY,  -- 'checkmate','resignation','timeout',...
  is_draw     BOOLEAN NOT NULL
);
-- Seeded by migration 0001 from the domain's Variant / Termination unions.
```

Small fixed sets use `CHECK` (see §2.2): `speed`, `result`, `role`, credential
`kind`, `time_control.kind`.

### 4.2 Games projection (derived from the event log; rebuildable)

```sql
CREATE TABLE games (
  id           UUID PRIMARY KEY,              -- UUIDv7, matches the event log's game_id
  variant      TEXT NOT NULL REFERENCES variants(code),
  rated        BOOLEAN NOT NULL,
  speed        TEXT NOT NULL
                 CHECK (speed IN ('ultrabullet','bullet','blitz','rapid','classical','correspondence')),
  white_id     UUID REFERENCES users(id),
  black_id     UUID REFERENCES users(id),
  result       TEXT CHECK (result IN ('1-0','0-1','1/2-1/2','*')),  -- NULL = ongoing
  termination  TEXT REFERENCES terminations(code),
  opening_eco  TEXT,
  ply_count    INTEGER NOT NULL DEFAULT 0,
  last_seq     INTEGER NOT NULL DEFAULT 0,     -- mirrors the event-store head
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ
) PARTITION BY RANGE (started_at);             -- monthly partitions
-- BRIN(started_at); btree(white_id), btree(black_id).
```

### 4.3 Identity & authZ

```sql
users(id UUID PK,                              -- UUIDv7
      handle CITEXT UNIQUE, email_hash BYTEA, created_at TIMESTAMPTZ,
      country TEXT, flags JSONB DEFAULT '{}')
credentials(user_id UUID REF users, kind TEXT CHECK (kind IN ('password')),
      secret_hash TEXT,                        -- argon2id encoded string
      updated_at, PRIMARY KEY(user_id, kind))
webauthn_credentials(id BYTEA PK, user_id UUID REF users, public_key BYTEA,
      sign_count BIGINT, transports TEXT[], created_at, last_used_at)
sessions(id UUID PK,                           -- UUIDv7
      user_id UUID REF users, refresh_hash TEXT,
      created_at, expires_at, rotated_from UUID, revoked_at,
      -- account-security metadata (updated on each use):
      created_ip INET, created_user_agent TEXT,
      last_seen_at TIMESTAMPTZ, last_ip INET, last_user_agent TEXT)
roles(user_id UUID REF users,
      role TEXT CHECK (role IN ('user','coach','tournament_director','moderator','admin')),
      PRIMARY KEY(user_id, role))
ratings(user_id UUID REF users, variant TEXT REFERENCES variants(code),
      rating DOUBLE PRECISION, rd DOUBLE PRECISION, vol DOUBLE PRECISION,
      updated_at, PRIMARY KEY(user_id, variant))   -- Glicko-2
seeks(id UUID PK,                              -- UUIDv7
      creator_id UUID REF users, variant TEXT REFERENCES variants(code),
      time_control JSONB, rated BOOLEAN, min_rating INT, max_rating INT, created_at)
```

### 4.4 Audit log (observability-rich)

```sql
audit_log(
  id           UUID PRIMARY KEY,               -- UUIDv7 (time-ordered)
  actor_id     UUID,                           -- null for anonymous/system
  action       TEXT NOT NULL,
  target       TEXT,
  meta         JSONB NOT NULL DEFAULT '{}',
  -- request-correlation & forensics:
  request_id   TEXT,                           -- per-HTTP-request id (from the API gateway)
  trace_id     TEXT,                           -- OpenTelemetry trace id (links to M13 tracing)
  ip           INET,
  user_agent   TEXT,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- btree(actor_id, ts DESC); btree(request_id); btree(trace_id).
```

`request_id`/`trace_id` are populated from the API request context so an audit row
can be joined to logs/traces (M13 OpenTelemetry) for end-to-end debugging.

### 4.5 Reserved for later milestones

Created only when their milestone lands (listed for design coherence):
`tournaments*`, `studies*`, `follows`, `friends`, `messages`, `puzzles`,
`openings(embedding vector)` (M11 pgvector), `anti_cheat_signals` (M12).

**Secrets never stored in plaintext:** passwords are argon2id **encoded strings**
(salt + params embedded); refresh tokens are stored only as hashes; `email_hash`
is a keyed hash (lookup without storing raw email). No credential is ever logged.

---

## 5. Migrations

- **Forward-only, numbered SQL files:** `persistence/migrations/NNNN_name.sql`,
  applied in order, each in its own transaction.
- **Ledger table** `schema_migrations(version INT PK, name TEXT, applied_at,
  checksum TEXT)`; the runner refuses to run if a previously-applied file's
  checksum changed (immutability of history).
- **Runner** is a tiny dependency-light script (`npm run migrate`) usable in CI,
  local dev, and as a K8s init-container/Job later. No heavyweight ORM/migration
  framework — it hides SQL we want to own and review.
- **No ORM.** Hand-written SQL in typed repositories. Rationale: the schema is the
  product's crown jewels; an ORM obscures query plans and indexing, which matter
  at our scale. `pg` (node-postgres) is the only DB dependency.

---

## 6. Concurrency, consistency & scale

- **Per-game correctness:** optimistic append on `(game_id, seq)` (see §3.2).
- **Transactional projections:** event append + `games`/`ratings` projection
  updates commit together.
- **Ratings** recomputed with a verified Glicko-2 implementation (unit-tested
  against the reference paper's worked example) inside the game-end transaction.
- **Partitioning:** `games` and `game_events` by month on time; old partitions are
  cheap to archive to object storage (PGNs) later.
- **Sharding path (future, no rewrite):** `game_id` is a UUIDv7; a hash-shard
  router can place events on N Postgres shards keyed by `game_id` because no query
  spans multiple games. Identity stays on a primary cluster.
- **Read replicas** for analytics/leaderboard rebuilds; primary for writes only.

---

## 7. Testing strategy

- **Unit / domain:** `InMemoryEventStore` + pure logic (Glicko-2, UUIDv7 layout &
  monotonicity, upcasters) — dependency-free, run under `node --test` like every
  existing package.
- **Integration:** ephemeral **real Postgres** (Testcontainers, or a
  docker-compose service in CI) — never a mock — asserting: migrations apply
  cleanly and are idempotent; append/optimistic-concurrency semantics; lookup/CHECK
  enforcement; and the **round-trip acceptance test** from the roadmap: *events
  produced by playing a game → store → `Game.fromEvents` → state identical to the
  live game* (FEN, ply, clocks, SAN).
- **AuthZ matrix tests** for RBAC; **Glicko-2** verified against a reference vector.
- Integration tests **skip** (not fail) when no `DATABASE_URL` is present, so the
  dependency-free suites still run everywhere (incl. this sandbox and pre-DB CI).

---

## 8. Package boundaries (what M4 creates)

```
packages/
  persistence/          # NEW — durable data layer (this document)
    src/
      ids.ts             # UUIDv7 generator
      glicko2.ts         # Glicko-2 rating math
      event-store.ts     # EventStore interface + InMemoryEventStore + upcasters
      errors.ts          # ConcurrencyError, etc.
      pg/                # PostgresEventStore + pool + repositories + migrate runner
      repositories/      # users, sessions, ratings, games, seeks (interfaces + pg impls)
    migrations/*.sql
    test/
  api/                  # NEW — stateless REST service + OpenAPI (built after persistence)
```

`persistence` depends on `@chess-platform/game` (for the `GameEvent` type) and
`pg`. `api` depends on `persistence`, `@chess-platform/game`, and
`@chess-platform/core`. The domain packages depend on **neither** — the dependency
arrow always points toward the domain.

---

## 9. Resolved decisions (post-approval)

1. **Driver:** `pg` (node-postgres), hand-written SQL, no ORM. ✅
2. **Integration test infra:** Testcontainers-node (local + CI parity); tests skip
   without `DATABASE_URL`. ✅
3. **Event-store ordering key:** `seq` (append index) with `ply` in payload; plus
   `event_version` for schema evolution (§3.4). ✅
4. **IDs:** application-generated **UUIDv7** in native `UUID` columns (§2.1). ✅
5. **Controlled values:** lookup tables (`variants`, `terminations`) + `CHECK`
   constraints; **not** native ENUM (§2.2). ✅
6. **Audit log** carries `request_id`, `trace_id`, `ip`, `user_agent` (§4.4). ✅
7. **Sessions** carry `created_ip/user_agent` + `last_seen_at/last_ip/last_user_agent`
   (§4.3). ✅
8. Build order within M4: **`persistence` first**, then **`api`**. ✅

Rationale for the two places we refined a reviewer suggestion (native ENUM →
lookup+CHECK; DB-side → app-side UUIDv7) is recorded in
[`docs/adr/0001-persistence-data-modeling.md`](adr/0001-persistence-data-modeling.md).
Implementation proceeds package-by-package with the same
"build → self-critique → multi-perspective review" method as M1–M3.
