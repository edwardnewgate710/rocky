-- Migration 0001 — initial schema for @chess-platform/persistence (Milestone 4).
-- See docs/DATABASE.md and docs/adr/0001-persistence-data-modeling.md.
--
-- Design notes:
--   * The event store (game_events) is the append-only system of record; PK
--     (game_id, seq) gives per-game total ordering + optimistic concurrency.
--   * Controlled values use lookup tables (variants, terminations) + CHECK
--     constraints, NOT native ENUM types (ADR-0001).
--   * Synthetic ids are UUIDv7 generated in the application (native UUID columns).
--   * Partitioning of games/game_events (DATABASE.md §4.2/§6) is a later,
--     non-breaking DDL migration; tables are flat here so `id` has a real UNIQUE
--     PK and foreign keys stay simple. Correct first, scale later.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Lookup / catalog tables (evolving vocabularies)
-- ---------------------------------------------------------------------------
CREATE TABLE variants (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO variants (code, name) VALUES
  ('standard',      'Standard'),
  ('chess960',      'Chess960'),
  ('kingofthehill', 'King of the Hill'),
  ('atomic',        'Atomic'),
  ('crazyhouse',    'Crazyhouse'),
  ('threecheck',    'Three-check'),
  ('horde',         'Horde'),
  ('racingkings',   'Racing Kings');

CREATE TABLE terminations (
  code    TEXT PRIMARY KEY,
  is_draw BOOLEAN NOT NULL
);

INSERT INTO terminations (code, is_draw) VALUES
  ('checkmate',             false),
  ('resignation',           false),
  ('timeout',               false),
  ('stalemate',             true),
  ('agreement',             true),
  ('insufficient_material', true),
  ('fifty_move',            true),
  ('threefold',             true),
  ('variant',               false),
  ('aborted',               false);

-- ---------------------------------------------------------------------------
-- Event store — append-only system of record
-- ---------------------------------------------------------------------------
CREATE TABLE game_events (
  game_id       UUID        NOT NULL,
  seq           INTEGER     NOT NULL,            -- 0-based per-game append index
  type          TEXT        NOT NULL,            -- GameEvent discriminant
  event_version SMALLINT    NOT NULL DEFAULT 1,  -- payload schema version
  payload       JSONB       NOT NULL,            -- the exact GameEvent object
  server_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, seq),
  CONSTRAINT game_events_seq_nonneg  CHECK (seq >= 0),
  CONSTRAINT game_events_version_pos CHECK (event_version >= 1)
);

-- Defense in depth: the event log is append-only. Block UPDATE/DELETE.
CREATE OR REPLACE FUNCTION game_events_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'game_events is append-only (%.% attempted)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_events_block_mutate
  BEFORE UPDATE OR DELETE ON game_events
  FOR EACH ROW EXECUTE FUNCTION game_events_no_mutate();

-- ---------------------------------------------------------------------------
-- Identity & authZ
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id         UUID PRIMARY KEY,                   -- UUIDv7
  handle     CITEXT NOT NULL UNIQUE,
  email_hash BYTEA,
  country    TEXT,
  flags      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('password')),
  secret_hash TEXT NOT NULL,                     -- argon2id encoded string
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE webauthn_credentials (
  id           BYTEA PRIMARY KEY,                -- credential id
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   BYTEA NOT NULL,
  sign_count   BIGINT NOT NULL DEFAULT 0,
  transports   TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX webauthn_user_idx ON webauthn_credentials (user_id);

CREATE TABLE sessions (
  id                UUID PRIMARY KEY,            -- UUIDv7
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash      TEXT NOT NULL,               -- hashed refresh token (never plaintext)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  rotated_from      UUID,
  revoked_at        TIMESTAMPTZ,
  created_ip        INET,
  created_user_agent TEXT,
  last_seen_at      TIMESTAMPTZ,
  last_ip           INET,
  last_user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE UNIQUE INDEX sessions_refresh_hash_idx ON sessions (refresh_hash);

CREATE TABLE roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('user','coach','tournament_director','moderator','admin')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE ratings (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant    TEXT NOT NULL REFERENCES variants(code),
  rating     DOUBLE PRECISION NOT NULL,
  rd         DOUBLE PRECISION NOT NULL,
  vol        DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, variant)
);
CREATE INDEX ratings_leaderboard_idx ON ratings (variant, rating DESC);

-- ---------------------------------------------------------------------------
-- Lobby / seeks
-- ---------------------------------------------------------------------------
CREATE TABLE seeks (
  id           UUID PRIMARY KEY,                 -- UUIDv7
  creator_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant      TEXT NOT NULL REFERENCES variants(code),
  time_control JSONB NOT NULL,
  rated        BOOLEAN NOT NULL,
  min_rating   INTEGER,
  max_rating   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX seeks_created_idx ON seeks (created_at);

-- ---------------------------------------------------------------------------
-- Games projection (derived from the event log; rebuildable)
-- ---------------------------------------------------------------------------
CREATE TABLE games (
  id          UUID PRIMARY KEY,                  -- UUIDv7; equals the event log's game_id
  variant     TEXT NOT NULL REFERENCES variants(code),
  rated       BOOLEAN NOT NULL,
  speed       TEXT NOT NULL
                CHECK (speed IN ('ultrabullet','bullet','blitz','rapid','classical','correspondence')),
  white_id    UUID REFERENCES users(id),
  black_id    UUID REFERENCES users(id),
  result      TEXT CHECK (result IN ('1-0','0-1','1/2-1/2','*')),   -- NULL = ongoing
  termination TEXT REFERENCES terminations(code),
  opening_eco TEXT,
  ply_count   INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ
);
CREATE INDEX games_white_idx   ON games (white_id);
CREATE INDEX games_black_idx   ON games (black_id);
CREATE INDEX games_started_brin ON games USING BRIN (started_at);

-- ---------------------------------------------------------------------------
-- Audit log (observability-rich)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         UUID PRIMARY KEY,                   -- UUIDv7 (time-ordered)
  actor_id   UUID,                               -- NULL for anonymous/system
  action     TEXT NOT NULL,
  target     TEXT,
  meta       JSONB NOT NULL DEFAULT '{}',
  request_id TEXT,
  trace_id   TEXT,
  ip         INET,
  user_agent TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_idx   ON audit_log (actor_id, ts DESC);
CREATE INDEX audit_request_idx ON audit_log (request_id);
CREATE INDEX audit_trace_idx   ON audit_log (trace_id);
