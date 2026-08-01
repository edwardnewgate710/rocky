import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  createPool,
  migrate,
  PgSearchBackfillSource,
  PgSearchRepository,
  PgSemanticSearchRepository,
} from '@chess-platform/persistence/pg';
import { uuidv7 } from '@chess-platform/persistence';
import { HashingEmbeddingProvider, SEARCH_EMBEDDING_DIMENSIONS } from '@chess-platform/search';
import { reindexAll } from '../src/search/reindex';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('reindexAll semantic pipeline integration: populates search_embeddings and exposes results through querySemantic', { skip }, async () => {
  const pool = createPool();
  const ns = uuidv7();

  const userId1 = uuidv7();
  const userId2 = uuidv7();
  const gameId1 = uuidv7();
  const tournamentId1 = `t-pipe-${uuidv7()}`;

  const migrationsDir = existsSync(join(process.cwd(), 'migrations'))
    ? join(process.cwd(), 'migrations')
    : join(process.cwd(), '../persistence/migrations');

  try {
    await migrate(pool, migrationsDir);

    const backfillSource = new PgSearchBackfillSource(pool);
    const searchRepo = new PgSearchRepository(pool);
    const semanticRepo = new PgSemanticSearchRepository(pool);
    const provider = new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS);

    // 1. Seed database entities
    await pool.query(
      `INSERT INTO users (id, handle, country) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [userId1, `pipe_white_${ns.slice(0, 8)}`, 'US', userId2, `pipe_black_${ns.slice(0, 8)}`, 'NO']
    );

    await pool.query(
      `INSERT INTO games (id, variant, rated, speed, white_id, black_id, opening_eco, result, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [gameId1, 'standard', true, 'blitz', userId1, userId2, 'B90', '1-0']
    );

    await pool.query(
      `INSERT INTO tournaments (id, name, format, state, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [tournamentId1, `Pipeline Cup ${ns.slice(0, 8)}`, 'arena', 'running']
    );

    // 2. Execute reindexAll with semantic pipeline
    const res = await reindexAll({
      source: backfillSource,
      repository: searchRepo,
      batchSize: 50,
      semantic: {
        repository: semanticRepo,
        embeddingProvider: provider,
      },
    });

    assert.ok(res.games >= 1);
    assert.ok(res.players >= 2);
    assert.ok(res.tournaments >= 1);

    // 3. Verify search_embeddings table has rows for the seeded documents
    const docIds = [`game:${gameId1}`, `player:${userId1}`, `player:${userId2}`, `tournament:${tournamentId1}`];
    const embCountRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM search_embeddings WHERE id = ANY($1::text[])`,
      [docIds]
    );
    assert.strictEqual(
      Number(embCountRes.rows[0]?.count),
      4,
      'search_embeddings table must contain 4 rows for seeded game, players, and tournament'
    );

    // 4. Perform vector search (querySemantic) and verify seeded game document returns
    const gameQueryVector = await provider.embed(`game standard blitz pipe_white_${ns.slice(0, 8)}`);
    const semRes = await semanticRepo.querySemantic(gameQueryVector, {
      filters: [{ field: 'type', value: 'game', negated: false }],
    });

    assert.ok(semRes.total >= 1);
    const foundGame = semRes.results.find((r) => r.id === `game:${gameId1}`);
    assert.ok(foundGame, `Seeded game game:${gameId1} must be returned by querySemantic`);
    assert.ok(Number.isFinite(foundGame.score));
  } finally {
    // Scoped cleanup
    const docIds = [`game:${gameId1}`, `player:${userId1}`, `player:${userId2}`, `tournament:${tournamentId1}`];
    try {
      await pool.query('DELETE FROM search_documents WHERE id = ANY($1::text[])', [docIds]);
      await pool.query('DELETE FROM games WHERE id = $1', [gameId1]);
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userId1, userId2]);
      await pool.query('DELETE FROM tournaments WHERE id = $1', [tournamentId1]);
    } finally {
      await pool.end();
    }
  }
});
