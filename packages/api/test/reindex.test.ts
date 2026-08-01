import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySearchRepository,
  InMemorySemanticSearchRepository,
  HashingEmbeddingProvider,
  type GameDocumentInput,
  type PlayerDocumentInput,
  type TournamentDocumentInput,
} from '@chess-platform/search';
import type { SearchBackfillSource } from '@chess-platform/persistence';
import { reindexAll } from '../src/search/reindex';

class FakeSearchBackfillSource implements SearchBackfillSource {
  private readonly games: GameDocumentInput[] = [
    {
      id: 'g-1',
      whiteHandle: 'alice',
      blackHandle: 'bob',
      variant: 'standard',
      speed: 'blitz',
      result: '1-0',
      rated: true,
    },
    {
      id: 'g-2',
      whiteHandle: 'carol',
      blackHandle: 'dave',
      variant: 'standard',
      speed: 'rapid',
      result: '1/2-1/2',
      rated: false,
    },
  ];

  private readonly players: PlayerDocumentInput[] = [
    { id: 'p-1', handle: 'alice', country: 'US' },
    { id: 'p-2', handle: 'bob', country: 'NO' },
  ];

  private readonly tournaments: TournamentDocumentInput[] = [
    { id: 't-1', name: 'Spring Arena', format: 'arena', state: 'running' },
  ];

  async findGame(id: string): Promise<GameDocumentInput | null> {
    return this.games.find((g) => g.id === id) ?? null;
  }

  async listGames(afterId: string | null, limit: number): Promise<GameDocumentInput[]> {
    const start = afterId === null ? 0 : this.games.findIndex((g) => g.id === afterId) + 1;
    return this.games.slice(start, start + limit);
  }

  async listPlayers(afterId: string | null, limit: number): Promise<PlayerDocumentInput[]> {
    const start = afterId === null ? 0 : this.players.findIndex((p) => p.id === afterId) + 1;
    return this.players.slice(start, start + limit);
  }

  async listTournaments(afterId: string | null, limit: number): Promise<TournamentDocumentInput[]> {
    const start = afterId === null ? 0 : this.tournaments.findIndex((t) => t.id === afterId) + 1;
    return this.tournaments.slice(start, start + limit);
  }
}

test('reindexAll: pages entities into SearchRepository without semantic option and is idempotent across multiple runs', async () => {
  const source = new FakeSearchBackfillSource();
  const repo = new InMemorySearchRepository();

  // First run
  const res1 = await reindexAll({ source, repository: repo, batchSize: 1 });
  assert.deepEqual(res1, { games: 2, players: 2, tournaments: 1 });
  const sizeAfterRun1 = await repo.size();
  assert.strictEqual(sizeAfterRun1, 5); // 2 games + 2 players + 1 tournament

  // Second run (idempotency check)
  const res2 = await reindexAll({ source, repository: repo, batchSize: 1 });
  assert.deepEqual(res2, { games: 2, players: 2, tournaments: 1 });
  const sizeAfterRun2 = await repo.size();
  assert.strictEqual(sizeAfterRun2, 5, 'Search index size must remain identical after second run');
});

test('reindexAll: with semantic option, documents land in semantic repository and NOT in keyword repository', async () => {
  const source = new FakeSearchBackfillSource();
  const keywordRepo = new InMemorySearchRepository();
  const semanticRepo = new InMemorySemanticSearchRepository();
  const embeddingProvider = new HashingEmbeddingProvider(256);

  const res = await reindexAll({
    source,
    repository: keywordRepo,
    batchSize: 1,
    semantic: {
      repository: semanticRepo,
      embeddingProvider,
    },
  });

  assert.deepEqual(res, { games: 2, players: 2, tournaments: 1 });

  // Double-write guard assertion: keyword repository size MUST be 0 when semantic path is used
  assert.strictEqual(
    await keywordRepo.size(),
    0,
    'Keyword repository must not receive writes when semantic option is supplied (single write path rule)'
  );

  // Semantic repository received all documents with 256-dim embeddings
  assert.strictEqual(await semanticRepo.size(), 5);
});
