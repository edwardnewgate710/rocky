import type { SearchableDocument } from './search';
import type { SearchQuery } from './query';
import { search } from './search';
import type { SearchOptions, SearchPage } from './pagination';
import { paginate } from './pagination';

export type { SearchOptions, SearchPage };

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
    return paginate(search(query, Array.from(this.docs.values())), options);
  }
}

