-- Durable engine analysis cache (ADR-0135).
--
-- One row per analysis identity. The identity is the whole of what makes two searches
-- interchangeable: the engine build fingerprint, the variant, the MultiPV width, and the
-- position. Anything less would serve a result produced by a different engine, under
-- different rules, or for a different number of lines.
--
-- The achieved_* columns record what the stored search actually reached, not what its caller
-- asked for. They are the only basis on which a later request may be answered from this table,
-- so they are stored as separate comparable columns rather than inside the JSON payload.
CREATE TABLE engine_analysis_cache (
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 128),
    variant TEXT NOT NULL CHECK (length(variant) BETWEEN 1 AND 64),
    multi_pv INTEGER NOT NULL CHECK (multi_pv >= 1),
    -- Bounded so the primary key can never exceed the btree row limit. A FEN for any variant
    -- this platform serves is under 120 characters; a longer one is not a position.
    fen TEXT NOT NULL CHECK (length(fen) BETWEEN 1 AND 256),

    -- NULL means "this search reached no stated bound in this dimension", which satisfies only a
    -- request that asks nothing of it. AnalysisLimits requires at least one dimension, so a row
    -- with all three NULL could never answer any request and is refused outright.
    achieved_depth INTEGER CHECK (achieved_depth IS NULL OR achieved_depth >= 0),
    achieved_nodes BIGINT CHECK (achieved_nodes IS NULL OR achieved_nodes >= 0),
    achieved_time_ms BIGINT CHECK (achieved_time_ms IS NULL OR achieved_time_ms >= 0),
    CHECK (num_nonnulls(achieved_depth, achieved_nodes, achieved_time_ms) >= 1),

    -- The serialization contract of `results`, versioned independently of the schema so a reader
    -- that does not understand a payload treats it as a miss instead of casting it to a type it
    -- has not verified. Deliberately not pinned to a single value: a rolling deploy must be able
    -- to write a newer payload version against a schema an older reader still runs on.
    payload_version INTEGER NOT NULL CHECK (payload_version >= 1),
    results JSONB NOT NULL CHECK (jsonb_typeof(results) = 'array'),

    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (fingerprint, variant, multi_pv, fen)
);
