-- 0018_achievements.sql: Player achievements progress and unlock state

CREATE TABLE achievement_progress (
    player_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_key TEXT NOT NULL,
    progress INTEGER NOT NULL CHECK (progress >= 0),
    unlocked_at TIMESTAMPTZ,
    PRIMARY KEY (player_id, achievement_key)
);

-- No listing index, and no separate foreign-key index either. Both would be pure write cost:
--
--   * The primary key (player_id, achievement_key) leads with player_id, so it already serves both
--     the FK's cascading delete and the only query this table has — `WHERE player_id = $1`.
--   * That query carries no ORDER BY. The catalogue lives in code, not in rows, so a listing has to
--     merge these rows with definitions the database has never seen, including achievements with no
--     row at all. The merge and the ordering therefore happen in the adapter, and an ORDER BY index
--     here would never be consulted while still costing a write on every award.
--
-- This is the only moment that choice can be made: the migration runner records a checksum and
-- refuses to re-run an edited migration.
