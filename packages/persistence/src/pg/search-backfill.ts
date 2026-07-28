import type { Pool } from 'pg';
import type {
  GameDocumentInput,
  PlayerDocumentInput,
  TournamentDocumentInput,
} from '@chess-platform/search';
import type { SearchBackfillSource } from '../search-backfill';

function sanitizeLimit(limit: number, maxLimit = 1000): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(maxLimit, Math.max(1, Math.floor(limit)));
}

/**
 * Postgres implementation of SearchBackfillSource.
 * Performs keyset (cursor) pagination using bound parameters ($1, $2, ...)
 * over primary key `id ASC`.
 */
export class PgSearchBackfillSource implements SearchBackfillSource {
  constructor(private readonly pool: Pool) {}

  async listGames(afterId: string | null, limit: number): Promise<GameDocumentInput[]> {
    const safeLimit = sanitizeLimit(limit);
    const params: unknown[] = [];
    let whereClause = '';

    if (afterId !== null && afterId !== undefined) {
      params.push(afterId);
      whereClause = 'WHERE g.id > $1::uuid';
    }

    params.push(safeLimit);
    const limitParam = `$${params.length}`;

    const query = `
      SELECT
        g.id::text AS id,
        g.variant,
        g.speed,
        COALESCE(g.result, '*') AS result,
        g.rated,
        g.opening_eco AS eco,
        COALESCE(wu.handle, '') AS white_handle,
        COALESCE(bu.handle, '') AS black_handle
      FROM games g
      LEFT JOIN users wu ON g.white_id = wu.id
      LEFT JOIN users bu ON g.black_id = bu.id
      ${whereClause}
      ORDER BY g.id ASC
      LIMIT ${limitParam}
    `;

    const res = await this.pool.query<{
      id: string;
      variant: string;
      speed: string;
      result: string;
      rated: boolean;
      eco: string | null;
      white_handle: string;
      black_handle: string;
    }>(query, params);

    return res.rows.map((r) => ({
      id: r.id,
      whiteHandle: r.white_handle,
      blackHandle: r.black_handle,
      variant: r.variant,
      speed: r.speed,
      result: r.result,
      rated: r.rated,
      ...(r.eco ? { eco: r.eco } : {}),
    }));
  }

  async listPlayers(afterId: string | null, limit: number): Promise<PlayerDocumentInput[]> {
    const safeLimit = sanitizeLimit(limit);
    const params: unknown[] = [];
    let whereClause = '';

    if (afterId !== null && afterId !== undefined) {
      params.push(afterId);
      whereClause = 'WHERE id > $1::uuid';
    }

    params.push(safeLimit);
    const limitParam = `$${params.length}`;

    const query = `
      SELECT
        id::text AS id,
        handle,
        country
      FROM users
      ${whereClause}
      ORDER BY id ASC
      LIMIT ${limitParam}
    `;

    const res = await this.pool.query<{
      id: string;
      handle: string;
      country: string | null;
    }>(query, params);

    return res.rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      ...(r.country ? { country: r.country } : {}),
    }));
  }

  async listTournaments(afterId: string | null, limit: number): Promise<TournamentDocumentInput[]> {
    const safeLimit = sanitizeLimit(limit);
    const params: unknown[] = [];
    let whereClause = '';

    if (afterId !== null && afterId !== undefined) {
      params.push(afterId);
      whereClause = 'WHERE id > $1';
    }

    params.push(safeLimit);
    const limitParam = `$${params.length}`;

    const query = `
      SELECT
        id,
        name,
        format,
        state
      FROM tournaments
      ${whereClause}
      ORDER BY id ASC
      LIMIT ${limitParam}
    `;

    const res = await this.pool.query<{
      id: string;
      name: string;
      format: string;
      state: string;
    }>(query, params);

    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      format: r.format,
      state: r.state,
    }));
  }
}
