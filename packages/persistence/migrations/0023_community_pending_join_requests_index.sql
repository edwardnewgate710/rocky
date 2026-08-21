-- migrate:online-index community_join_requests_pending_by_player_idx
CREATE INDEX CONCURRENTLY community_join_requests_pending_by_player_idx
    ON community_join_requests (player_id, created_at DESC, id ASC)
    WHERE status = 'pending';
