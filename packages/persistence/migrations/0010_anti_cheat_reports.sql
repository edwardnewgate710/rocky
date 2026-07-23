-- Migration 0010 — anti_cheat_reports table for storing per-player per-game correlation reports (M12).
-- See docs/DATABASE.md and docs/adr/0033-anticheat-persistence-and-moderation-api.md.

CREATE TABLE anti_cheat_reports (
  player_id  UUID        NOT NULL,
  game_id    UUID        NOT NULL,
  color      TEXT        NOT NULL CHECK (color IN ('white', 'black')),
  report     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);

-- Supports listByPlayer's `WHERE player_id = $1 ORDER BY created_at ASC`: the
-- primary key alone lets Postgres filter by player_id but still requires a
-- separate sort on created_at without this index.
CREATE INDEX anti_cheat_reports_player_created_idx
  ON anti_cheat_reports (player_id, created_at);
