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
  'played',
  'between',
  'was',
  'were',
  'that',
]);

/**
 * Maps a recognized lowercase natural word to the structured filter it implies.
 * Bounded, deterministic chess-search vocabulary (documented in ADR-0051 & ADR-0055).
 */
export const NATURAL_VOCABULARY: ReadonlyMap<
  string,
  { readonly field: string; readonly value: string }
> = new Map<string, { readonly field: string; readonly value: string }>([
  // Entity types
  ['game', { field: 'type', value: 'game' }],
  ['games', { field: 'type', value: 'game' }],
  ['match', { field: 'type', value: 'game' }],
  ['matches', { field: 'type', value: 'game' }],
  ['player', { field: 'type', value: 'player' }],
  ['players', { field: 'type', value: 'player' }],
  ['user', { field: 'type', value: 'player' }],
  ['users', { field: 'type', value: 'player' }],
  ['tournament', { field: 'type', value: 'tournament' }],
  ['tournaments', { field: 'type', value: 'tournament' }],

  // Speed buckets
  ['bullet', { field: 'speed', value: 'bullet' }],
  ['ultrabullet', { field: 'speed', value: 'ultrabullet' }],
  ['blitz', { field: 'speed', value: 'blitz' }],
  ['rapid', { field: 'speed', value: 'rapid' }],
  ['classical', { field: 'speed', value: 'classical' }],
  ['correspondence', { field: 'speed', value: 'correspondence' }],

  // Variants (canonical DB codes)
  ['standard', { field: 'variant', value: 'standard' }],
  ['chess960', { field: 'variant', value: 'chess960' }],
  ['960', { field: 'variant', value: 'chess960' }],
  ['kingofthehill', { field: 'variant', value: 'kingofthehill' }],
  ['koth', { field: 'variant', value: 'kingofthehill' }],
  ['atomic', { field: 'variant', value: 'atomic' }],
  ['crazyhouse', { field: 'variant', value: 'crazyhouse' }],
  ['threecheck', { field: 'variant', value: 'threecheck' }],
  ['horde', { field: 'variant', value: 'horde' }],
  ['racingkings', { field: 'variant', value: 'racingkings' }],

  // Objective results (draws only; wins/losses require player perspective and explicit filters)
  ['draw', { field: 'result', value: '1/2-1/2' }],
  ['draws', { field: 'result', value: '1/2-1/2' }],
  ['drew', { field: 'result', value: '1/2-1/2' }],
  ['drawn', { field: 'result', value: '1/2-1/2' }],
  ['tie', { field: 'result', value: '1/2-1/2' }],
  ['tied', { field: 'result', value: '1/2-1/2' }],
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
