-- Server-authoritative, private Study Partner v1 sessions.
CREATE TABLE study_partner_sessions (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    variant TEXT NOT NULL CHECK (variant = 'standard'),
    initial_fen TEXT NOT NULL,
    current_fen TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
    version INTEGER NOT NULL CHECK (version >= 0),
    turn_count INTEGER NOT NULL CHECK (turn_count BETWEEN 0 AND 20),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK ((status = 'active' AND completed_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL))
);

CREATE INDEX study_partner_sessions_owner_id_idx
    ON study_partner_sessions (owner_id);

-- A durable claim exists before CoachService can charge or begin expensive work. An accepted
-- request is intentionally never reclaimed: after an ambiguous process failure, refusing a
-- duplicate is safer than purchasing the same coaching operation twice. A stale claimed request is
-- failed transactionally by claimTurn because claimed is provably before charge acceptance.
CREATE TABLE study_partner_turn_requests (
    session_id UUID NOT NULL REFERENCES study_partner_sessions(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
    status TEXT NOT NULL CHECK (status IN ('claimed', 'accepted', 'succeeded', 'failed')),
    turn_id UUID,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (session_id, idempotency_key),
    UNIQUE (turn_id),
    CHECK ((status = 'succeeded' AND turn_id IS NOT NULL)
        OR (status <> 'succeeded' AND turn_id IS NULL))
);

CREATE UNIQUE INDEX study_partner_one_active_turn_request_idx
    ON study_partner_turn_requests (session_id)
    WHERE status IN ('claimed', 'accepted');

CREATE TABLE study_partner_turns (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES study_partner_sessions(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL CHECK (turn_number BETWEEN 1 AND 20),
    move VARCHAR(6) NOT NULL,
    fen_before TEXT NOT NULL,
    fen_after TEXT NOT NULL,
    coaching_version INTEGER NOT NULL CHECK (coaching_version = 1),
    coaching JSONB NOT NULL CHECK (jsonb_typeof(coaching) = 'object'),
    session_version INTEGER NOT NULL CHECK (session_version >= 1),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (session_id, turn_number),
    UNIQUE (session_id, session_version)
);

ALTER TABLE study_partner_turn_requests
    ADD CONSTRAINT study_partner_turn_requests_turn_fk
    FOREIGN KEY (turn_id) REFERENCES study_partner_turns(id) ON DELETE CASCADE;
