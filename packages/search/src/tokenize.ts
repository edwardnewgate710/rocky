/** Normalize free text into lowercase alphanumeric tokens (search's shared text primitive). */
export function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}
