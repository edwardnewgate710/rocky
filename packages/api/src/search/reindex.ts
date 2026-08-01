import type { SearchBackfillSource } from '@chess-platform/persistence';
import type { EmbeddingProvider, SearchRepository, SearchableDocument, SemanticSearchRepository } from '@chess-platform/search';
import { embedDocuments, gameToDocument, playerToDocument, tournamentToDocument } from '@chess-platform/search';

export interface ReindexResult {
  readonly games: number;
  readonly players: number;
  readonly tournaments: number;
}

export interface ReindexOptions {
  readonly source: SearchBackfillSource;
  readonly repository: SearchRepository;
  readonly batchSize?: number;
  readonly onProgress?: (type: 'games' | 'players' | 'tournaments', count: number) => void;
  /** Supplying both routes writes through the semantic repository instead of `repository`. */
  readonly semantic?: {
    readonly repository: SemanticSearchRepository;
    readonly embeddingProvider: EmbeddingProvider;
  };
}

/**
 * Page all games, players, and tournaments from a backfill source, project them to
 * SearchableDocument records, and upsert into the search repository in batches.
 * Pure logic, re-runnable and idempotent across runs.
 */
export async function reindexAll(options: ReindexOptions): Promise<ReindexResult> {
  const batchSize = options.batchSize ?? 500;
  let games = 0;
  let players = 0;
  let tournaments = 0;

  // SINGLE WRITE PATH DECISION:
  // When a semantic repository and embedding provider are supplied, they replace the keyword write path
  // because PgSemanticSearchRepository.indexAll upserts into search_documents AND search_embeddings
  // inside one transaction. Calling both would write search_documents twice per document for no benefit.
  const indexDocs = async (docs: readonly SearchableDocument[]): Promise<void> => {
    if (options.semantic) {
      const semanticDocs = await embedDocuments(options.semantic.embeddingProvider, docs);
      await options.semantic.repository.indexAll(semanticDocs);
    } else {
      await options.repository.indexAll(docs);
    }
  };

  // 1. Games
  let gameCursor: string | null = null;
  while (true) {
    const page = await options.source.listGames(gameCursor, batchSize);
    if (page.length === 0) break;

    const docs = page.map(gameToDocument);
    await indexDocs(docs);

    games += page.length;
    gameCursor = page[page.length - 1].id;
    options.onProgress?.('games', games);
  }

  // 2. Players
  let playerCursor: string | null = null;
  while (true) {
    const page = await options.source.listPlayers(playerCursor, batchSize);
    if (page.length === 0) break;

    const docs = page.map(playerToDocument);
    await indexDocs(docs);

    players += page.length;
    playerCursor = page[page.length - 1].id;
    options.onProgress?.('players', players);
  }

  // 3. Tournaments
  let tournamentCursor: string | null = null;
  while (true) {
    const page = await options.source.listTournaments(tournamentCursor, batchSize);
    if (page.length === 0) break;

    const docs = page.map(tournamentToDocument);
    await indexDocs(docs);

    tournaments += page.length;
    tournamentCursor = page[page.length - 1].id;
    options.onProgress?.('tournaments', tournaments);
  }

  return { games, players, tournaments };
}
