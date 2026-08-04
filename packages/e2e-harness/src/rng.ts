/**
 * @packageDocumentation
 * Seeded pseudo-random move selection for the harness.
 *
 * The bot and the protocol test both used to pick moves with `Math.random()`. Two players choosing
 * randomly frequently fail to reach a terminal position inside the test's 300-move safety valve, so
 * the end-to-end test failed intermittently with `game did not end after 301 moves` — and worse, it
 * failed only sometimes, which is the property that makes a test worthless: a red run could not be
 * distinguished from bad luck, so the honest response was to re-run it, which is how a real
 * regression gets waved through.
 *
 * Seeding removes one source of run-to-run variance, and it is worth having: this test exists to
 * prove the protocol carries a game from first move to `ended`, not to fuzz the move generator —
 * the chess rules have their own exhaustive suites in `@chess-platform/core`.
 *
 * It is NOT sufficient on its own, and it would be dishonest to claim otherwise. How many draws each
 * side takes depends on message timing, so a seeded run still varies (measured: 109, 155 and 186
 * moves across three runs). What actually guarantees the test terminates is the bot's
 * `resignAfterPlies` lever, which the protocol test now sets.
 */

/**
 * mulberry32 — 32-bit, seedable, and short enough to keep this package dependency-free like the rest
 * of the repo. Quality beyond "well-distributed enough to pick array indices" is not needed.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick an element by index from `rng`. Empty input is a caller error, not a silent undefined. */
export function pick<T>(items: readonly T[], rng: () => number): T {
  if (items.length === 0) throw new Error('pick() called with no items');
  return items[Math.floor(rng() * items.length)]!;
}

/**
 * Derive a 32-bit deterministic seed from a base seed and a string key.
 * Uses 32-bit FNV-1a algorithm over the key's character codes, initialized with base seed.
 */
export function seedFrom(seed: number, key: string): number {
  let hash = (seed >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

