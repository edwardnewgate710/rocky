-- ---------------------------------------------------------------------------
-- Seeks: creator color preference
-- ---------------------------------------------------------------------------
-- Adds the creator's requested side to a seek. `random` (the default) lets the
-- pairing step assign colors; `white`/`black` request a specific side. The
-- NOT NULL DEFAULT keeps existing rows and clients that omit the field on the
-- prior behavior.
ALTER TABLE seeks
  ADD COLUMN color TEXT NOT NULL DEFAULT 'random'
    CHECK (color IN ('white', 'black', 'random'));
