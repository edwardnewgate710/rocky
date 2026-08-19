#!/usr/bin/env node
/**
 * Fails when the hand-maintained copies of the supported-variant list stop agreeing.
 *
 * The set of rule sets this platform supports is written out **seven** times, in three languages,
 * and nothing derives from anything else. That is survivable only while they match, and there was
 * no check that they do.
 *
 * The sharp edge is the database. Every other variant column is
 * `variant TEXT NOT NULL REFERENCES variants(code)` — add a row to the `variants` lookup table and
 * games and ratings accept it immediately. `studies.variant` alone (migration 0022, M15 Increment 9)
 * uses an inline `CHECK (variant IN (...))`, so the same row does nothing for studies: the type
 * system says the variant is fine, the API accepts it, and Postgres rejects the insert at runtime
 * as a constraint violation. Nothing before this guard would have caught that.
 *
 * `chess-core`'s `Variant` is treated as the root: it is the type the engine actually branches on,
 * so a variant that is not there is not a variant at all. Every other list is compared to it.
 *
 * Deliberately *not* checked:
 *   - `packages/api/openapi.json` — generated from `VARIANTS` (`enum: [...VARIANTS]`) and already
 *     pinned by `openapi-nullability.test.ts`, so it is derived, not a source.
 *   - `OFFERED_VARIANTS` in the web client — a deliberate *subset* (ADR-0099 withholds `chess960`),
 *     pinned by `create-game-prefs.test.ts`. Requiring equality here would fight that decision.
 *
 * Run: node scripts/check-variant-parity.mjs
 */
import { readFileSync } from 'node:fs';

/**
 * Pulls the single-quoted (or double-quoted) tokens out of one region of a file.
 *
 * `open` locates the declaration and `close` ends it, because every one of these lists is a literal
 * spelled out in place — a union, an array, a `Set`, an `INSERT`, a `CHECK`. Matching the region and
 * then taking its quoted tokens survives reformatting, comments between entries, and the difference
 * between `|`-separated union members and comma-separated array elements.
 *
 * A region that does not match is a hard failure, never an empty list. A guard that silently starts
 * checking nothing after a rename is worse than no guard, because the green tick still gets trusted.
 */
function extract({ label, file, open, close }) {
  const text = readFileSync(file, 'utf8');
  const header = open.exec(text);
  if (header === null) {
    throw new Error(
      `${label}: could not find its declaration in ${file}. The list moved or was renamed — ` +
        `update this guard's \`open\` pattern rather than deleting the entry.`,
    );
  }
  // From the end of the header, not its start: `readonly Variant[]` and `new Set<Variant>([`
  // both carry a closing bracket of their own, and searching from the start would end the region
  // on that one before a single entry had been read.
  const rest = text.slice(header.index + header[0].length);
  const end = rest.search(close);
  if (end === -1) {
    throw new Error(`${label}: found the declaration in ${file} but not its end.`);
  }
  const region = rest.slice(0, end);
  const tokens = [...region.matchAll(/['"]([a-z0-9]+)['"]/g)].map((m) => m[1]);
  if (tokens.length === 0) {
    throw new Error(`${label}: matched a region in ${file} but it held no variant names.`);
  }
  return { label, file, variants: tokens };
}

/**
 * The root. Everything else is measured against this one.
 *
 * `Variant` in `@chess-platform/core` is where the engine's own branching lives (`movegen.ts`,
 * `position.ts`), so it is the list that decides what the word means.
 */
const ROOT = {
  label: 'chess-core `Variant`',
  file: 'packages/chess-core/src/types.ts',
  open: /export type Variant =/,
  close: /;/,
};

const MIRRORS = [
  {
    label: 'api `VARIANTS`',
    file: 'packages/api/src/domain.ts',
    open: /export const VARIANTS: readonly Variant\[\] = \[/,
    close: /\]/,
  },
  {
    label: 'studies `StudyVariant`',
    file: 'packages/studies/src/model.ts',
    open: /export type StudyVariant =/,
    close: /;/,
  },
  {
    label: 'ai-features `SUPPORTED_VARIANTS`',
    file: 'packages/ai-features/src/mistake-predictor.ts',
    open: /const SUPPORTED_VARIANTS: ReadonlySet<string> = new Set<Variant>\(\[/,
    close: /\]\)/,
  },
  {
    label: 'web `VARIANTS`',
    file: 'packages/web/src/api/models.ts',
    open: /export const VARIANTS = \[/,
    close: /\] as const;/,
  },
  {
    label: '`variants` lookup table seed',
    file: 'packages/persistence/migrations/0001_init.sql',
    // Only the `code` column is wanted, but the display names are capitalised or hyphenated
    // ('King of the Hill', 'Three-check'), so the token pattern skips them on its own.
    open: /INSERT INTO variants \(code, name\) VALUES/,
    close: /;/,
  },
  {
    label: '`studies.variant` CHECK constraint',
    file: 'packages/persistence/migrations/0022_study_variant.sql',
    open: /CHECK \(variant IN \(/,
    close: /\)\)/,
  },
];

function report(root, mirror) {
  const expected = new Set(root.variants);
  const actual = new Set(mirror.variants);
  const missing = root.variants.filter((v) => !actual.has(v));
  const extra = mirror.variants.filter((v) => !expected.has(v));
  const duplicated = mirror.variants.filter((v, i) => mirror.variants.indexOf(v) !== i);
  const problems = [];
  if (missing.length > 0) problems.push(`missing ${missing.map((v) => `\`${v}\``).join(', ')}`);
  if (extra.length > 0) problems.push(`unknown ${extra.map((v) => `\`${v}\``).join(', ')}`);
  if (duplicated.length > 0) {
    problems.push(`duplicated ${[...new Set(duplicated)].map((v) => `\`${v}\``).join(', ')}`);
  }
  return problems;
}

function main() {
  const root = extract(ROOT);
  const failures = [];

  console.log(`root: ${root.label} (${root.file})`);
  console.log(`      ${root.variants.join(', ')}\n`);

  for (const spec of MIRRORS) {
    const mirror = extract(spec);
    const problems = report(root, mirror);
    if (problems.length === 0) {
      console.log(`  ok    ${mirror.label}`);
    } else {
      console.log(`  FAIL  ${mirror.label} (${mirror.file}): ${problems.join('; ')}`);
      failures.push(mirror.label);
    }
  }

  if (failures.length > 0) {
    console.log(
      `\nThe supported-variant list disagrees with ${root.label} in ${failures.length} place(s).\n` +
        'Adding a variant means adding it to every list above, including the migration constraint —\n' +
        'a variant the types accept but the database rejects fails in production, not here.',
    );
    process.exit(1);
  }

  console.log(`\nAll ${MIRRORS.length} copies agree with ${root.label}.`);
}

try {
  main();
} catch (err) {
  console.error(`variant parity check could not run: ${err.message}`);
  process.exit(1);
}
