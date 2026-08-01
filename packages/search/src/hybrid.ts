import type { SearchQuery } from './query';
import type { SearchResult } from './search';
import { search } from './search';
import type { Vector } from './vector';
import type { SemanticSearchableDocument, SemanticSearchOptions } from './semantic';
import { semanticSearch } from './semantic';
import { matchesAllFilters } from './filters';

export interface HybridSearchOptions extends SemanticSearchOptions {
  /**
   * Weight of the keyword ranking in [0, 1]; the semantic ranking gets (1 - keywordWeight).
   * Default 0.5 (equal contribution).
   */
  readonly keywordWeight?: number;
  /** RRF damping constant; larger flattens the contribution of top ranks. Default 60. */
  readonly rrfK?: number;
}

/**
 * Fuses keyword search and semantic vector search using Reciprocal Rank Fusion (RRF).
 *
 * WHY RRF INSTEAD OF WEIGHTED SCORE ADDITION:
 * Keyword search scores are unbounded term frequency counts (e.g. 0, 1, 3, 5+), whereas
 * semantic search scores are cosine similarities bounded in [-1, 1]. Adding these raw scores
 * directly with static weights is scale-broken because term counts scale arbitrarily with document
 * text length and query complexity, overpowering cosine similarity.
 * Reciprocal Rank Fusion (RRF) combines results by 1-based rank position rather than raw score magnitude,
 * ensuring scale-invariant fusion across different search modalities.
 */
export function hybridSearch(
  query: SearchQuery,
  queryVector: Vector,
  documents: readonly SemanticSearchableDocument[],
  options?: HybridSearchOptions
): SearchResult[] {
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

  // Filters from BOTH sources constrain BOTH signals. query.filters (e.g. a `variant:blitz` parsed
  // out of the query text) are hard constraints, not relevance hints: applying them only to the
  // keyword branch let a document that violates them re-enter through the semantic branch and
  // surface in the fused result. Terms and phrases are the relevance signal the vector branch is
  // meant to bypass; filters are not.
  const allFilters = [...(options?.filters ?? []), ...query.filters];
  const filteredDocs =
    allFilters.length > 0
      ? documents.filter((doc) => matchesAllFilters(allFilters, doc.fields))
      : documents;

  const keywordHits = search(query, filteredDocs);
  // filteredDocs already satisfies every filter, so only the threshold is still relevant.
  const semanticHits = semanticSearch(queryVector, filteredDocs, { minScore: options?.minScore });

  const fusedScores = new Map<string, number>();
  const semanticWeight = 1 - keywordWeight;

  if (keywordWeight > 0) {
    for (let i = 0; i < keywordHits.length; i++) {
      const hit = keywordHits[i];
      const rank = i + 1;
      const contribution = keywordWeight / (rrfK + rank);
      fusedScores.set(hit.id, (fusedScores.get(hit.id) ?? 0) + contribution);
    }
  }

  if (semanticWeight > 0) {
    for (let i = 0; i < semanticHits.length; i++) {
      const hit = semanticHits[i];
      const rank = i + 1;
      const contribution = semanticWeight / (rrfK + rank);
      fusedScores.set(hit.id, (fusedScores.get(hit.id) ?? 0) + contribution);
    }
  }

  const results: SearchResult[] = [];
  for (const [id, score] of fusedScores.entries()) {
    results.push({ id, score });
  }

  return results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
