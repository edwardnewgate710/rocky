import type { SearchBackfillSource } from '@chess-platform/persistence';
import type { SearchRepository } from '@chess-platform/search';
import { gameToDocument, playerToDocument, tournamentToDocument } from '@chess-platform/search';

export interface ReindexResult {
  readonly games: number;
  readonly players: number;
  readonly tournaments: number;
}

/**
 * Page all games, players, and tournaments from a backfill source, project them to
 * SearchableDocument records, and upsert into the search repository in batches.
 * Pure logic, re-runnable and idempotent across runs.
 */
export async function reindexAll(
  source: SearchBackfillSource,
  repo: SearchRepository,
  batchSize = 500,
  onProgress?: (type: 'games' | 'players' | 'tournaments', count: number) => void
): Promise<ReindexResult> {
  let games = 0;
  let players = 0;
  let tournaments = 0;

  // 1. Games
  let gameCursor: string | null = null;
  while (true) {
    const page = await source.listGames(gameCursor, batchSize);
    if (page.length === 0) break;

    const docs = page.map(gameToDocument);
    await repo.indexAll(docs);

    games += page.length;
    gameCursor = page[page.length - 1].id;
    onProgress?.('games', games);
  }

  // 2. Players
  let playerCursor: string | null = null;
  while (true) {
    const page = await source.listPlayers(playerCursor, batchSize);
    if (page.length === 0) break;

    const docs = page.map(playerToDocument);
    await repo.indexAll(docs);

    players += page.length;
    playerCursor = page[page.length - 1].id;
    onProgress?.('players', players);
  }

  // 3. Tournaments
  let tournamentCursor: string | null = null;
  while (true) {
    const page = await source.listTournaments(tournamentCursor, batchSize);
    if (page.length === 0) break;

    const docs = page.map(tournamentToDocument);
    await repo.indexAll(docs);

    tournaments += page.length;
    tournamentCursor = page[page.length - 1].id;
    onProgress?.('tournaments', tournaments);
  }

  return { games, players, tournaments };
}
