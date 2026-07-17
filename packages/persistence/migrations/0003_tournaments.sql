-- ---------------------------------------------------------------------------
-- Tournaments: Snapshot-based persistence
-- ---------------------------------------------------------------------------

-- `id` is the domain's opaque tournament id (`TournamentConfig.id: string`),
-- not a synthetic UUID key — the API happens to generate UUIDs, but the domain
-- allows any string, so the column is TEXT to persist whatever the aggregate holds.
CREATE TABLE tournaments (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  format            TEXT NOT NULL,
  state             TEXT NOT NULL,
  participant_count INTEGER NOT NULL DEFAULT 0,
  snapshot          JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tournaments_format_check CHECK (format IN ('round_robin', 'swiss')),
  CONSTRAINT tournaments_state_check  CHECK (state IN ('registration', 'running', 'finished'))
);

CREATE INDEX tournaments_created_at_idx ON tournaments (created_at DESC);
