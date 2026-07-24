import type { SearchableDocument, SearchResult } from './search';
import type { SearchQuery } from './query';
import { search } from './search';

/** Pagination/query options for a repository query. */
export interface SearchOptions {
  /** Max results to return (the page size). Omitted/undefined => all hits. Values < 0 clamp to 0. */
  readonly limit?: number;
  /** Number of leading hits to skip. Omitted/undefined => 0. Values < 0 clamp to 0. */
  readonly offset?: number;
}

/** A page of ranked results plus the total number of hits (before pagination). */
export interface SearchPage {
  /** Total hits matching the query across the whole index (independent of limit/offset). */
  readonly total: number;
  /** The requested page of ranked results (already sorted by the underlying matcher). */
  readonly results: readonly SearchResult[];
}

/**
 * A stateful, queryable index of SearchableDocuments. Adapters (in-memory here; Postgres full-text and
 * pgvector semantic in later M11 increments) implement this port.
 */
export interface SearchRepository {
  /** Insert or replace the document with this id (upsert by id). */
  index(document: SearchableDocument): void;
  /** Upsert many documents. */
  indexAll(documents: readonly SearchableDocument[]): void;
  /** Remove a document by id; returns true iff a document was present and removed. */
  remove(id: string): boolean;
  /** Remove all documents. */
  clear(): void;
  /** Number of documents currently indexed. */
  size(): number;
  /** Run a query over the whole index and return the requested page (with the total hit count). */
  query(query: SearchQuery, options?: SearchOptions): SearchPage;
}

export class InMemorySearchRepository implements SearchRepository {
  private readonly docs = new Map<string, SearchableDocument>();

  index(document: SearchableDocument): void {
    this.docs.set(document.id, document);
  }

  indexAll(documents: readonly SearchableDocument[]): void {
    for (const doc of documents) {
      this.docs.set(doc.id, doc);
    }
  }

  remove(id: string): boolean {
    return this.docs.delete(id);
  }

  clear(): void {
    this.docs.clear();
  }

  size(): number {
    return this.docs.size;
  }

  query(query: SearchQuery, options?: SearchOptions): SearchPage {
    const allHits = search(query, Array.from(this.docs.values()));
    const total = allHits.length;

    const offset = options?.offset;
    const limit = options?.limit;

    const start = Math.max(0, offset ?? 0);
    const end = limit === undefined ? allHits.length : start + Math.max(0, limit);

    const results = allHits.slice(start, end);

    return { total, results };
  }
}
