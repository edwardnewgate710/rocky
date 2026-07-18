-- Optimistic-concurrency version for tournaments (ADR-0025).
-- DEFAULT 1, not 0: expectedVersion 0 means "create new" in the repository
-- contract, so pre-existing rows must start at 1 to stay updatable.
ALTER TABLE tournaments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
