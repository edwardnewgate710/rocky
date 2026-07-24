import { tokenize } from './tokenize';
import { type SearchFilter, type SearchQuery } from './query';

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

function getFieldValue(
  fields: Readonly<Record<string, string>> | undefined,
  field: string
): string | undefined {
  if (!fields) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(fields, field)) {
    return fields[field];
  }
  const target = field.toLowerCase();
  for (const key of Object.keys(fields)) {
    if (key.toLowerCase() === target) {
      return fields[key];
    }
  }
  return undefined;
}

function matchesFilter(
  filter: SearchFilter,
  fields?: Readonly<Record<string, string>>
): boolean {
  const docVal = getFieldValue(fields, filter.field);
  const isMatch = docVal !== undefined && docVal.toLowerCase() === filter.value.toLowerCase();
  return filter.negated ? !isMatch : isMatch;
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
    let filtersPass = true;
    for (const filter of query.filters) {
      if (!matchesFilter(filter, doc.fields)) {
        filtersPass = false;
        break;
      }
    }
    if (!filtersPass) {
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
