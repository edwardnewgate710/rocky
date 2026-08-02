-- 0019_studies.sql: Studies, chapters, collaborators, and move tree schema

CREATE TABLE studies (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    visibility VARCHAR(10) NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ
);

-- Index referencing FK owner_id to speed up cascading deletes from users and queries by owner.
CREATE INDEX studies_owner_id_idx ON studies (owner_id);

CREATE TABLE study_collaborators (
    study_id UUID NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(15) NOT NULL CHECK (role IN ('owner', 'contributor', 'viewer')),
    PRIMARY KEY (study_id, player_id)
);

-- Partial unique index enforcing exactly one owner per study.
CREATE UNIQUE INDEX study_collaborators_one_owner_per_study ON study_collaborators (study_id) WHERE (role = 'owner');

-- Index referencing FK player_id to speed up cascading deletes when a user is removed.
-- Note: study_id does not need a separate index because PRIMARY KEY (study_id, player_id) already leads with study_id.
CREATE INDEX study_collaborators_player_id_idx ON study_collaborators (player_id);

CREATE TABLE study_chapters (
    id UUID PRIMARY KEY,
    study_id UUID NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    order_index INTEGER NOT NULL,
    starting_fen TEXT NOT NULL,
    deleted_at TIMESTAMPTZ
);

-- Partial unique index enforcing dense unique order_index per active chapter within a study.
CREATE UNIQUE INDEX study_chapters_study_id_order_index_idx ON study_chapters (study_id, order_index) WHERE (deleted_at IS NULL);

-- Index referencing FK study_id to speed up cascading deletes for tombstoned chapters (which are excluded by the partial unique index above).
CREATE INDEX study_chapters_study_id_idx ON study_chapters (study_id);

CREATE TABLE study_tree_nodes (
    id UUID PRIMARY KEY,
    chapter_id UUID NOT NULL REFERENCES study_chapters(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES study_tree_nodes(id) ON DELETE CASCADE,
    san TEXT NOT NULL,
    fen_after TEXT NOT NULL,
    comment TEXT,
    nags INTEGER[] NOT NULL DEFAULT '{}',
    order_index INTEGER NOT NULL
);

-- Composite index to load all nodes of a chapter ordered by parent and sibling order in a single query.
-- Also satisfies FK chapter_id cascade checks because chapter_id is the leading column.
CREATE INDEX study_tree_nodes_chapter_parent_order_idx ON study_tree_nodes (chapter_id, parent_id, order_index);

-- Index referencing FK parent_id to speed up cascading self-reference deletes when parent nodes are deleted.
CREATE INDEX study_tree_nodes_parent_id_idx ON study_tree_nodes (parent_id);
