-- Shared fixed-window counters for API rate limiting. PostgreSQL is already a
-- required API dependency, so this keeps limits consistent across replicas.
CREATE TABLE rate_limit_buckets (
  bucket_key        TEXT PRIMARY KEY,
  request_count     INTEGER NOT NULL CHECK (request_count > 0),
  window_started_at TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets (expires_at);
