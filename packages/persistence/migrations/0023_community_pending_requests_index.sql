-- Support requester-scoped pending join-request pagination while terminal history is retained.
CREATE INDEX community_join_requests_pending_by_player_idx
    ON community_join_requests (player_id, created_at DESC, id ASC)
    WHERE status = 'pending';
