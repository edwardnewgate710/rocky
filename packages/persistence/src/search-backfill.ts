import type {
  GameDocumentInput,
  PlayerDocumentInput,
  TournamentDocumentInput,
} from '@chess-platform/search';

/**
 * Keyset-paginated backfill source and single-entity fetcher for seeding the search index from durable persistence.
 * Page methods accept a cursor (`afterId`: null for the first page, or the last item's id)
 * and page limit. Results are ordered by primary key (`id` ASC).
 */
export interface SearchBackfillSource {
  findGame(id: string): Promise<GameDocumentInput | null>;
  listGames(afterId: string | null, limit: number): Promise<GameDocumentInput[]>;
  listPlayers(afterId: string | null, limit: number): Promise<PlayerDocumentInput[]>;
  listTournaments(afterId: string | null, limit: number): Promise<TournamentDocumentInput[]>;
}
