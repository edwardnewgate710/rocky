# ADR-0060 — REST Endpoint Wiring for Semantic and Hybrid Search

| Field      | Value                      |
|------------|----------------------------|
| **Status** | Accepted                   |
| **Date**   | 2026-08-01                 |
| **Scope**  | `@chess-platform/api` (M11)|

---

## Context

Milestone 11 Increment 9 (ADR-0058) created the pure domain vector core in `@chess-platform/search` (`Vector`, `EmbeddingProvider` port, `semanticSearch`, `hybridSearch` RRF fusion, `SemanticSearchRepository` port, and `InMemorySemanticSearchRepository`).
Milestone 11 Increment 10 (ADR-0059) implemented the PostgreSQL `pgvector` adapter (`PgSemanticSearchRepository`) and schema migration `0014_search_embeddings.sql` (`vector(256)`, HNSW index) in `@chess-platform/persistence/pg`.

Prior to this increment, `GET /v1/search` in `@chess-platform/api` supported keyword search exclusively via `SearchRepository.query()`. This increment exposes semantic vector search and fused hybrid search on the public REST API contract via `GET /v1/search`.

## Decision

### 1. Unified Endpoint via `mode` Query Parameter

Rather than exposing separate REST routes (e.g. `/v1/search/semantic`), `GET /v1/search` accepts an optional `mode` query parameter:

- `keyword` (DEFAULT, and when `mode` is absent or empty): exact byte-for-byte existing keyword search behavior.
- `semantic`: vector nearest-neighbour search via `SemanticSearchRepository.querySemantic`.
- `hybrid`: Reciprocal Rank Fusion (RRF) combining keyword full-text search and vector similarity via `SemanticSearchRepository.queryHybrid`.

**Rationale**:
- **Single Search Entrypoint**: Consumers (web frontend, mobile clients, external API consumers) use a single endpoint and select search modalities dynamically via query parameters.
- **Backward Compatibility**: Omitted `mode` defaults to `keyword`, guaranteeing zero regression for existing clients.
- **Input Validation**: Unknown `mode` values (e.g. `mode=bogus`) immediately return HTTP 422 with a structured validation error (`"mode" must be one of keyword, semantic, hybrid`).

### 2. Selective Relevance Embedding Input

When computing the vector for `semantic` or `hybrid` mode, the API does **NOT** embed the raw query string `q`.

`parseNaturalQuery(q)` separates user input into relevance terms, phrases, and structured filters (e.g. `q="tactics variant:blitz"` yields `terms: ["tactics"]` and `filters: [{ field: "variant", value: "blitz" }]`).
Structured filter tokens (like `variant:blitz`) represent strict database constraints, not relevance signals. Feeding filter tokens into a feature-hashing or model embedder introduces pure noise into vector distance calculations.

The API builds vector input from relevance terms and phrases:
```ts
const relevanceText = [...query.terms, ...query.phrases].join(' ');
const vector = await embeddingProvider.embed(relevanceText !== '' ? relevanceText : q.trim());
```
If `terms` and `phrases` are both empty (e.g. user typed only filters like `q="variant:blitz"`), it falls back to trimmed raw `q` so the embedder never receives an empty string.

### 3. Filter Application in Semantic Mode

- **Semantic Mode**: Passes `filters: query.filters` in `SemanticSearchOptions` to `querySemantic`. Filters constrain candidate documents before vector ranking so query filters (e.g. `variant:blitz`) are strictly enforced.
- **Hybrid Mode**: `queryHybrid(query, vector, { limit, offset })` already merges `query.filters` internally across both the keyword and vector CTE branches (per ADR-0059), so `query.filters` are NOT passed twice in options.

### 4. Dimensionality Coupling & Export (`SEARCH_EMBEDDING_DIMENSIONS`)

Exported named constant `SEARCH_EMBEDDING_DIMENSIONS = 256` from `@chess-platform/search` (re-exported via package index):

```ts
/**
 * Default vector dimensionality for search embeddings (256).
 *
 * NOTE ON COUPLING:
 * This value is strictly coupled to the `vector(256)` column in
 * `packages/persistence/migrations/0014_search_embeddings.sql`.
 * Changing this constant REQUIRES a corresponding database migration to alter
 * the pgvector column width and rebuild the HNSW index.
 */
export const SEARCH_EMBEDDING_DIMENSIONS = 256;
```

Both production bootstrap (`bootstrap.ts`) and test harness (`helpers.ts`) consume `SEARCH_EMBEDDING_DIMENSIONS` when constructing `HashingEmbeddingProvider`.

### 5. Dependency Injection & Opt-Out Configuration

Added `semanticSearchRepository?: SemanticSearchRepository` and `embeddingProvider?: EmbeddingProvider` to `ApiDependencies`, `RouteDeps`, and `PgBootstrapOptions`.

- **Opt-Out Pattern**: Gated on `SEMANTIC_SEARCH_ENABLED !== '0'` (matching `SEARCH_ENABLED`). When enabled, defaults to `new PgSemanticSearchRepository(pool)` and `new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS)`.
- **Reachable from the chart**: the switch is wired through Helm as `search.semanticEnabled`
  (default `true`), rendering `SEMANTIC_SEARCH_ENABLED=0` on the API Deployment only when search
  itself is still enabled — `search.enabled=false` already prevents the semantic repository being
  constructed, so emitting both would be redundant. ADR-0057 fixed exactly this class of gap for
  `SEARCH_ENABLED`: an env var no supported deployment can set is a half-built switch. Covered by
  four new assertions in `scripts/helm-snapshot-test.sh` (43 total).
- **503 Unavailable Guard**: If `mode=semantic` or `mode=hybrid` is requested but either `deps.semanticSearchRepository` or `deps.embeddingProvider` is missing, the route responds HTTP 503 (`semantic search is not configured`). `mode=keyword` independently checks `deps.searchRepository`.
- **Strict TypeScript**: Optional dependencies use conditional spreads (`...(semanticSearchRepository ? { semanticSearchRepository } : {})`) to satisfy `exactOptionalPropertyTypes`.

### 6. Population Gap (Resolved in ADR-0061)

> [!NOTE]
> **Production Population Pipeline**: Populated via Increment 12 (ADR-0061).
> The vector embedding backfill (`reindexAll`) and live worker (`SearchIndexWorker`) populate `search_embeddings` in production environments when `SEMANTIC_SEARCH_ENABLED !== '0'`. See `docs/adr/0061-embedding-pipeline.md`.

## Consequences

- Clients can perform keyword, semantic, and hybrid RRF searches on `GET /v1/search?mode=...`.
- Response format (`{ total, results }`) is identical across all three search modes.
- OpenAPI 3.1 specification (`packages/api/openapi.json`) documents `mode` query parameter and updated 503 responses.
- `@chess-platform/search` stays dependency-free: the API supplies the embedder, and the package
  only defines the port plus the offline hashing implementation.
