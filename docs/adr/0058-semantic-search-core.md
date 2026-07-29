# ADR-0058 — Semantic and Hybrid Search Domain Core

| Field      | Value                          |
|------------|--------------------------------|
| **Status** | Accepted                       |
| **Date**   | 2026-07-29                     |
| **Scope**  | `@chess-platform/search` (M11) |

---

## Context

Milestone 11 Increments 1–8 established pure keyword search (`search`), search query normalization (`parseNaturalQuery`), async repository ports (`SearchRepository`), Postgres FTS (`PgSearchRepository`), REST endpoints (`GET /v1/search`), entity search projections, keyset backfill, and live indexing (`SearchIndexWorker`).

The remaining half of M11 search capabilities is **semantic (vector) search** and **hybrid search** (fusing keyword FTS and vector search). While the ultimate production adapter will utilize Postgres `pgvector`, domain search logic must be fully testable offline in CI without an external database, model server, or API key.

## Decision

1. **Pure Vector Math (`packages/search/src/vector.ts`)**:
   - `Vector` type defined as `readonly number[]`.
   - Pure vector operations: `dot`, `magnitude` (Euclidean L2 norm), `cosineSimilarity` (bounded in `[-1, 1]`), and `normalize` (unit vector).
   - **Dimension Mismatch & Non-Finite Validation**: `dot` and `cosineSimilarity` throw `RangeError` with explicit length details (e.g. `3 !== 2`) on dimension mismatch. All vector functions invoke a shared `assertFinite` helper that throws `RangeError` if any component is `NaN`, `Infinity`, or `-Infinity`, preventing corrupted float scores from propagating.
   - **Zero-Vector & Empty-Vector Safety**: Zero-magnitude vectors return `0` similarity (never `NaN`) and normalize to zero vectors of equal length. Empty vectors (`[]`) return `0` for dot/magnitude/cosineSimilarity and `[]` for normalize.
   - **Overflow-Safe Ratios**: `cosineSimilarity` and `normalize` divide each vector by its largest absolute component before squaring anything. Squaring first overflows for inputs that are entirely finite — `[MAX_VALUE, MAX_VALUE]` yields an infinite norm, so cosine similarity became `Infinity / Infinity = NaN` and `normalize` silently returned a zero vector. Both outcomes defeat the `assertFinite` guarantee above. Scaling cancels out of a ratio, so ordinary inputs are unaffected, and post-scaling every component lies in `[-1, 1]`, so the accumulated sums cannot overflow. The magnitudes are combined as `sqrt(sumSqA * sumSqB)` rather than `sqrt(sumSqA) * sqrt(sumSqB)`, because the latter makes a vector's similarity with itself `0.9999999999999998`. `magnitude` itself is left free to return `Infinity`, which is the honest IEEE-754 answer for a norm that does not fit a double; only the ratio consumers scale.

2. **Embedding Provider Port & Offline Hashing Adapter (`packages/search/src/embedding.ts`)**:
   - `EmbeddingProvider` interface: `dimensions: number`, `embed(text: string): Promise<Vector>`, `embedAll(texts: readonly string[]): Promise<readonly Vector[]>`.
   - **Async Port Rationale**: The port is `Promise`-returning to allow future external embedding adapters (OpenAI, Cohere, local model servers) to perform network I/O. The `@chess-platform/search` package remains 100% dependency-free with zero I/O or network code.
   - **Offline `HashingEmbeddingProvider`**: Implements a classic feature hashing vectorizer ("hashing trick") using a deterministic 32-bit FNV-1a string hash (`fnv1a32`) with `Math.imul` and `>>> 0`.
   - **Bounded Dimensions**: `dimensions` must be an integer in `[1, 16000]`. An unbounded "positive safe integer" check was not self-consistent: `2 ** 32` passed validation and then failed with `Invalid array length` on the first `embed()` call, far from the mistake. The ceiling is exactly pgvector's storage limit for the `vector` type, so anything this package accepts can always be persisted by the Increment 10 adapter — a rounder 16384 would have left 384 values that validate here and cannot be stored there. pgvector separately caps *indexed* vectors at 2000 dimensions, but exact nearest-neighbour search still works above that, so it is an adapter-level constraint to enforce in Increment 10 rather than a domain one.
   - **Honest Limitations**: The hashing trick captures token presence and lexical co-occurrence in bucket space, but does *not* capture deep language-model semantics (synonyms, contextual intent). It exists strictly to provide an offline, zero-dependency semantic execution path so the full hybrid pipeline can be tested deterministically in CI. A real embedding model server is a drop-in replacement behind `EmbeddingProvider`.

3. **Pure Semantic Search Ranker (`packages/search/src/semantic.ts`)**:
   - `SemanticSearchableDocument` extends `SearchableDocument` with `readonly embedding: Vector`.
   - `semanticSearch(queryVector, documents, options)` ranks documents by cosine similarity.
   - **Filter Sharing**: Extracted `src/filters.ts` (`matchesAllFilters`, `matchesFilter`, `getFieldValue`) shared between `search.ts` and `semantic.ts` without modifying `search.ts` external behavior.
   - **Thresholding & Sorting**: Drops hits strictly below `options.minScore` (if provided). A non-finite `minScore` throws `RangeError` rather than being applied: `score < NaN` is false for every document, so a `NaN` threshold would silently return the entire index instead of filtering it — the same silent-corruption class `assertFinite` guards against. Sorts results by `score DESC`, tie-broken deterministically by `id ASC`.
   - **Dimension Mismatch**: Vector length mismatches propagate `RangeError` from `cosineSimilarity` to catch caller indexing bugs.

4. **Hybrid Search via Reciprocal Rank Fusion (`packages/search/src/hybrid.ts`)**:
   - `hybridSearch(query, queryVector, documents, options)` fuses keyword search and semantic vector search.
   - **Why RRF Instead of Weighted Score Addition**: Keyword FTS scores are unbounded term-frequency counts (e.g. 0, 1, 3, 5+), whereas cosine similarity scores are bounded in `[-1, 1]`. Adding raw scores directly with static weights is scale-broken because term counts scale arbitrarily with text length and query term counts, overpowering vector similarity. Reciprocal Rank Fusion (RRF) combines results by **1-based rank position** (`weight / (rrfK + rank)`), providing scale-invariant fusion across different search modalities.
   - **Union Semantics**: Fused score is a UNION (documents found by either signal contribute rank score).
   - **Validation & Weight Extremes**: Validates `keywordWeight` in `[0, 1]` and `rrfK > 0` (throwing `RangeError` on invalid values). `keywordWeight: 1` reproduces exact keyword ordering; `keywordWeight: 0` reproduces exact semantic ordering.

5. **Semantic Search Repository Port & In-Memory Adapter (`packages/search/src/semantic-repository.ts`)**:
   - `SemanticSearchRepository` interface declaring `index`, `indexAll`, `remove`, `clear`, `size`, `querySemantic`, and `queryHybrid`.
   - **pgvector Compatibility Contract**: Documented that future `pgvector` adapters (Increment 10) using cosine distance (`<=>`) must compute `1 - distance` so that higher scores consistently represent higher similarity across all implementations.
   - `InMemorySemanticSearchRepository` provides Map-backed storage.
   - **Write-Time Dimension Validation**: The index latches its dimension on the first document written and rejects any later document whose embedding differs, with a `RangeError` naming the document. Without this, a single bad write is not a local failure: queries compare the query vector against *every* stored embedding, so the `RangeError` from `cosineSimilarity` would make every subsequent `querySemantic`/`queryHybrid` call fail for the entire repository. An empty index has not committed to a dimension, so it is released whenever the index becomes empty — by `clear()` or by removing the last document, which must land in the same state. Postgres adapters get this property for free — pgvector fixes the dimension in the migration.
   - **Shared Pagination Contract (`packages/search/src/pagination.ts`)**: `SearchOptions`, `SearchPage`, and the `paginate` helper moved out of `repository.ts` (which re-exports the two types, so no public API changed) and are now used by BOTH `InMemorySearchRepository` and `InMemorySemanticSearchRepository`. The clamping rules — negative `offset`/`limit` clamp to `0`, an omitted `limit` returns all remaining hits, and `total` always counts hits before pagination — are one piece of knowledge in one place, so the keyword and semantic repositories cannot drift apart and Postgres adapters have a single contract to reproduce.

6. **Deferred**:
   - `pgvector` database migration and `PgSemanticSearchRepository` adapter deferred to Increment 10.
   - REST API wiring (`GET /v1/search` hybrid mode) deferred to Increment 11.

## Consequences

- `@chess-platform/search` gains pure vector math, embedding provider port, hashing vectorizer, semantic search, RRF hybrid search, and semantic repository port with zero external npm or Node dependencies.
- Vector and hybrid search pipelines are 100% testable offline in CI.
- Keyword and semantic rankers share filter logic cleanly via `src/filters.ts`.
- Non-finite vectors and dimension mismatches fail fast with `RangeError` instead of producing corrupted scores.
