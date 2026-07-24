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
 * A stateful, queryable index of SearchableDocuments. The port is async so I/O-backed adapters
 * (Postgres full-text and pgvector semantic in later M11 increments) can perform I/O operations;
 * the in-memory adapter satisfies it trivially.
 */
export interface SearchRepository {
  /** Insert or replace the document with this id (upsert by id). */
  index(document: SearchableDocument): Promise<void>;
  /** Upsert many documents. */
  indexAll(documents: readonly SearchableDocument[]): Promise<void>;
  /** Remove a document by id; returns true iff a document was present and removed. */
  remove(id: string): Promise<boolean>;
  /** Remove all documents. */
  clear(): Promise<void>;
  /** Number of documents currently indexed. */
  size(): Promise<number>;
  /** Run a query over the whole index and return the requested page (with the total hit count). */
  query(query: SearchQuery, options?: SearchOptions): Promise<SearchPage>;
}

export class InMemorySearchRepository implements SearchRepository {
  private readonly docs = new Map<string, SearchableDocument>();

  async index(document: SearchableDocument): Promise<void> {
    this.docs.set(document.id, document);
  }

  async indexAll(documents: readonly SearchableDocument[]): Promise<void> {
    for (const doc of documents) {
      this.docs.set(doc.id, doc);
    }
  }

  async remove(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async clear(): Promise<void> {
    this.docs.clear();
  }

  async size(): Promise<number> {
    return this.docs.size;
  }

  async query(query: SearchQuery, options?: SearchOptions): Promise<SearchPage> {
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

