import { tokenize } from './tokenize';
import { type SearchQuery } from './query';
import { matchesAllFilters } from './filters';

export interface SearchableDocument {
  readonly id: string;
  /** Free text to match terms/phrases against. */
  readonly text: string;
  /** Exact-match filterable fields (e.g. { variant: 'blitz', result: '1-0' }). */
  readonly fields?: Readonly<Record<string, string>>;
}

export interface SearchResult {
  readonly id: string;
  readonly score: number;
}

function countPhraseOccurrences(docTokens: readonly string[], phraseTokens: readonly string[]): number {
  if (phraseTokens.length === 0 || docTokens.length < phraseTokens.length) {
    return 0;
  }
  let occurrences = 0;
  const maxStart = docTokens.length - phraseTokens.length;
  for (let i = 0; i <= maxStart; i++) {
    let match = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (docTokens[i + j] !== phraseTokens[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      occurrences++;
    }
  }
  return occurrences;
}

/**
 * Pure in-memory keyword search matcher & ranker using AND semantics.
 * Filters must be satisfied; terms & contiguous phrases must all match.
 * Scores by term token frequency + 2 * phrase matches.
 * Returns results sorted by score DESC, tie-broken by id ASC.
 */
export function search(
  query: SearchQuery,
  documents: readonly SearchableDocument[]
): SearchResult[] {
  const hits: SearchResult[] = [];

  // Extract required query term-tokens
  const queryTermTokens: string[] = [];
  for (const term of query.terms) {
    const tokens = tokenize(term);
    queryTermTokens.push(...tokens);
  }

  // Tokenize phrases into token sublists
  const phraseTokenLists: string[][] = [];
  for (const phrase of query.phrases) {
    const tokens = tokenize(phrase);
    if (tokens.length > 0) {
      phraseTokenLists.push(tokens);
    }
  }

  for (const doc of documents) {
    // 1. Filter matching
    if (!matchesAllFilters(query.filters, doc.fields)) {
      continue;
    }

    // 2. Tokenize document text
    const docTokens = tokenize(doc.text);

    // 3. Term matching & occurrence count
    let termScore = 0;
    let termsPass = true;
    for (const termToken of queryTermTokens) {
      let occurrences = 0;
      for (const docToken of docTokens) {
        if (docToken === termToken) {
          occurrences++;
        }
      }
      if (occurrences === 0) {
        termsPass = false;
        break;
      }
      termScore += occurrences;
    }
    if (!termsPass) {
      continue;
    }

    // 4. Phrase contiguity matching & occurrence count
    let phraseMatches = 0;
    let phrasesPass = true;
    for (const phraseTokens of phraseTokenLists) {
      const occurrences = countPhraseOccurrences(docTokens, phraseTokens);
      if (occurrences === 0) {
        phrasesPass = false;
        break;
      }
      phraseMatches += occurrences;
    }
    if (!phrasesPass) {
      continue;
    }

    // 5. Score calculation
    const score = termScore + 2 * phraseMatches;
    hits.push({ id: doc.id, score });
  }

  // Sort hits by score DESC, tie-broken by id ASC
  return hits.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
