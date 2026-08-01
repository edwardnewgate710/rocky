/**
 * @packageDocumentation
 * Postgres pgvector implementation of SemanticSearchRepository (M11).
 * Durable vector and hybrid (RRF) search over a `search_embeddings` table joining
 * `search_documents`.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  SearchOptions,
  SearchPage,
  SearchQuery,
  SearchResult,
  Vector,
  SemanticSearchRepository,
  SemanticSearchableDocument,
  SemanticSearchOptions,
  HybridSearchOptions,
} from '@chess-platform/search';
import {
  canonicalizeFields,
  buildTsqueryExpr,
  buildJsonbFilterClauses,
  formatPgVector,
} from './search-helpers';

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
}

/** Mirrors semanticSearch's contract: a NaN threshold would silently match everything. */
function assertFiniteMinScore(minScore: number | undefined): void {
  if (minScore !== undefined && !Number.isFinite(minScore)) {
    throw new RangeError(`minScore must be a finite number, got ${minScore}`);
  }
}

const UPSERT_DOC_SQL =
  `INSERT INTO search_documents (id, text, fields)
   VALUES ($1, $2, $3::jsonb)
   ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, fields = EXCLUDED.fields`;

const UPSERT_EMBEDDING_SQL =
  `INSERT INTO search_embeddings (id, embedding)
   VALUES ($1, $2::vector)
   ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`;

export class PgSemanticSearchRepository implements SemanticSearchRepository {
  constructor(private readonly pool: Pool) {}

  async index(document: SemanticSearchableDocument): Promise<void> {
    await this.indexAll([document]);
  }

  async indexAll(documents: readonly SemanticSearchableDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const doc of documents) {
        await client.query(UPSERT_DOC_SQL, [
          doc.id,
          doc.text,
          JSON.stringify(canonicalizeFields(doc.fields)),
        ]);
        await client.query(UPSERT_EMBEDDING_SQL, [
          doc.id,
          formatPgVector(doc.embedding),
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Removes a document from the SEMANTIC index (`search_embeddings`) only.
   * The keyword document in `search_documents` survives.
   */
  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM search_embeddings WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Clears the SEMANTIC index (`search_embeddings`) only.
   * Keyword documents in `search_documents` survive.
   */
  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM search_embeddings');
  }

  async size(): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM search_embeddings',
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async querySemantic(
    queryVector: Vector,
    options?: SearchOptions & SemanticSearchOptions,
  ): Promise<SearchPage> {
    assertFiniteMinScore(options?.minScore);

    const params: unknown[] = [];
    const p = (v: unknown): string => { params.push(v); return `$${params.length}`; };

    // The query vector is bound LAZILY. The count query only mentions it when a minScore
    // distance predicate is present, and Postgres rejects a Bind that supplies more parameters
    // than the statement references ("bind message supplies N parameters, but prepared statement
    // requires M"). Pushing it eagerly therefore broke the most ordinary call of all —
    // querySemantic(vector) with no filters. Binding on first use keeps `params` aligned with
    // whichever statement is about to run, exactly as the pagination params below do.
    let queryVectorRef: string | undefined;
    const bindQueryVector = (): string => (queryVectorRef ??= p(formatPgVector(queryVector)));

    const clauses: string[] = [];
    if (options?.minScore !== undefined) {
      // Distance predicate in bare operator form for HNSW index usability:
      clauses.push(`e.embedding <=> ${bindQueryVector()}::vector <= ${p(1 - options.minScore)}`);
    }
    if (options?.filters && options.filters.length > 0) {
      clauses.push(...buildJsonbFilterClauses(options.filters, p, 'd'));
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM search_embeddings e
         JOIN search_documents d ON d.id = e.id
        ${whereSql}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    // Bound after the count query has run, so it lands at the right position for the page query.
    const qParam = bindQueryVector();

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;
    let pagination = `OFFSET ${p(offset)}`;
    if (limit !== undefined) {
      pagination = `LIMIT ${p(Math.max(0, limit))} ${pagination}`;
    }

    const pageRes = await this.pool.query<{ id: string; score: string | number }>(
      `SELECT d.id, 1 - (e.embedding <=> ${qParam}::vector) AS score
         FROM search_embeddings e
         JOIN search_documents d ON d.id = e.id
        ${whereSql}
        ORDER BY e.embedding <=> ${qParam}::vector ASC, d.id ASC
        ${pagination}`,
      params,
    );

    const results: SearchResult[] = pageRes.rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
    }));

    return { total, results };
  }

  async queryHybrid(
    query: SearchQuery,
    queryVector: Vector,
    options?: SearchOptions & HybridSearchOptions,
  ): Promise<SearchPage> {
    const keywordWeight = options?.keywordWeight ?? 0.5;
    if (
      typeof keywordWeight !== 'number' ||
      !Number.isFinite(keywordWeight) ||
      keywordWeight < 0 ||
      keywordWeight > 1
    ) {
      throw new RangeError(`keywordWeight must be a finite number in [0, 1], got ${keywordWeight}`);
    }

    const rrfK = options?.rrfK ?? 60;
    if (typeof rrfK !== 'number' || !Number.isFinite(rrfK) || rrfK <= 0) {
      throw new RangeError(`rrfK must be a positive finite number, got ${rrfK}`);
    }

    assertFiniteMinScore(options?.minScore);

    const params: unknown[] = [];
    const p = (v: unknown): string => { params.push(v); return `$${params.length}`; };

    const qParam = p(formatPgVector(queryVector));
    const kwWeightParam = p(keywordWeight);
    const rrfKParam = p(rrfK);

    // --- kw CTE clauses ---
    const { hasText, tsqueryExpr } = buildTsqueryExpr(query, p);
    const kwClauses: string[] = [];
    if (hasText) {
      kwClauses.push(`tsv @@ (${tsqueryExpr})`);
    }
    // Filters from both sources constrain BOTH branches — see hybridSearch. query.filters are hard
    // constraints, so a document violating them must not re-enter through the vector CTE.
    const allFilters = [
      ...query.filters,
      ...(options?.filters ?? []),
    ];
    if (allFilters.length > 0) {
      kwClauses.push(...buildJsonbFilterClauses(allFilters, p));
    }
    const kwWhere = kwClauses.length > 0 ? `WHERE ${kwClauses.join(' AND ')}` : '';
    const kwRankExpr = hasText ? `ts_rank(tsv, (${tsqueryExpr}))` : '0';

    // --- vec CTE clauses ---
    const vecClauses: string[] = [];
    if (options?.minScore !== undefined) {
      vecClauses.push(`e.embedding <=> ${qParam}::vector <= ${p(1 - options.minScore)}`);
    }
    if (allFilters.length > 0) {
      vecClauses.push(...buildJsonbFilterClauses(allFilters, p, 'd'));
    }
    const vecWhere = vecClauses.length > 0 ? `WHERE ${vecClauses.join(' AND ')}` : '';

    const fusedCteSql =
      `WITH kw AS (
         SELECT id, row_number() OVER (ORDER BY ${kwRankExpr} DESC, id ASC) AS rnk
           FROM search_documents
          ${kwWhere}
       ), vec AS (
         SELECT e.id, row_number() OVER (ORDER BY e.embedding <=> ${qParam}::vector ASC, e.id ASC) AS rnk
           FROM search_embeddings e
           JOIN search_documents d ON d.id = e.id
          ${vecWhere}
       ), fused AS (
         SELECT COALESCE(kw.id, vec.id) AS id,
                COALESCE(${kwWeightParam}::float8 / (${rrfKParam}::float8 + kw.rnk), 0::float8)
              + COALESCE((1.0 - ${kwWeightParam}::float8) / (${rrfKParam}::float8 + vec.rnk), 0::float8) AS score
           FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
       )`;

    const countRes = await this.pool.query<{ count: string }>(
      `${fusedCteSql} SELECT count(*)::text AS count FROM fused WHERE score > 0`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? '0');

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;
    let pagination = `OFFSET ${p(offset)}`;
    if (limit !== undefined) {
      pagination = `LIMIT ${p(Math.max(0, limit))} ${pagination}`;
    }

    const pageRes = await this.pool.query<{ id: string; score: string | number }>(
      `${fusedCteSql}
       SELECT id, score
         FROM fused
        WHERE score > 0
        ORDER BY score DESC, id ASC
        ${pagination}`,
      params,
    );

    const results: SearchResult[] = pageRes.rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
    }));

    return { total, results };
  }
}
