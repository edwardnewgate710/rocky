# ADR-0061 — Vector Embedding Backfill & Live Indexing Pipeline

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| **Status** | Accepted                                                           |
| **Date**   | 2026-08-01                                                         |
| **Scope**  | `@chess-platform/search`, `@chess-platform/api`, `services/gateway`, Helm |

---

## Context

Milestone 11 Increment 11 (ADR-0060) exposed `GET /v1/search?mode=semantic|hybrid` on the REST API contract. However, nothing populated the `search_embeddings` table in production. While keyword search possessed both a backfill script (`reindexAll`) and a live subscriber worker (`SearchIndexWorker`), the vector embedding column had neither, causing semantic search queries in production environments to return empty result pages (`{ total: 0, results: [] }`).

This increment closes that gap by introducing document embedding domain functions, refactoring `reindexAll` and `SearchIndexWorker` to support an optional semantic pipeline, and wiring environment flags and Helm templates.

## Decision

### 1. Pure Domain Document Embedding (`@chess-platform/search`)

Added `embedDocument` and `embedDocuments` to `@chess-platform/search` (`src/embed-document.ts`):

```ts
export async function embedDocument(
  provider: EmbeddingProvider,
  document: SearchableDocument
): Promise<SemanticSearchableDocument>;

export async function embedDocuments(
  provider: EmbeddingProvider,
  documents: readonly SearchableDocument[]
): Promise<SemanticSearchableDocument[]>;
```

- **Field Preservation**: `document.id`, `text`, and filter `fields` are preserved without mutation. Conditional spreading (`...(document.fields !== undefined ? { fields: document.fields } : {})`) is used to strictly comply with `exactOptionalPropertyTypes`.
- **Sequential Execution**: `embedDocuments` processes inputs sequentially.
  - **Rationale**: The only provider today (`HashingEmbeddingProvider`) is CPU-bound and synchronous underneath, so adding a concurrency option or parallel batching parameter would be speculative.

### 2. Single Write Path Architecture

When a `semantic` option bundle (`{ repository: SemanticSearchRepository, embeddingProvider: EmbeddingProvider }`) is provided to either `reindexAll` or `SearchIndexWorker`, writes route **exclusively** through the semantic repository (`options.semantic.repository`), replacing the keyword write path (`options.repository`).

- **Rationale**: `PgSemanticSearchRepository.index` and `indexAll` already upsert into **BOTH** `search_documents` AND `search_embeddings` inside a single database transaction (ADR-0059). Invoking both `repository.indexAll()` and `semantic.repository.indexAll()` would write to `search_documents` twice per document with zero benefit and unnecessary database load.

### 3. `reindexAll` Signature Refactoring

Refactored `reindexAll` in `packages/api/src/search/reindex.ts` from four positional arguments to a single `ReindexOptions` options object:

```ts
export interface ReindexOptions {
  readonly source: SearchBackfillSource;
  readonly repository: SearchRepository;
  readonly batchSize?: number; // default 500
  readonly onProgress?: (type: 'games' | 'players' | 'tournaments', count: number) => void;
  /** Supplying both routes writes through the semantic repository instead of `repository`. */
  readonly semantic?: {
    readonly repository: SemanticSearchRepository;
    readonly embeddingProvider: EmbeddingProvider;
  };
}
```

- **Rationale**: Prevents parameter proliferation beyond the 4-argument limit and cleanly accommodates optional semantic pipeline configuration.

### 4. Production & Live Worker Wiring

- **CLI Reindex Script (`packages/api/src/scripts/reindex-search.ts`)**: When `SEMANTIC_SEARCH_ENABLED !== '0'`, constructs `PgSemanticSearchRepository` and `HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS)` and passes them in `options.semantic`. Logs which indexing path (semantic vs. keyword-only) is active.
- **Gateway Live Worker (`services/gateway/src/serve.ts`)**: Evaluates `SEMANTIC_SEARCH_ENABLED !== '0'`. When true, configures `SearchIndexWorker` with `semantic` options to embed finished games in real-time. Documented in serve's `@packageDocumentation` env-var list.
- **Helm Search Indexer (`deploy/helm/gambit/templates/search-indexer.yaml`)**: Renders `SEMANTIC_SEARCH_ENABLED="0"` when `search.semanticEnabled` is `false`, ensuring indexer pods stop generating vector embeddings when semantic search is disabled. Snapshot tests (`scripts/helm-snapshot-test.sh`) extended with matching assertions.

### 5. `@chess-platform/api` tests now run with `--test-concurrency=1`

The new integration test exercises `reindexAll`, which by design pages **every** game, player and
tournament in the database. `packages/api/test/pg-security.integration.test.ts` deliberately creates
users concurrently (it tests a duplicate-handle race), so with `node --test` running files in
parallel the backfill can page a user row that another file is inserting or deleting at that moment.

`@chess-platform/persistence` took the same medicine in ADR-0059 for the same class of problem. The
whole api suite runs in roughly two seconds, so serialising it costs nothing measurable.

A consequence worth knowing: because the backfill indexes the entire database, the integration test
leaves `search_documents` rows for entities other tests created, and only removes its own four ids in
cleanup. Nothing asserts absolute row counts against that table, and a whole-database backfill is
precisely the behaviour under test, so this is accepted rather than worked around.

### 6. Operator Backfill Requirement

> [!IMPORTANT]
> **Manual Backfill Required**: Populating vector embeddings for pre-existing database records is an explicit, manual operator step (`npm run reindex-search -w @chess-platform/api`). Operators must execute this script once upon upgrading/enabling semantic search to ensure pre-existing games, players, and tournaments are populated in `search_embeddings`. Live games finished after deployment are indexed automatically by `SearchIndexWorker`.

## Consequences

- Semantic search (`GET /v1/search?mode=semantic|hybrid`) returns live and backfilled vector search results in production environments.
- Backward compatibility: when `semantic` option is omitted, `reindexAll` and `SearchIndexWorker` behave bit-for-bit identically to previous keyword search behavior.
- Clean separation of write paths avoids double-writing `search_documents`.
- ADR-0060's deferred gap notice updated to reference this implementation.
