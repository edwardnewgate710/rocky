import type { SearchFilter, SearchQuery } from './query';
import { parseSearchQuery } from './query';

/** Bare words dropped from a natural query (they carry no search signal). */
export const NATURAL_STOP_WORDS: ReadonlySet<string> = new Set<string>([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'by',
  'with',
  'and',
  'or',
  'for',
  'to',
  'from',
  'me',
  'all',
  'show',
  'find',
  'list',
  'game',
  'games',
  'match',
  'matches',
  'played',
  'between',
  'was',
  'were',
  'that',
]);

/**
 * Maps a recognized lowercase natural word to the structured filter it implies.
 * Bounded, deterministic chess-search vocabulary (documented in ADR-0051).
 */
export const NATURAL_VOCABULARY: ReadonlyMap<
  string,
  { readonly field: string; readonly value: string }
> = new Map<string, { readonly field: string; readonly value: string }>([
  // Variants
  ['blitz', { field: 'variant', value: 'blitz' }],
  ['bullet', { field: 'variant', value: 'bullet' }],
  ['rapid', { field: 'variant', value: 'rapid' }],
  ['classical', { field: 'variant', value: 'classical' }],
  ['chess960', { field: 'variant', value: 'chess960' }],
  ['960', { field: 'variant', value: 'chess960' }],
  ['atomic', { field: 'variant', value: 'atomic' }],
  ['crazyhouse', { field: 'variant', value: 'crazyhouse' }],
  ['horde', { field: 'variant', value: 'horde' }],
  ['antichess', { field: 'variant', value: 'antichess' }],

  // Colors
  ['white', { field: 'color', value: 'white' }],
  ['black', { field: 'color', value: 'black' }],

  // Results
  ['won', { field: 'result', value: 'win' }],
  ['win', { field: 'result', value: 'win' }],
  ['wins', { field: 'result', value: 'win' }],
  ['winning', { field: 'result', value: 'win' }],
  ['lost', { field: 'result', value: 'loss' }],
  ['loss', { field: 'result', value: 'loss' }],
  ['losses', { field: 'result', value: 'loss' }],
  ['lose', { field: 'result', value: 'loss' }],
  ['draw', { field: 'result', value: 'draw' }],
  ['draws', { field: 'result', value: 'draw' }],
  ['drew', { field: 'result', value: 'draw' }],
  ['drawn', { field: 'result', value: 'draw' }],
  ['tie', { field: 'result', value: 'draw' }],
  ['tied', { field: 'result', value: 'draw' }],
]);

/**
 * Deduplicate filters by the tuple (field, value, negated), preserving first-occurrence order.
 */
function deduplicateFilters(filters: readonly SearchFilter[]): SearchFilter[] {
  const seen = new Set<string>();
  const result: SearchFilter[] = [];
  for (const filter of filters) {
    const key = `${filter.field}:${filter.value}:${filter.negated}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(filter);
    }
  }
  return result;
}

/**
 * Normalize a natural-language search string into a structured SearchQuery.
 * Runs parseSearchQuery first (explicit filters/phrases/terms preserved), then promotes recognized
 * vocabulary words among the bare TERMS into non-negated filters and drops stop words. Pure & total.
 */
export function parseNaturalQuery(input: string): SearchQuery {
  const base = parseSearchQuery(input);
  const keptTerms: string[] = [];
  const promotedFilters: SearchFilter[] = [];

  for (const term of base.terms) {
    const key = term.toLowerCase();
    const mapped = NATURAL_VOCABULARY.get(key);

    if (mapped !== undefined) {
      promotedFilters.push({
        field: mapped.field,
        value: mapped.value,
        negated: false,
      });
    } else if (NATURAL_STOP_WORDS.has(key)) {
      // Drop stop words
      continue;
    } else {
      keptTerms.push(term);
    }
  }

  const combinedFilters = [...base.filters, ...promotedFilters];
  const dedupedFilters = deduplicateFilters(combinedFilters);

  return {
    terms: keptTerms,
    phrases: base.phrases,
    filters: dedupedFilters,
  };
}
