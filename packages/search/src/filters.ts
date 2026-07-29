import type { SearchFilter } from './query';

export function getFieldValue(
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

export function matchesFilter(
  filter: SearchFilter,
  fields?: Readonly<Record<string, string>>
): boolean {
  const docVal = getFieldValue(fields, filter.field);
  const isMatch = docVal !== undefined && docVal.toLowerCase() === filter.value.toLowerCase();
  return filter.negated ? !isMatch : isMatch;
}

export function matchesAllFilters(
  filters: readonly SearchFilter[],
  fields?: Readonly<Record<string, string>>
): boolean {
  for (const filter of filters) {
    if (!matchesFilter(filter, fields)) {
      return false;
    }
  }
  return true;
}
