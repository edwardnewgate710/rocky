-- 0017_community.sql: Teams/communities and per-team forum schema

CREATE TABLE community_teams (
    id UUID PRIMARY KEY,
    slug VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    visibility VARCHAR(10) NOT NULL CHECK (visibility IN ('public', 'private')),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX community_teams_slug_idx ON community_teams (slug);
CREATE INDEX community_teams_created_by_idx ON community_teams (created_by);

CREATE TABLE community_memberships (
    team_id UUID NOT NULL REFERENCES community_teams(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (team_id, player_id)
);

CREATE UNIQUE INDEX community_memberships_one_owner_per_team ON community_memberships (team_id) WHERE role = 'owner';
CREATE INDEX community_memberships_player_id_idx ON community_memberships (player_id);

CREATE TABLE community_join_requests (
    id UUID PRIMARY KEY,
    team_id UUID NOT NULL REFERENCES community_teams(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX community_join_requests_one_pending_per_player ON community_join_requests (team_id, player_id) WHERE status = 'pending';
CREATE INDEX community_join_requests_team_status_idx ON community_join_requests (team_id, status);
CREATE INDEX community_join_requests_player_id_idx ON community_join_requests (player_id);

CREATE TABLE community_forum_threads (
    id UUID PRIMARY KEY,
    team_id UUID NOT NULL REFERENCES community_teams(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_post_at TIMESTAMPTZ NOT NULL,
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX community_forum_threads_list_idx ON community_forum_threads (team_id, pinned DESC, last_post_at DESC, id ASC);
CREATE INDEX community_forum_threads_author_id_idx ON community_forum_threads (author_id);

CREATE TABLE community_forum_posts (
    id UUID PRIMARY KEY,
    thread_id UUID NOT NULL REFERENCES community_forum_threads(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX community_forum_posts_list_idx ON community_forum_posts (thread_id, created_at ASC, id ASC);
CREATE INDEX community_forum_posts_author_id_idx ON community_forum_posts (author_id);
