-- Migration 0013 — search_documents table for durable keyword (full-text) search (M11).
-- See docs/DATABASE.md and docs/adr/0053-pg-search-repository.md.

CREATE TABLE search_documents (
  id     TEXT  NOT NULL PRIMARY KEY,
  text   TEXT  NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 'simple' config: lowercases + splits on non-word chars, no stemming/stopwords.
  tsv    tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);

CREATE INDEX search_documents_tsv_idx    ON search_documents USING GIN (tsv);
-- fields values are stored lowercased (canonicalized by the adapter) so
-- case-insensitive metadata filters use jsonb containment (`fields @> '{...}'`),
-- which this default-jsonb_ops GIN index serves.
CREATE INDEX search_documents_fields_idx ON search_documents USING GIN (fields);
