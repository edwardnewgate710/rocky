/**
 * Vector Embedding Provider Port & Offline Hashing Adapter.
 *
 * WHY THIS EXISTS:
 * This package provides an offline, zero-dependency hashing vectorizer (the "hashing trick")
 * so the entire vector and hybrid search pipeline can be executed and tested deterministically in CI
 * without an external embedding model server or API key.
 *
 * HONEST LIMITATIONS:
 * The hashing trick captures lexical co-occurrence within a fixed bucket space via token hashing,
 * but it does NOT capture true semantic context or language-model embeddings (e.g. synonyms or embeddings).
 * In production environments, an external embedding model (OpenAI, Cohere, or local model server)
 * will serve as a drop-in replacement implementing the same async EmbeddingProvider interface.
 */

import type { Vector } from './vector';
import { normalize } from './vector';
import { tokenize } from './tokenize';

/**
 * Port interface for vector embedding generation.
 *
 * The provider interface is asynchronous to allow future I/O-backed adapters
 * (e.g. external REST or gRPC embedding services) to be implemented outside the domain package
 * without altering domain contracts.
 */
export interface EmbeddingProvider {
  /** Fixed dimensionality of every vector this provider returns. */
  readonly dimensions: number;
  /** Embed a single text string into a vector. */
  embed(text: string): Promise<Vector>;
  /** Embed multiple text strings into vectors, preserving input order. */
  embedAll(texts: readonly string[]): Promise<readonly Vector[]>;
}

/**
 * Deterministic 32-bit FNV-1a hash of a string.
 * Uses Math.imul and unsigned right shift (>>> 0) to ensure identical
 * hash values across platforms, JS engines, and Node versions.
 */
export function fnv1a32(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Default offline embedding provider implementing the feature hashing trick.
 * Tokenizes input text, hashes tokens into bucket indices [0, dimensions),
 * accumulates term frequencies, and L2-normalizes the resulting vector.
 */
/**
 * Upper bound on bucket count. Not an arbitrary limit: it is exactly pgvector's storage ceiling for
 * the `vector` type, so a vector this package accepts can always be persisted by the Increment 10
 * adapter. (pgvector additionally caps INDEXED vectors at 2000 dimensions; that is an adapter-level
 * concern — exact nearest-neighbour search still works above it — so it is enforced there, not
 * here.) No production embedding model emits more than a few thousand dimensions anyway.
 *
 * A cap also has to exist for the validation to mean anything: MAX_SAFE_INTEGER admits 2**32, which
 * constructs happily and then throws "Invalid array length" on the first embed() call, i.e. far
 * from the actual mistake.
 */
const MAX_DIMENSIONS = 16000;

/**
 * Default vector dimensionality for search embeddings (256).
 *
 * NOTE ON COUPLING:
 * This value is strictly coupled to the `vector(256)` column in
 * `packages/persistence/migrations/0014_search_embeddings.sql`.
 * Changing this constant REQUIRES a corresponding database migration to alter
 * the pgvector column width and rebuild the HNSW index.
 */
export const SEARCH_EMBEDDING_DIMENSIONS = 256;

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions = SEARCH_EMBEDDING_DIMENSIONS) {
    if (
      typeof dimensions !== 'number' ||
      !Number.isInteger(dimensions) ||
      dimensions <= 0 ||
      dimensions > MAX_DIMENSIONS
    ) {
      throw new RangeError(
        `dimensions must be an integer in [1, ${MAX_DIMENSIONS}], got ${dimensions}`
      );
    }
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Vector> {
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      return new Array(this.dimensions).fill(0);
    }
    const counts = new Array<number>(this.dimensions).fill(0);
    for (const token of tokens) {
      const bucket = fnv1a32(token) % this.dimensions;
      counts[bucket]++;
    }
    return normalize(counts);
  }

  async embedAll(texts: readonly string[]): Promise<readonly Vector[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
