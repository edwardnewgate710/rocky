#!/usr/bin/env node
/**
 * Fails when the hand-maintained copies of the supported-variant list stop agreeing.
 *
 * The set of rule sets this platform supports is written out in six places, in two languages, and
 * nothing derives from anything else. That is survivable only while they match, and there was no
 * check that they do.
 *
 * The database variant columns (games, ratings, seeks, and studies via migrations 0028/0029) are
 * `variant TEXT NOT NULL REFERENCES variants(code)`, so once a row exists in the `variants` lookup
 * table the database accepts that value uniformly. `studies.variant` was initially governed by an
 * inline `CHECK (variant IN (...))` in migration 0022 and converted to `REFERENCES variants(code)`
 * in migration 0028 (validated in 0029). The application-level declarations below still need their
 * own updates in either case — the lookup row settles what the *database* will store.
 *
 * `chess-core`'s `Variant` is treated as the root: it is the type the engine actually branches on,
 * so a variant that is not there is not a variant at all. Every other list is compared to it.
 *
 * Two things this deliberately does NOT do:
 *
 *   - **It does not read historical migrations as if they were the current schema.** Applied
 *     migrations are checksummed and immutable (`pg/migrate.ts`: "history is immutable"), so a new
 *     variant arrives through a *new* forward migration, leaving 0001 and 0022 untouched. A guard
 *     that compared against those files directly would fail forever on a correct change and could
 *     only be satisfied by editing an applied file — which aborts migration on every existing
 *     deployment. Both SQL sources are therefore replayed across the whole migration directory to
 *     produce the *effective* schema. Raised in the Qodo review of PR #141.
 *   - **It does not count variants inside comments.** Matching quoted tokens in raw source treats a
 *     commented-out entry as live, so real drift passes. Every region is comment-stripped first,
 *     with string literals respected. Raised in the Qodo review of PR #141.
 *
 * Not checked, because they are not independent copies:
 *   - `packages/api/openapi.json` — generated from `VARIANTS` (`enum: [...VARIANTS]`) and already
 *     pinned by `openapi-nullability.test.ts`, so it is derived, not a source.
 *   - `OFFERED_VARIANTS` in the web client — a deliberate *subset* (ADR-0099 withholds `chess960`),
 *     pinned by `create-game-prefs.test.ts`. Requiring equality here would fight that decision.
 *
 * Run: node scripts/check-variant-parity.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = 'packages/persistence/migrations';

/**
 * Blanks out comments, leaving everything else at its original offset.
 *
 * Replaces rather than deletes so that any position reported against the result still lines up with
 * the source. String literals are tracked so a `--` or `//` inside one is not mistaken for the start
 * of a comment; TypeScript backslash escapes and SQL doubled quotes both fall out of that naturally,
 * the first because the escape is consumed, the second because the closing quote immediately reopens
 * a new string.
 *
 * @param {string} text
 * @param {'ts' | 'sql'} dialect
 */
export function stripComments(text, dialect) {
  const lineMarker = dialect === 'sql' ? '--' : '//';
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote !== null) {
      out += ch;
      if (dialect === 'ts' && ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || (dialect === 'ts' && ch === '`')) {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === lineMarker[0] && next === lineMarker[1]) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Pulls the quoted variant codes out of one region of a source file.
 *
 * `open` locates the declaration and `close` ends it, because every one of these lists is a literal
 * spelled out in place. Matching the region and then taking its quoted tokens survives reformatting
 * and the difference between `|`-separated union members and comma-separated array elements.
 *
 * A region that does not match is a hard failure, never an empty list. A guard that silently starts
 * checking nothing after a rename is worse than no guard, because the green tick still gets trusted.
 *
 * @param {{label: string, file: string, open: RegExp, close: RegExp, dialect?: 'ts' | 'sql', text?: string}} spec
 */
export function extractRegion({ label, file, open, close, dialect = 'ts', text }) {
  const source = stripComments(text ?? readFileSync(file, 'utf8'), dialect);
  const header = open.exec(source);
  if (header === null) {
    throw new Error(
      `${label}: could not find its declaration in ${file}. The list moved or was renamed — ` +
        `update this guard's \`open\` pattern rather than deleting the entry.`,
    );
  }
  // From the end of the header, not its start: `readonly Variant[]` and `new Set<Variant>([` both
  // carry a closing bracket of their own, and searching from the start would end the region on that
  // one before a single entry had been read.
  const rest = source.slice(header.index + header[0].length);
  const end = rest.search(close);
  if (end === -1) throw new Error(`${label}: found the declaration in ${file} but not its end.`);
  const variants = [...rest.slice(0, end).matchAll(/['"]([a-z0-9]+)['"]/g)].map((m) => m[1]);
  if (variants.length === 0) {
    throw new Error(`${label}: matched a region in ${file} but it held no variant names.`);
  }
  return { label, file, variants };
}

/**
 * Every migration file, in the order the runner applies them.
 *
 * A plain lexicographic `.sort()`, because that is exactly what `pg/migrate.ts` does. Replaying
 * in any other order would model a database that never existed: with the four-digit zero-padded
 * names this repository uses the two orders coincide, but `9_x.sql` and `10_y.sql` would apply
 * as `10` then `9`, and a guard that sorted numerically would disagree with the schema on disk.
 * Fidelity to the runner is the invariant, not numeric intuition.
 */
export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Splits SQL into statements, respecting string literals so a `;` inside one does not end one.
 *
 * Comment stripping runs first, so only quotes are left to worry about.
 */
export function splitStatements(sql) {
  const statements = [];
  let buffer = '';
  let quote = null;
  for (const ch of sql) {
    if (quote !== null) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === ';') {
      statements.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim() !== '') statements.push(buffer);
  return statements;
}

/**
 * The rows the `variants` lookup table holds after every migration has run.
 *
 * Accumulated forward rather than read out of 0001, because a ninth variant arrives in a new
 * migration and 0001 can never change. Any statement that mutates the table in a way this does not
 * model is a hard failure: quietly returning a set that ignores a `DELETE` would be a guard
 * confidently reporting the wrong schema.
 */
export function effectiveLookupVariants(dir = MIGRATIONS_DIR) {
  const codes = [];
  for (const file of migrationFiles(dir)) {
    const sql = stripComments(readFileSync(join(dir, file), 'utf8'), 'sql');

    const unmodelled = /\b(DELETE\s+FROM|UPDATE)\s+variants\b/i.exec(sql);
    if (unmodelled !== null) {
      throw new Error(
        `${file} does something to the \`variants\` table this guard does not model ` +
          `(\`${unmodelled[0]}\`). Teach it that statement rather than leaving it reporting a ` +
          `schema that no longer exists.`,
      );
    }

    for (const insert of sql.matchAll(/INSERT\s+INTO\s+variants\s*\([^)]*\)\s*VALUES([\s\S]*?);/gi)) {
      // The first column of each tuple is `code`; the second is a display name that is capitalised
      // or hyphenated, so taking the leading element of each `(...)` keeps them apart reliably.
      for (const tuple of insert[1].matchAll(/\(\s*'([^']+)'/g)) codes.push(tuple[1]);
    }
  }
  if (codes.length === 0) throw new Error(`no INSERT INTO variants found under ${dir}`);
  return codes;
}

/**
 * How `studies.variant` is constrained after every migration has run.
 *
 * The last migration to define the constraint wins, so replacing it (`DROP CONSTRAINT ... ,
 * ADD CONSTRAINT ... CHECK (...)`) is a supported forward change rather than a reason to edit 0022.
 *
 * A migration that swaps the `CHECK` for `REFERENCES variants(code)` — the conversion recorded as a
 * candidate in PROJECT_STATE — makes the column derive from the lookup table, at which point there
 * is no separate list left to drift. That returns `null`, and the caller skips the mirror.
 */
/**
 * `CREATE TABLE studies` / `ALTER TABLE studies`, and nothing else.
 *
 * `IF EXISTS` and `IF NOT EXISTS` are both accepted because both are valid PostgreSQL and a
 * migration is exactly where the defensive form gets written. Skipping `ALTER TABLE IF EXISTS
 * studies` would leave the guard comparing against a constraint that statement had just replaced.
 * Raised in the CodeRabbit review of PR #141.
 */
const TARGETS_STUDIES =
  /^\s*(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:ONLY\s+)?"?studies"?[\s(]/i;

/**
 * The name PostgreSQL gives a `CHECK` on `studies.variant` that was written without one.
 *
 * `<table>_<column>_check` is the server's own convention, so this is what a later migration has to
 * name in its `DROP CONSTRAINT` — which makes it the right default to track against.
 */
const IMPLICIT_CONSTRAINT_NAME = 'studies_variant_check';

/** The name PostgreSQL gives a foreign key on `studies.variant` written without an explicit name. */
const IMPLICIT_FK_CONSTRAINT_NAME = 'studies_variant_fkey';

/** A `CHECK (variant IN (...))`, with the constraint name when the statement gives one. */
const VARIANT_CHECK = /(?:CONSTRAINT\s+"?(\w+)"?\s+)?CHECK\s*\(\s*variant\s+IN\s*\(([\s\S]*?)\)\s*\)/gi;

/** Table-level `FOREIGN KEY (variant) REFERENCES variants(code)`. */
const VARIANT_FK_TABLE =
  /(?:CONSTRAINT\s+"?(\w+)"?\s+)?FOREIGN\s+KEY\s*\(\s*"?variant"?\s*\)\s*REFERENCES\s+variants\s*\(\s*code\s*\)/i;

/** Inline-column `variant TEXT ... [CONSTRAINT name] REFERENCES variants(code)`. */
const VARIANT_FK_INLINE =
  /(?:ADD\s+COLUMN|CREATE\s+TABLE)\s+[^;]*?\bvariant\b\s+TEXT\b[^,;)]*?(?:CONSTRAINT\s+"?(\w+)"?\s+)?REFERENCES\s+variants\s*\(\s*code\s*\)/i;

const normalise = (name) => name.replace(/"/g, '').toLowerCase();

export function effectiveStudyVariantConstraint(dir = MIGRATIONS_DIR) {
  let current = null;
  for (const file of migrationFiles(dir)) {
    const sql = stripComments(readFileSync(join(dir, file), 'utf8'), 'sql');

    // Per statement, and only statements that name `studies` as their table. Testing the file as a
    // whole let any other table move the answer: one migration that touches `studies` and also gives
    // some other table its own `variant` CHECK would have overwritten this, and a `REFERENCES
    // variants(code)` elsewhere in the same file — which is how games and ratings are already
    // declared — would have cleared it, silently skipping the mirror the guard exists to compare.
    // Raised in the CodeRabbit review of PR #141.
    for (const statement of splitStatements(sql)) {
      if (!TARGETS_STUDIES.test(statement)) continue;

      // A rename would leave every name tracked below pointing at something that no longer answers
      // to it, and the drop that follows would look like an unrelated constraint. There is no
      // half-right answer available, so say so rather than report a schema that is not there.
      const renamed = /RENAME\s+CONSTRAINT\s+"?(\w+)"?/i.exec(statement);
      if (renamed !== null && current !== null && normalise(renamed[1]) === current.name) {
        throw new Error(
          `${file} renames the constraint governing \`studies.variant\` ` +
            `(\`${renamed[1]}\`). Teach this guard \`RENAME CONSTRAINT\` rather than leaving it ` +
            `tracking a name nothing answers to.`,
        );
      }

      // Order matters: `DROP CONSTRAINT` then `ADD CONSTRAINT ... CHECK` is how a constraint is
      // replaced without editing the migration that first defined it. The name is compared exactly
      // against the one being tracked — a substring test for "variant" both missed a legitimately
      // named constraint (`DROP CONSTRAINT allowed_codes`) and would have fired on an unrelated one
      // that happened to contain the word. Raised in the CodeRabbit review of PR #141.
      const dropped = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(statement);
      if (dropped !== null && current !== null && normalise(dropped[1]) === current.name) {
        current = null;
      }
      if (/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?variant"?/i.test(statement)) current = null;

      for (const m of statement.matchAll(VARIANT_CHECK)) {
        current = {
          file,
          name: normalise(m[1] ?? IMPLICIT_CONSTRAINT_NAME),
          variants: [...m[2].matchAll(/'([a-z0-9]+)'/g)].map((t) => t[1]),
        };
      }

      // Once the column derives from the lookup table there is no second list left to drift.
      if (VARIANT_FK_TABLE.test(statement) || VARIANT_FK_INLINE.test(statement)) {
        current = null;
      }
    }
  }
  return current;
}

/**
 * Returns true if the effective migration schema defines an active foreign key on studies.variant referencing variants(code).
 *
 * @param {string} dir The migrations directory to replay.
 * @returns {boolean} Whether studies.variant has an active foreign key referencing variants(code).
 */
export function effectiveStudyVariantForeignKey(dir = MIGRATIONS_DIR) {
  const activeFks = new Set();
  for (const file of migrationFiles(dir)) {
    const sql = stripComments(readFileSync(join(dir, file), 'utf8'), 'sql');
    for (const statement of splitStatements(sql)) {
      if (!TARGETS_STUDIES.test(statement)) continue;

      const renamed = /RENAME\s+CONSTRAINT\s+"?(\w+)"?\s+TO\s+"?(\w+)"?/i.exec(statement);
      if (renamed !== null && activeFks.has(normalise(renamed[1]))) {
        activeFks.delete(normalise(renamed[1]));
        activeFks.add(normalise(renamed[2]));
      }

      const dropped = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(statement);
      if (dropped !== null) {
        activeFks.delete(normalise(dropped[1]));
      }
      if (/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?variant"?/i.test(statement)) {
        activeFks.clear();
      }

      const tableMatch = VARIANT_FK_TABLE.exec(statement);
      const inlineMatch = VARIANT_FK_INLINE.exec(statement);
      if (tableMatch !== null) {
        activeFks.add(normalise(tableMatch[1] ?? IMPLICIT_FK_CONSTRAINT_NAME));
      } else if (inlineMatch !== null) {
        activeFks.add(normalise(inlineMatch[1] ?? IMPLICIT_FK_CONSTRAINT_NAME));
      }
    }
  }
  return activeFks.size > 0;
}

/** The root. Everything else is measured against this one. */
export const ROOT = {
  label: 'chess-core `Variant`',
  file: 'packages/chess-core/src/types.ts',
  open: /export type Variant =/,
  close: /;/,
};

/** The hand-maintained TypeScript copies. */
export const TS_MIRRORS = [
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
];

/** Every disagreement between one mirror and the root, named. */
export function disagreements(rootVariants, mirrorVariants) {
  const expected = new Set(rootVariants);
  const actual = new Set(mirrorVariants);
  const missing = rootVariants.filter((v) => !actual.has(v));
  const extra = mirrorVariants.filter((v) => !expected.has(v));
  const duplicated = [...new Set(mirrorVariants.filter((v, i) => mirrorVariants.indexOf(v) !== i))];
  const problems = [];
  const list = (vs) => vs.map((v) => `\`${v}\``).join(', ');
  if (missing.length > 0) problems.push(`missing ${list(missing)}`);
  if (extra.length > 0) problems.push(`unknown ${list(extra)}`);
  if (duplicated.length > 0) problems.push(`duplicated ${list(duplicated)}`);
  return problems;
}

/** Every list to compare, with the SQL ones replayed to their effective state. */
export function collectMirrors(dir = MIGRATIONS_DIR) {
  const mirrors = TS_MIRRORS.map(extractRegion);
  mirrors.push({
    label: '`variants` lookup table, after all migrations',
    file: dir,
    variants: effectiveLookupVariants(dir),
  });
  const study = effectiveStudyVariantConstraint(dir);
  const hasStudyVariantFk = effectiveStudyVariantForeignKey(dir);
  if (study !== null) {
    mirrors.push({
      label: '`studies.variant` CHECK constraint, after all migrations',
      file: join(dir, study.file),
      variants: study.variants,
    });
  }
  return { mirrors, studyConstraint: study, hasStudyVariantFk };
}

function main() {
  const root = extractRegion(ROOT);
  const { mirrors, studyConstraint, hasStudyVariantFk } = collectMirrors();
  const failures = [];

  console.log(`root: ${root.label} (${root.file})`);
  console.log(`      ${root.variants.join(', ')}\n`);

  for (const mirror of mirrors) {
    const problems = disagreements(root.variants, mirror.variants);
    if (problems.length === 0) {
      console.log(`  ok    ${mirror.label}`);
    } else {
      console.log(`  FAIL  ${mirror.label} (${mirror.file}): ${problems.join('; ')}`);
      failures.push(mirror.label);
    }
  }

  if (studyConstraint === null) {
    if (hasStudyVariantFk) {
      console.log(
        '  --    `studies.variant` has no CHECK left; it derives from `variants(code)`, nothing to compare',
      );
    } else {
      console.log(
        '  FAIL  `studies.variant` has no CHECK constraint and no foreign key referencing `variants(code)`',
      );
      failures.push('`studies.variant` missing foreign key');
    }
  }

  if (failures.length > 0) {
    console.log(
      `\nThe supported-variant list disagrees with ${root.label} in ${failures.length} place(s).\n` +
        'Adding a variant means adding it to every list above. The SQL ones are replayed across the\n' +
        'whole migration directory, so add a NEW migration — applied files are checksummed and\n' +
        'immutable, and editing one aborts migration on every existing deployment.',
    );
    process.exit(1);
  }

  console.log(`\nAll ${mirrors.length} copies agree with ${root.label}.`);
}

// Run as a command, stay quiet when imported by the tests. `pathToFileURL` rather than string
// surgery on `file://` + argv, because a Windows path produces `file:///C:/...` and a hand-built
// URL does not, so the comparison would silently never match and the CLI would do nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`variant parity check could not run: ${err.message}`);
    process.exit(1);
  }
}
