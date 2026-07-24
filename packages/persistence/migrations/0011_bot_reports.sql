-- Migration 0011 — bot_reports table for storing per-player per-game bot behavior reports (M12).
-- See docs/DATABASE.md and docs/adr/0040-bot-detection-persistence-and-api.md.

CREATE TABLE bot_reports (
  player_id  UUID        NOT NULL,
  game_id    UUID        NOT NULL,
  color      TEXT        NOT NULL CHECK (color IN ('white', 'black')),
  report     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);

-- Supports listByPlayer's `WHERE player_id = $1 ORDER BY created_at ASC, game_id ASC`:
-- the primary key alone lets Postgres filter by player_id but still requires a
-- separate sort. `game_id` is the tie-breaker (records from one saveBatch share
-- created_at, since now() is fixed per transaction) so the ordering — and thus
-- pagination — is deterministic.
CREATE INDEX bot_reports_player_created_idx
  ON bot_reports (player_id, created_at, game_id);
