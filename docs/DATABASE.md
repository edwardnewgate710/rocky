# Gambit — Database Architecture

> **Status:** Proposed for approval (Milestone 4 gate). Per `docs/ROADMAP.md`, this
> document must be reviewed and approved **before any database code is written**.
> It is the contract the `persistence` package implements and the `api` package
> consumes.

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
  game_id     UUID        NOT NULL,
  seq         INTEGER     NOT NULL,          -- 0-based per-game append index
  type        TEXT        NOT NULL,          -- GameEvent discriminant
  payload     JSONB       NOT NULL,          -- the exact GameEvent object
  server_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, seq)
);
-- Enforce that seq 0 is always a GameCreated event (integrity guard).
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
- **M3 integration (non-breaking):** `GameAuthority` gains an *optional*
  `EventStore` dependency. When present, `createGame`/`applyNow` also
  `append(...)`, and a new `loadGame(gameId)` rehydrates via
  `Game.fromEvents(store.load(...))`. When absent, behaviour is exactly today's
  in-memory path — so all 26 existing M3 tests keep passing unchanged. This is
  wired in the deployable service (M14); the seam lands in M4.

---

## 4. Relational schema (projections + identity)

Games projection (derived from the event log; rebuildable):

```sql
CREATE TABLE games (
  id           UUID PRIMARY KEY,
  variant      TEXT NOT NULL,
  rated        BOOLEAN NOT NULL,
  speed        TEXT NOT NULL,                 -- ultrabullet..classical|correspondence
  white_id     UUID REFERENCES users(id),
  black_id     UUID REFERENCES users(id),
  result       TEXT,                          -- '1-0'|'0-1'|'1/2-1/2'|NULL(ongoing)
  termination  TEXT,
  opening_eco  TEXT,
  ply_count    INTEGER NOT NULL DEFAULT 0,
  last_seq     INTEGER NOT NULL DEFAULT 0,    -- mirrors event-store head
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ
) PARTITION BY RANGE (started_at);            -- monthly partitions
-- BRIN(started_at); btree(white_id), btree(black_id).
```

Identity & authZ:

```sql
users(id UUID PK, handle CITEXT UNIQUE, email_hash BYTEA, created_at,
      country TEXT, flags JSONB DEFAULT '{}')
credentials(user_id UUID REF users, kind TEXT,        -- 'password'
            secret_hash TEXT,                         -- argon2id encoded string
            updated_at, PRIMARY KEY(user_id, kind))
webauthn_credentials(id BYTEA PK, user_id UUID REF users, public_key BYTEA,
            sign_count BIGINT, transports TEXT[], created_at, last_used_at)
sessions(id UUID PK, user_id UUID REF users, refresh_hash TEXT,
            device TEXT, ip INET, created_at, expires_at,
            rotated_from UUID, revoked_at)             -- rotating refresh tokens
roles(user_id UUID REF users, role TEXT,               -- user|coach|td|moderator|admin
            PRIMARY KEY(user_id, role))
ratings(user_id UUID REF users, variant TEXT,
            rating DOUBLE PRECISION, rd DOUBLE PRECISION, vol DOUBLE PRECISION,
            updated_at, PRIMARY KEY(user_id, variant))  -- Glicko-2
seeks(id UUID PK, creator_id UUID REF users, variant, time_control JSONB,
            rated BOOLEAN, min_rating INT, max_rating INT, created_at)
audit_log(id BIGINT PK, actor_id UUID, action TEXT, target TEXT,
            meta JSONB, ts TIMESTAMPTZ DEFAULT now())
```

Reserved for later milestones (created empty/columns only when their milestone
lands, listed here for design coherence): `tournaments*`, `studies*`, `follows`,
`friends`, `messages`, `puzzles`, `openings(embedding vector)`,
`anti_cheat_signals`.

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
- **Sharding path (future, no rewrite):** `game_id` is a UUID; a hash-shard router
  can place events on N Postgres shards keyed by `game_id` because no query spans
  multiple games. Identity stays on a primary cluster.
- **Read replicas** for analytics/leaderboard rebuilds; primary for writes only.

---

## 7. Testing strategy

- **Unit / domain:** `InMemoryEventStore` + pure repository logic — dependency-free,
  run under `node --test` like every existing package.
- **Integration:** ephemeral **real Postgres** (Testcontainers, or a
  docker-compose service in CI) — never a mock — asserting: migrations apply
  cleanly and are idempotent; append/optimistic-concurrency semantics; and the
  **round-trip acceptance test** from the roadmap: *authority → PostgresEventStore
  → `Game.fromEvents` → state identical to the live game* (FEN, ply, clocks, SAN).
- **AuthZ matrix tests** for RBAC; **Glicko-2** verified against a reference vector.
- Tests skip (not fail) integration cases when no `DATABASE_URL` is present, so the
  dependency-free suites still run everywhere.

---

## 8. Package boundaries (what M4 creates)

```
packages/
  persistence/          # NEW — durable data layer (this document)
    src/
      event-store.ts     # EventStore interface + InMemoryEventStore
      pg/                # PostgresEventStore + pool + repositories
      repositories/      # users, sessions, ratings, games, seeks
      migrate.ts         # migration runner
    migrations/*.sql
    test/
  api/                  # NEW — stateless REST service + OpenAPI (built after persistence)
```

`persistence` depends on `@chess-platform/game` (for the `GameEvent` type only)
and `pg`. `api` depends on `persistence`, `@chess-platform/game`, and
`@chess-platform/core`. The domain packages depend on **neither** — the dependency
arrow always points toward the domain.

---

## 9. Open decisions for approval

1. **Driver:** `pg` (node-postgres), hand-written SQL, no ORM. *(recommended)*
2. **Integration test infra:** Testcontainers-node vs. docker-compose service in
   CI. *(recommended: Testcontainers for local+CI parity)*
3. **Event-store ordering key:** `seq` (append index) with `ply` in payload.
   *(recommended — see §3.1)*
4. Build order within M4: **`persistence` first** (schema, migrations, event store,
   repositories, ratings), then **`api`** (identity, REST, OpenAPI). *(recommended)*

Once approved, implementation proceeds package-by-package with the same
"build → self-critique → multi-perspective review" method as M1–M3.
