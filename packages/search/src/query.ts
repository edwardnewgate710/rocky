export interface SearchFilter {
  readonly field: string;
  readonly value: string;
  readonly negated: boolean;
}

export interface SearchQuery {
  /** Bare free-text words (raw, as typed). */
  readonly terms: readonly string[];
  /** Quoted phrases (inner text). */
  readonly phrases: readonly string[];
  readonly filters: readonly SearchFilter[];
}

/**
 * Parses free text query into bare terms, quoted phrases, and [-]field:value filters.
 * Non-throwing and total; handles extra whitespace, quotes, and empty values gracefully.
 */
export function parseSearchQuery(input: string): SearchQuery {
  const terms: string[] = [];
  const phrases: string[] = [];
  const filters: SearchFilter[] = [];

  if (!input) {
    return { terms, phrases, filters };
  }

  let i = 0;
  const len = input.length;

  while (i < len) {
    // Collapse/skip whitespace
    while (i < len && /\s/.test(input[i])) {
      i++;
    }
    if (i >= len) {
      break;
    }

    // A quoted phrase token starting with double quote "
    if (input[i] === '"') {
      i++; // skip opening quote
      const start = i;
      while (i < len && input[i] !== '"') {
        i++;
      }
      const inner = input.slice(start, i);
      if (i < len && input[i] === '"') {
        i++; // skip closing quote
      }
      phrases.push(inner);
      continue;
    }

    // Check for filter pattern [-]field: where field matches ^[a-zA-Z][a-zA-Z0-9_]*$
    const remaining = input.slice(i);
    const filterMatch = remaining.match(/^(-?)([a-zA-Z][a-zA-Z0-9_]*):/);

    if (filterMatch) {
      const leadingDash = filterMatch[1];
      const fieldName = filterMatch[2];
      const matchLength = filterMatch[0].length;
      const afterColonIdx = i + matchLength;

      // Check if value after colon is empty (EOF or whitespace)
      if (afterColonIdx >= len || /\s/.test(input[afterColonIdx])) {
        // Empty value (e.g. "field:" or "-field:") is NOT a filter -> treat as term (raw, as typed)
        terms.push(filterMatch[0]);
        i = afterColonIdx;
        continue;
      }

      const negated = leadingDash === '-';

      if (input[afterColonIdx] === '"') {
        // Double-quoted value e.g. field:"a b" or -field:"a b"
        const valStart = afterColonIdx + 1;
        let valEnd = valStart;
        while (valEnd < len && input[valEnd] !== '"') {
          valEnd++;
        }
        const value = input.slice(valStart, valEnd);
        if (valEnd < len && input[valEnd] === '"') {
          valEnd++; // skip closing quote
        }
        if (value.length === 0) {
          // An empty quoted value (field:"") is NOT a filter -> raw term,
          // mirroring the empty unquoted case (field:).
          terms.push(input.slice(i, valEnd));
          i = valEnd;
          continue;
        }
        filters.push({
          field: fieldName.toLowerCase(),
          value,
          negated,
        });
        i = valEnd;
        continue;
      } else {
        // Unquoted value e.g. field:blitz or -result:1-0
        let valEnd = afterColonIdx;
        while (valEnd < len && !/\s/.test(input[valEnd])) {
          valEnd++;
        }
        const value = input.slice(afterColonIdx, valEnd);
        filters.push({
          field: fieldName.toLowerCase(),
          value,
          negated,
        });
        i = valEnd;
        continue;
      }
    }

    // Any other non-empty token -> term (raw, as typed)
    let termEnd = i;
    while (termEnd < len && !/\s/.test(input[termEnd])) {
      termEnd++;
    }
    const token = input.slice(i, termEnd);
    if (token.length > 0) {
      terms.push(token);
    }
    i = termEnd;
  }

  return { terms, phrases, filters };
}
