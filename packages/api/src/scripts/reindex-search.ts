/**
 * @packageDocumentation
 * Reindex search documents in the database (`search_documents` table, and optionally
 * `search_embeddings` table when semantic search is enabled) by paging games, players,
 * and tournaments through {@link PgSearchBackfillSource}, mapping them to {@link SearchableDocument}
 * via entity projections, and upserting in batches.
 *
 * Idempotent and re-runnable (upserts by document id).
 * Run with: `npm run reindex-search -w @chess-platform/api`
 */

import {
  createPool,
  PgSearchRepository,
  PgSearchBackfillSource,
  PgSemanticSearchRepository,
} from '@chess-platform/persistence/pg';
import { HashingEmbeddingProvider, SEARCH_EMBEDDING_DIMENSIONS } from '@chess-platform/search';
import { reindexAll } from '../search/reindex';

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  // Built inside the try so a configuration failure (missing or malformed DATABASE_URL)
  // surfaces through the catch below as a clean message and exit code, rather than
  // escaping main() as an unhandled promise rejection.
  let pool: ReturnType<typeof createPool> | undefined;

  try {
    pool = createPool(
      process.env['DATABASE_URL'] ? { connectionString: process.env['DATABASE_URL'] } : {}
    );
    const searchRepo = new PgSearchRepository(pool);
    const backfillSource = new PgSearchBackfillSource(pool);

    const searchEnabled = process.env['SEARCH_ENABLED'] !== '0';
    const semanticSearchEnabled = searchEnabled && process.env['SEMANTIC_SEARCH_ENABLED'] !== '0';

    const semantic = semanticSearchEnabled
      ? {
          repository: new PgSemanticSearchRepository(pool),
          embeddingProvider: new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS),
        }
      : undefined;

    // eslint-disable-next-line no-console
    console.log('Starting search index reindex...');
    // eslint-disable-next-line no-console
    console.log(
      semantic
        ? 'Reindexing path: SEMANTIC (writing both search_documents and search_embeddings)'
        : 'Reindexing path: KEYWORD (writing search_documents only)'
    );

    const res = await reindexAll({
      source: backfillSource,
      repository: searchRepo,
      batchSize: BATCH_SIZE,
      onProgress: (type, count) => {
        // eslint-disable-next-line no-console
        console.log(`Indexed ${count} ${type}...`);
      },
      ...(semantic ? { semantic } : {}),
    });

    const totalCount = res.games + res.players + res.tournaments;
    // eslint-disable-next-line no-console
    console.log(
      `Reindex complete! Indexed ${totalCount} total documents (${res.games} games, ${res.players} players, ${res.tournaments} tournaments).`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Search reindex failed:', error);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

void main();
