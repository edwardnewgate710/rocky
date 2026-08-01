/**
 * @packageDocumentation
 * Shared Postgres search query construction helpers (M11).
 * Used by both PgSearchRepository and PgSemanticSearchRepository to ensure
 * field canonicalization, tsquery parsing, and jsonb field filtering stay synchronized.
 */
import type { SearchFilter, SearchQuery, Vector } from '@chess-platform/search';

/**
 * Canonicalize field keys AND values to lowercase so metadata filters are
 * case-insensitive via jsonb containment (`fields @> '{...}'`), which the
 * `search_documents_fields_idx` GIN index can serve.
 */
export function canonicalizeFields(
  fields: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      out[key.toLowerCase()] = value.toLowerCase();
    }
  }
  return out;
}

/**
 * Formats a numeric Vector into pgvector's string literal representation: `[v0,v1,...]`.
 */
export function formatPgVector(v: Vector): string {
  return `[${v.join(',')}]`;
}

/**
 * Builds tsquery parts (`plainto_tsquery` for terms, `phraseto_tsquery` for phrases) combined with `&&`.
 */
export function buildTsqueryExpr(
  query: SearchQuery,
  p: (v: unknown) => string,
): { hasText: boolean; tsqueryExpr: string } {
  const tsqueryParts: string[] = [];
  if (query.terms.length > 0) {
    tsqueryParts.push(`plainto_tsquery('simple', ${p(query.terms.join(' '))})`);
  }
  for (const phrase of query.phrases) {
    tsqueryParts.push(`phraseto_tsquery('simple', ${p(phrase)})`);
  }
  const hasText = tsqueryParts.length > 0;
  const tsqueryExpr = tsqueryParts.join(' && ');
  return { hasText, tsqueryExpr };
}

/**
 * Builds jsonb containment filter clauses (`fields @> ...` or `NOT (fields @> ...)`).
 */
export function buildJsonbFilterClauses(
  filters: readonly SearchFilter[],
  p: (v: unknown) => string,
  tableAlias?: string,
): string[] {
  const clauses: string[] = [];
  const fieldCol = tableAlias ? `${tableAlias}.fields` : 'fields';
  for (const f of filters) {
    const contains = p(JSON.stringify({ [f.field.toLowerCase()]: f.value.toLowerCase() }));
    clauses.push(f.negated ? `NOT (${fieldCol} @> ${contains}::jsonb)` : `${fieldCol} @> ${contains}::jsonb`);
  }
  return clauses;
}
