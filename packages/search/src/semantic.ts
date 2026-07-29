import type { SearchableDocument, SearchResult } from './search';
import type { SearchFilter } from './query';
import type { Vector } from './vector';
import { cosineSimilarity } from './vector';
import { matchesAllFilters } from './filters';

export interface SemanticSearchableDocument extends SearchableDocument {
  readonly embedding: Vector;
}

export interface SemanticSearchOptions {
  /** Drop hits whose similarity is strictly below this. Default: no threshold. */
  readonly minScore?: number;
  /** Filters that must be satisfied, same semantics as keyword search. */
  readonly filters?: readonly SearchFilter[];
}

/**
 * Pure in-memory vector matcher & ranker using cosine similarity.
 * Drops hits strictly below options.minScore if specified, and filters out documents
 * failing options.filters.
 * Returns results sorted by score DESC, tie-broken by id ASC.
 *
 * Throws RangeError if queryVector and document embedding dimensions mismatch, or if
 * options.minScore is present but not finite.
 */
export function semanticSearch(
  queryVector: Vector,
  documents: readonly SemanticSearchableDocument[],
  options?: SemanticSearchOptions
): SearchResult[] {
  const hits: SearchResult[] = [];
  const filters = options?.filters;
  const minScore = options?.minScore;

  // NaN would make `score < minScore` false for every document, silently returning the whole index
  // instead of applying the threshold the caller asked for — the same class of silent corruption
  // assertFinite exists to prevent, so it fails loudly here too.
  if (minScore !== undefined && !Number.isFinite(minScore)) {
    throw new RangeError(`minScore must be a finite number, got ${minScore}`);
  }

  for (const doc of documents) {
    if (filters && filters.length > 0) {
      if (!matchesAllFilters(filters, doc.fields)) {
        continue;
      }
    }

    const score = cosineSimilarity(queryVector, doc.embedding);

    if (minScore !== undefined && score < minScore) {
      continue;
    }

    hits.push({ id: doc.id, score });
  }

  return hits.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
