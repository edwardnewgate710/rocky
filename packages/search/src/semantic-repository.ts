import type { SearchOptions, SearchPage } from './pagination';
import { paginate } from './pagination';
import type { SearchQuery } from './query';
import type { Vector } from './vector';
import type { SemanticSearchableDocument, SemanticSearchOptions } from './semantic';
import { semanticSearch } from './semantic';
import type { HybridSearchOptions } from './hybrid';
import { hybridSearch } from './hybrid';

/**
 * Repository interface for semantic vector search and hybrid search.
 *
 * NOTE FOR IMPLEMENTORS:
 * Future pgvector adapters (Increment 10) will implement querySemantic using a cosine-distance
 * index (<=>). Because pgvector cosine distance is defined as (1 - cosine_similarity), pgvector
 * adapters must convert distance to similarity (1 - distance) so that higher scores consistently
 * represent higher similarity ("higher score = more similar") across all repository implementations.
 */
export interface SemanticSearchRepository {
  /** Insert or replace the document with this id (upsert by id). */
  index(document: SemanticSearchableDocument): Promise<void>;
  /** Upsert many documents. */
  indexAll(documents: readonly SemanticSearchableDocument[]): Promise<void>;
  /** Remove a document by id; returns true iff a document was present and removed. */
  remove(id: string): Promise<boolean>;
  /** Remove all documents. */
  clear(): Promise<void>;
  /** Number of documents currently indexed. */
  size(): Promise<number>;
  /** Nearest-neighbour search by vector. */
  querySemantic(
    queryVector: Vector,
    options?: SearchOptions & SemanticSearchOptions
  ): Promise<SearchPage>;
  /** Fused keyword + vector search. */
  queryHybrid(
    query: SearchQuery,
    queryVector: Vector,
    options?: SearchOptions & HybridSearchOptions
  ): Promise<SearchPage>;
}

export class InMemorySemanticSearchRepository implements SemanticSearchRepository {
  private readonly docs = new Map<string, SemanticSearchableDocument>();
  /** Dimension every embedding in this index must have; latched by the first document indexed. */
  private indexDimensions: number | undefined;

  async index(document: SemanticSearchableDocument): Promise<void> {
    this.assertIndexableDimensions(document);
    this.docs.set(document.id, document);
  }

  async indexAll(documents: readonly SemanticSearchableDocument[]): Promise<void> {
    for (const doc of documents) {
      this.assertIndexableDimensions(doc);
      this.docs.set(doc.id, doc);
    }
  }

  /**
   * Rejects a document whose embedding does not match the rest of the index. Queries compare the
   * query vector against EVERY stored embedding, and cosineSimilarity throws on a dimension
   * mismatch, so without this one bad write would make every later querySemantic/queryHybrid call
   * fail for the whole repository. Failing at the write localises the error to the caller that
   * caused it. Postgres adapters get this for free: pgvector fixes the dimension in the migration.
   */
  private assertIndexableDimensions(document: SemanticSearchableDocument): void {
    if (this.indexDimensions === undefined) {
      this.indexDimensions = document.embedding.length;
      return;
    }
    if (document.embedding.length !== this.indexDimensions) {
      throw new RangeError(
        `Embedding dimension mismatch for document "${document.id}": ` +
          `index holds ${this.indexDimensions}-dimensional vectors, got ${document.embedding.length}`
      );
    }
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.docs.delete(id);
    if (this.docs.size === 0) {
      // Emptying the index one document at a time has to leave it in the same state as clear().
      this.indexDimensions = undefined;
    }
    return removed;
  }

  /** Empties the index. The dimension is released too: an empty index has not committed to one. */
  async clear(): Promise<void> {
    this.docs.clear();
    this.indexDimensions = undefined;
  }

  async size(): Promise<number> {
    return this.docs.size;
  }

  async querySemantic(
    queryVector: Vector,
    options?: SearchOptions & SemanticSearchOptions
  ): Promise<SearchPage> {
    const allHits = semanticSearch(queryVector, Array.from(this.docs.values()), options);
    return paginate(allHits, options);
  }

  async queryHybrid(
    query: SearchQuery,
    queryVector: Vector,
    options?: SearchOptions & HybridSearchOptions
  ): Promise<SearchPage> {
    const allHits = hybridSearch(query, queryVector, Array.from(this.docs.values()), options);
    return paginate(allHits, options);
  }
}
