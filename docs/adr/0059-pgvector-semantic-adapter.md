# ADR-0059 — pgvector Semantic and Hybrid Search Adapter

| Field      | Value                                |
|------------|--------------------------------------|
| **Status** | Accepted                             |
| **Date**   | 2026-07-29                           |
| **Scope**  | `@chess-platform/persistence` (M11) |

---

## Context

Milestone 11 Increment 9 (ADR-0058) added the pure-domain vector core in `@chess-platform/search` (`Vector`, `cosineSimilarity`, `EmbeddingProvider` port, `semanticSearch`, `hybridSearch` RRF ranker, and `SemanticSearchRepository` port with `InMemorySemanticSearchRepository`). Milestone 11 Increment 5 (ADR-0053) added the keyword Postgres adapter `PgSearchRepository` over a `search_documents` PostgreSQL table.

This increment implements the durable, PostgreSQL-backed semantic and hybrid search adapter (`PgSemanticSearchRepository`) using the `pgvector` extension in `@chess-platform/persistence` under the `/pg` subpath.

## Decision

### 1. Schema & Migration (`migrations/0014_search_embeddings.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE search_embeddings (
  id        TEXT NOT NULL PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
  embedding vector(256) NOT NULL
);

CREATE INDEX search_embeddings_embedding_idx
  ON search_embeddings USING hnsw (embedding vector_cosine_ops);
```

**Rationale**:
- **Separate table (`search_embeddings`), not a column on `search_documents`**: Keeps `remove(id)` and `clear()` on the semantic repository honest — they drop embeddings from the semantic index without deleting the underlying keyword document in `search_documents`. Foreign key with `ON DELETE CASCADE` keeps the two tables in sync when a document is deleted from keyword search.
- **No duplicated text/fields**: Document text and metadata fields live exclusively in `search_documents`. Semantic queries perform a `JOIN search_documents d ON d.id = e.id` when filtering by jsonb metadata fields.
- **Fixed dimension `vector(256)`**: `pgvector` requires a fixed dimension at DDL time to build index structures. 256 matches `HashingEmbeddingProvider` default. Changing vector dimension in the future will require a new schema migration.
- **HNSW index (`vector_cosine_ops`)**: HNSW (Hierarchical Navigable Small World) provides high recall and low query latency without requiring a pre-training step. Unlike IVFFlat, building an HNSW index on an empty table produces a valid index that remains usable as data is inserted. Cosine distance operator (`<=>`) is indexed via `vector_cosine_ops`.

### 2. PgSemanticSearchRepository Implementation (`packages/persistence/src/pg/semantic-search.ts`)

Implements `SemanticSearchRepository` constructed with a `pg.Pool`. Exported via `@chess-platform/persistence/pg`.

- **Vector Serialization**: Vector arrays are formatted to pgvector string representations (`[0.1,0.2,...]`) via a dedicated `formatPgVector` helper and passed as parameterized values with `$N::vector` casts. No floating point numbers are interpolated directly into SQL text.
- **Transactional Upserts (`index`, `indexAll`)**: `index(doc)` executes upserts into `search_documents` and `search_embeddings` inside a single transaction (`BEGIN` ... `COMMIT`). `indexAll(docs)` batch-upserts within a single transaction. Fields are canonicalized to lower-case via `canonicalizeFields` so GIN-indexed jsonb containment queries (`fields @> ...`) remain case-insensitive.
- **Selective Deletions (`remove`, `clear`)**: `remove(id)` executes `DELETE FROM search_embeddings WHERE id = $1` and returns `rowCount > 0`. `clear()` executes `DELETE FROM search_embeddings`. Both operate strictly on semantic embeddings and preserve keyword search documents.
- **Semantic Queries (`querySemantic`)**:
  - Distance to similarity conversion: pgvector cosine distance (`e.embedding <=> $q::vector`) is mapped to cosine similarity via `1 - (e.embedding <=> $q::vector)` so that higher scores represent higher similarity ("higher score = more similar").
  - `minScore` thresholding: Converted to a bare-operator distance predicate (`e.embedding <=> $q::vector <= 1 - minScore`) so the query structure remains index-friendly. Validates that `minScore` is finite, throwing `RangeError` otherwise.
  - JSONB filter matching: Applies lowercased jsonb containment (`d.fields @> ...` or `NOT (d.fields @> ...)`) matching the keyword search filter pattern.
  - Pagination & Total: Slices results with `LIMIT` and `OFFSET` (clamping negative values to 0), returning a count of total matching hits before pagination.

### 3. Fused Hybrid Search in SQL (`queryHybrid`)

Reproduces Reciprocal Rank Fusion (RRF) using PostgreSQL Common Table Expressions (CTEs):

```sql
WITH kw AS (
  SELECT d.id, row_number() OVER (ORDER BY <ts_rank expr> DESC, d.id ASC) AS rnk
    FROM search_documents d WHERE <kw_where>
), vec AS (
  SELECT e.id, row_number() OVER (ORDER BY e.embedding <=> $q::vector ASC, e.id ASC) AS rnk
    FROM search_embeddings e JOIN search_documents d ON d.id = e.id WHERE <vec_where>
), fused AS (
  SELECT COALESCE(kw.id, vec.id) AS id,
         COALESCE($kwWeight::float8 / ($rrfK::float8 + kw.rnk), 0::float8)
       + COALESCE((1 - $kwWeight::float8) / ($rrfK::float8 + vec.rnk), 0::float8) AS score
    FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
)
SELECT id, score FROM fused WHERE score > 0 ORDER BY score DESC, id ASC LIMIT ... OFFSET ...
```

- **Shared Query Construction**: Reuses `buildTsqueryExpr` and `buildJsonbFilterClauses` from `search-helpers.ts` to ensure full-text tsquery generation (`plainto_tsquery` + `phraseto_tsquery`) and field filtering do not drift between keyword and hybrid adapters.
- **Filters constrain BOTH branches — a correction to ADR-0058.** `query.filters` (e.g. a `variant:blitz` parsed out of the query text) and `options.filters` are both applied to the `kw` *and* `vec` CTEs. The original `hybridSearch` in ADR-0058 applied `query.filters` to the keyword branch only, so a document violating a hard constraint could re-enter through the vector branch and surface in the fused result. That was a real defect, not a deliberate asymmetry: terms and phrases are the relevance signal the vector branch legitimately bypasses, whereas filters are constraints. Fixed in the domain `hybridSearch` and mirrored here, with a regression test at both layers.
- **RRF Parameters & Extreme Weights**: Defaults to `keywordWeight: 0.5` and `rrfK: 60`. Throws `RangeError` for invalid parameters. Filtering `WHERE score > 0` ensures `keywordWeight: 1` returns strictly keyword hits and `keywordWeight: 0` returns strictly vector hits.

### 4. Index Usability & Planner Mechanics — measured, not assumed

Measured on pgvector 0.8.5 / Postgres 16, 5,000 rows of random 256-dimension vectors, `ANALYZE`d,
via `EXPLAIN (ANALYZE, COSTS OFF)`. Four shapes were compared to find what actually decides whether
the HNSW index is used:

| Query shape | Plan | Time |
|---|---|---|
| `ORDER BY embedding <=> $q LIMIT 10` | `Index Scan using search_embeddings_embedding_idx` | 0.48 ms |
| join `search_documents`, no tie-break | `Index Scan using search_embeddings_embedding_idx` | 0.43 ms |
| join + jsonb `@>` filter, no tie-break | `Index Scan` on both the HNSW index and `search_documents_pkey` | 0.18 ms |
| **join + `, d.id` tie-break (the adapter's shape)** | **`Sort` (top-N heapsort) over a `Seq Scan` of all 5,000 rows** | **5.89 ms** |

**The `id` tie-break alone is what defeats the index.** Neither the join nor the jsonb containment
filter does — both keep the `Index Scan`. Adding any second `ORDER BY` key makes the ordering
something the ANN index cannot supply, so the planner falls back to sorting the whole table.

**Decision: keep the tie-break, accept the sequential scan, and say so plainly.** The HNSW index is
therefore *not currently exercised by any adapter query*. It is created anyway because it is a
prerequisite for the fast path below and is cheap at present volumes.

The obvious fix — take ANN candidates through the index without the tie-break in an inner query,
then re-sort that small window with `dist, id` — is deliberately **not** applied here, because it
trades exactness for recall in a way that needs its own decision: pgvector 0.8's iterative index
scans are off by default (`hnsw.iterative_scan = off`), so an inner `LIMIT` combined with a filter
can return *fewer* rows than requested when filtered-out rows consume the candidate budget. The
current shape is always exact. Reworking it means choosing a recall policy, tuning `ef_search`, and
testing under-return behaviour — an increment, not a footnote. Tracked as follow-up.

At current data volumes the cost is single-digit milliseconds; this becomes worth fixing when
`search_embeddings` reaches a scale where a full scan per query is not acceptable.

- **Approximate vs Exact Results**: pgvector HNSW queries return Approximate Nearest Neighbours,
  whereas `InMemorySemanticSearchRepository` computes exact brute-force cosine similarity — so
  ordering among closely-scored vectors can legitimately differ between the two adapters. Note that
  while the adapter keeps the tie-break and therefore scans exhaustively, its results are currently
  *exact* rather than approximate; that changes if the fast path above is ever adopted.

## Consequences

- Durable, index-backed semantic and hybrid search is available in `@chess-platform/persistence/pg`.
- PostgreSQL database installations require the `vector` extension (provided by `pgvector/pgvector:pg16`).
- Domain package `@chess-platform/search` remains pure and free of database dependencies.
