/**
 * @packageDocumentation
 * Postgres full-text implementation of SearchRepository (M11). Keyword search over a
 * search_documents table using a 'simple'-config tsvector + GIN index; case-insensitive
 * jsonb-containment field filters over lowercased-canonicalized fields (GIN-served).
 * Full-text ('simple') semantics differ from the pure in-memory matcher.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  SearchRepository,
  SearchableDocument,
  SearchQuery,
  SearchOptions,
  SearchPage,
  SearchResult,
} from '@chess-platform/search';
import {
  canonicalizeFields,
  buildTsqueryExpr,
  buildJsonbFilterClauses,
} from './search-helpers';

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
}

const UPSERT_SQL =
  `INSERT INTO search_documents (id, text, fields)
   VALUES ($1, $2, $3::jsonb)
   ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, fields = EXCLUDED.fields`;

export class PgSearchRepository implements SearchRepository {
  constructor(private readonly pool: Pool) {}

  async index(document: SearchableDocument): Promise<void> {
    await this.pool.query(UPSERT_SQL, [
      document.id, document.text, JSON.stringify(canonicalizeFields(document.fields)),
    ]);
  }

  async indexAll(documents: readonly SearchableDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const doc of documents) {
        await client.query(UPSERT_SQL, [doc.id, doc.text, JSON.stringify(canonicalizeFields(doc.fields))]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM search_documents WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM search_documents');
  }

  async size(): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM search_documents',
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async query(query: SearchQuery, options?: SearchOptions): Promise<SearchPage> {
    // Parameter accumulator: p(v) pushes a value and returns its $N placeholder.
    const params: unknown[] = [];
    const p = (v: unknown): string => { params.push(v); return `$${params.length}`; };

    // --- text query: terms + phrases ---
    const { hasText, tsqueryExpr } = buildTsqueryExpr(query, p);

    // --- WHERE: text match + jsonb field filters ---
    const clauses: string[] = [];
    if (hasText) clauses.push(`tsv @@ (${tsqueryExpr})`);
    if (query.filters.length > 0) {
      clauses.push(...buildJsonbFilterClauses(query.filters, p));
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    // --- total (before pagination), using only the params built so far ---
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM search_documents ${whereSql}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    // --- page: score by ts_rank when there is a text query, else 0 ---
    const scoreExpr = hasText ? `ts_rank(tsv, (${tsqueryExpr}))` : '0';
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;
    // pagination params appended AFTER the count query has run
    let pagination = `OFFSET ${p(offset)}`;
    if (limit !== undefined) {
      pagination = `LIMIT ${p(Math.max(0, limit))} ${pagination}`;
    }

    const pageRes = await this.pool.query<{ id: string; score: string | number }>(
      `SELECT id, ${scoreExpr} AS score
         FROM search_documents ${whereSql}
        ORDER BY score DESC, id ASC
        ${pagination}`,
      params,
    );
    const results: SearchResult[] = pageRes.rows.map((r) => ({ id: r.id, score: Number(r.score) }));
    return { total, results };
  }
}
