-- Migration 0014 — search_embeddings table for pgvector semantic search (M11).
-- See docs/DATABASE.md and docs/adr/0059-pgvector-semantic-adapter.md.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE search_embeddings (
  id        TEXT NOT NULL PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
  embedding vector(256) NOT NULL
);

CREATE INDEX search_embeddings_embedding_idx
  ON search_embeddings USING hnsw (embedding vector_cosine_ops);
