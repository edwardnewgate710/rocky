import type { EmbeddingProvider } from './embedding';
import type { SearchableDocument } from './search';
import type { SemanticSearchableDocument } from './semantic';

/**
 * Embed a single SearchableDocument into a SemanticSearchableDocument using the supplied provider.
 * Preserves id and fields (via conditional spread to strictly satisfy exactOptionalPropertyTypes).
 * Does not mutate the input document.
 */
export async function embedDocument(
  provider: EmbeddingProvider,
  document: SearchableDocument
): Promise<SemanticSearchableDocument> {
  const embedding = await provider.embed(document.text);
  return {
    id: document.id,
    text: document.text,
    ...(document.fields !== undefined ? { fields: document.fields } : {}),
    embedding,
  };
}

/**
 * Embed multiple SearchableDocuments into SemanticSearchableDocuments sequentially.
 *
 * NOTE ON CONCURRENCY:
 * Documents are embedded sequentially because the primary offline/CI provider (HashingEmbeddingProvider)
 * is CPU-bound and synchronous underneath, so adding a concurrency option or parallel batching knob
 * would be speculative.
 */
export async function embedDocuments(
  provider: EmbeddingProvider,
  documents: readonly SearchableDocument[]
): Promise<SemanticSearchableDocument[]> {
  const results: SemanticSearchableDocument[] = [];
  for (const doc of documents) {
    results.push(await embedDocument(provider, doc));
  }
  return results;
}
