-- Add game_id as a tie-breaker to the anti_cheat_reports listByPlayer index so
-- `ORDER BY created_at ASC, game_id ASC` is deterministic (records from one
-- saveBatch share created_at, since now() is fixed per transaction).
DROP INDEX IF EXISTS anti_cheat_reports_player_created_idx;
CREATE INDEX anti_cheat_reports_player_created_idx
  ON anti_cheat_reports (player_id, created_at, game_id);
