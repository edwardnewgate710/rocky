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

/**
 * Directory holding the database migration SQL scripts.
 * @type {string}
 */
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
 * @param {string} text The raw source code to strip.
 * @param {'ts' | 'sql'} dialect The language dialect determining comment syntax.
 * @returns {string} Comment-stripped source code with preserved offsets.
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

    if (dialect === 'sql' && ch === '$') {
      const match = /^\$([a-zA-Z0-9_]*)\$/.exec(text.slice(i));
      if (match !== null) {
        const tag = match[0];
        const endStr = text.indexOf(tag, i + tag.length);
        if (endStr !== -1) {
          const fullDollar = text.slice(i, endStr + tag.length);
          out += fullDollar;
          i += fullDollar.length;
          continue;
        }
      }
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
 * Token represents a lexical unit extracted from SQL source text.
 * @typedef {Object} SqlToken
 * @property {'word' | 'ident' | 'string' | 'punct'} type The syntactic category of the token.
 * @property {string} value The normalized token value (lowercase for identifiers/keywords).
 * @property {string} raw The verbatim token text from source.
 * @property {number} pos The starting character offset in the source.
 */

/**
 * Tokenizes SQL source into a flat array of lexical tokens.
 *
 * Correctly distinguishes single-quoted strings (with doubled quote escaping `''`),
 * double-quoted identifiers (with doubled quote escaping `""`), keywords/unquoted words,
 * and punctuation tokens.
 *
 * @param {string} sql Comment-stripped SQL text.
 * @returns {SqlToken[]} Array of SQL tokens.
 */
export function tokenizeSql(sql) {
  /** @type {SqlToken[]} */
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '$') {
      const match = /^\$([a-zA-Z0-9_]*)\$/.exec(sql.slice(i));
      if (match !== null) {
        const tag = match[0];
        const start = i;
        const endStr = sql.indexOf(tag, start + tag.length);
        if (endStr === -1) {
          throw new Error(`unterminated dollar-quoted string at position ${start}`);
        }
        const raw = sql.slice(start, endStr + tag.length);
        const body = sql.slice(start + tag.length, endStr);
        tokens.push({
          type: 'string',
          value: body,
          raw: raw,
          pos: start,
        });
        i = endStr + tag.length;
        continue;
      }
    }

    if (ch === "'") {
      const start = i;
      let val = '';
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            val += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i];
        i++;
      }
      tokens.push({
        type: 'string',
        value: val,
        raw: sql.slice(start, i),
        pos: start,
      });
      continue;
    }

    if (ch === '"') {
      const start = i;
      let val = '';
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i];
        i++;
      }
      tokens.push({
        type: 'ident',
        value: val,
        raw: sql.slice(start, i),
        pos: start,
      });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[a-zA-Z0-9_$]/.test(sql[i])) {
        i++;
      }
      const word = sql.slice(start, i);
      tokens.push({
        type: 'word',
        value: word.toLowerCase(),
        raw: word,
        pos: start,
      });
      continue;
    }

    // Punctuation and operators (;, ,, (, ), ., *, |, =, <, >, :, +, -, etc.)
    tokens.push({
      type: 'punct',
      value: ch,
      raw: ch,
      pos: i,
    });
    i++;
  }
  return tokens;
}

/**
 * Splits a stream of SQL tokens into individual statements delimited by top-level semicolons.
 *
 * @param {SqlToken[]} tokens Array of SQL tokens.
 * @returns {SqlToken[][]} Array of statement token arrays.
 */
export function splitSqlStatements(tokens) {
  const statements = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === 'punct' && token.value === ';') {
      if (current.length > 0) {
        statements.push(current);
        current = [];
      }
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    statements.push(current);
  }
  return statements;
}

/**
 * Parses a table reference from a token stream starting at `startIndex`.
 * Handles optional `ONLY` and optional `schema.` qualifiers.
 *
 * @param {SqlToken[]} tokens Array of SQL tokens.
 * @param {number} startIndex Position in token stream to begin parsing table reference.
 * @returns {{ schema: string, table: string, nextIndex: number } | null} Parsed table reference or null if invalid.
 */
export function parseQualifiedTableTarget(tokens, startIndex) {
  let idx = startIndex;
  if (tokens[idx]?.value === 'only') idx++;

  if (!tokens[idx] || (tokens[idx].type !== 'word' && tokens[idx].type !== 'ident')) {
    return null;
  }

  const firstIdent = tokens[idx].value;
  idx++;

  if (tokens[idx]?.type === 'punct' && tokens[idx].value === '.') {
    idx++;
    if (!tokens[idx] || (tokens[idx].type !== 'word' && tokens[idx].type !== 'ident')) {
      return null;
    }
    const secondIdent = tokens[idx].value;
    idx++;
    return { schema: firstIdent, table: secondIdent, nextIndex: idx };
  }

  return { schema: 'public', table: firstIdent, nextIndex: idx };
}

/**
 * Computes a collision-free structured tuple key for a table reference.
 *
 * @param {{ schema?: string, table: string } | null} ref Parsed table reference.
 * @returns {string} Structured key encoding [schema, table].
 */
export function tableKey(ref) {
  if (ref === null) return '';
  return JSON.stringify([ref.schema || 'public', ref.table]);
}

export const STUDIES_TABLE_KEY = tableKey({ schema: 'public', table: 'studies' });
export const VARIANTS_TABLE_KEY = tableKey({ schema: 'public', table: 'variants' });

/**
 * Determines if a parsed table reference matches a specified table and default schema.
 *
 * @param {{ schema?: string, table: string } | null} ref Parsed table reference.
 * @param {string} targetTable Expected table name.
 * @param {string} [targetSchema='public'] Expected schema name (defaults to 'public').
 * @returns {boolean} True if the table reference matches the target.
 */
function isTableTarget(ref, targetTable, targetSchema = 'public') {
  if (ref === null) return false;
  return tableKey(ref) === tableKey({ schema: targetSchema, table: targetTable });
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
 * @param {{label: string, file: string, open: RegExp, close: RegExp, dialect?: 'ts' | 'sql', text?: string}} spec Target region specification.
 * @returns {{ label: string, file: string, variants: string[] }} Extracted variant list.
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
 *
 * @param {string} [dir=MIGRATIONS_DIR] Directory containing migration SQL files.
 * @returns {string[]} Sorted migration file names.
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
 *
 * @param {string} sql Comment-stripped SQL text.
 * @returns {string[]} Individual SQL statements.
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
 *
 * @param {string} [dir=MIGRATIONS_DIR] Path to the directory containing migration files.
 * @returns {string[]} Array of variant codes present in the lookup table.
 * @throws {Error} If unmodelled mutations (DELETE/UPDATE) or no INSERT statements are found.
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
 * Allocates the next implicit constraint name following PostgreSQL's naming convention.
 *
 * If the candidate base name is free on the table, it is chosen. If already occupied anywhere
 * in the table's constraint namespace, the lowest available positive integer suffix is appended.
 *
 * @param {Set<string>} constraintNamespace The set of all constraint names currently active on the table.
 * @param {string} baseName The base constraint name (e.g. 'studies_variant_check' or 'studies_variant_fkey').
 * @returns {string} The allocated unique constraint name.
 */
function nextImplicitConstraintName(constraintNamespace, baseName) {
  if (!constraintNamespace.has(baseName)) {
    return baseName;
  }
  let suffix = 1;
  while (constraintNamespace.has(`${baseName}${suffix}`)) {
    suffix++;
  }
  return `${baseName}${suffix}`;
}

/**
 * Splits action clauses of an ALTER TABLE statement by comma at parenthesis nesting depth 0.
 *
 * @param {SqlToken[]} tokens Action tokens following the table target.
 * @returns {SqlToken[][]} Array of token arrays, one per action clause.
 */
function splitAlterActions(tokens) {
  const actions = [];
  let current = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === 'punct') {
      if (token.value === '(') depth++;
      else if (token.value === ')') depth--;
      else if (token.value === ',' && depth === 0) {
        if (current.length > 0) {
          actions.push(current);
          current = [];
        }
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) {
    actions.push(current);
  }
  return actions;
}

/**
 * Parses a strict IN-list of string literals: `('literal1', 'literal2', ...)`.
 *
 * @param {SqlToken[]} tokens Array of tokens.
 * @param {number} startIndex Index of first token inside the `IN (` list.
 * @returns {{ variants: string[], nextIndex: number } | null} Parsed variants and next token index, or null if malformed.
 */
function parseStrictVariantInList(tokens, startIndex) {
  let idx = startIndex;
  const variants = [];
  let expectLiteral = true;

  while (idx < tokens.length) {
    const t = tokens[idx];
    if (expectLiteral) {
      if (t.type === 'string') {
        variants.push(t.value);
        expectLiteral = false;
        idx++;
      } else {
        return null;
      }
    } else {
      if (t.type === 'punct' && t.value === ',') {
        expectLiteral = true;
        idx++;
      } else if (t.type === 'punct' && t.value === ')') {
        return { variants, nextIndex: idx + 1 };
      } else {
        return null;
      }
    }
  }

  return null;
}

/**
 * Scans a column definition clause for CHECK and REFERENCES constraints on variant.
 *
 * @param {SqlToken[]} clause Tokens making up the column definition.
 * @param {string} file Current migration filename.
 * @param {Set<string>} constraintNamespace Set of active table constraint names.
 * @param {Set<string>} variantConstraints Set of constraint names dependent on the variant column.
 * @param {Map<string, { file: string, name: string, variants: string[] }>} activeChecks Active CHECK map.
 * @param {Set<string>} activeFks Active foreign key set.
 */
function scanColumnConstraints(clause, file, constraintNamespace, variantConstraints, activeChecks, activeFks) {
  for (let i = 0; i < clause.length; i++) {
    // Check for inline CHECK (variant ...)
    if (clause[i].value === 'check' && clause[i + 1]?.value === '(') {
      let depth = 1;
      let endIdx = i + 2;
      while (endIdx < clause.length && depth > 0) {
        if (clause[endIdx].value === '(') depth++;
        else if (clause[endIdx].value === ')') depth--;
        endIdx++;
      }
      const checkTokens = clause.slice(i + 2, endIdx - 1);
      const referencesVariant = checkTokens.some((t) => (t.type === 'word' || t.type === 'ident') && t.value === 'variant');
      if (referencesVariant) {
        const pIdx = i + 2;
        if (clause[pIdx]?.value === 'variant' && clause[pIdx + 1]?.value === 'in' && clause[pIdx + 2]?.value === '(') {
          let inlineName = null;
          if (i >= 2 && clause[i - 2]?.value === 'constraint') {
            inlineName = clause[i - 1]?.value;
          }
          const parsedIn = parseStrictVariantInList(clause, pIdx + 3);
          if (parsedIn === null) {
            throw new Error(
              `${file} defines an unsupported CHECK predicate shape on \`studies.variant\` ` +
                `(\`${clause.map((t) => t.raw).join(' ')}\`). Teach this guard non-standard CHECK predicates ` +
                `rather than ignoring the constraint.`,
            );
          }
          if (clause[parsedIn.nextIndex]?.value !== ')') {
            throw new Error(
              `${file} defines a compound or non-standard CHECK predicate on \`studies.variant\` ` +
                `(\`${clause.map((t) => t.raw).join(' ')}\`). Teach this guard compound CHECK predicates ` +
                `rather than ignoring suffix expressions.`,
            );
          }
          const name = inlineName ?? nextImplicitConstraintName(constraintNamespace, 'studies_variant_check');
          constraintNamespace.add(name);
          variantConstraints.add(name);
          activeChecks.set(name, { file, name, variants: parsedIn.variants });
        } else {
          throw new Error(
            `${file} defines an unsupported CHECK predicate shape on \`studies.variant\` ` +
              `(\`${clause.map((t) => t.raw).join(' ')}\`). Teach this guard non-standard CHECK predicates ` +
              `rather than ignoring the constraint.`,
          );
        }
      }
    }

    // Check for inline REFERENCES variants(code)
    if (clause[i].value === 'references') {
      const inlineRef = parseQualifiedTableTarget(clause, i + 1);
      if (inlineRef && isTableTarget(inlineRef, 'variants')) {
        const afterRef = inlineRef.nextIndex;
        if (clause[afterRef]?.value === '(' && clause[afterRef + 1]?.value === 'code' && clause[afterRef + 2]?.value === ')') {
          let inlineName = null;
          if (i >= 2 && clause[i - 2]?.value === 'constraint') {
            inlineName = clause[i - 1]?.value;
          }
          const name = inlineName ?? nextImplicitConstraintName(constraintNamespace, 'studies_variant_fkey');
          constraintNamespace.add(name);
          variantConstraints.add(name);
          activeFks.add(name);
        }
      }
    }
  }
}

/**
 * Replays all migrations through a deterministic schema state machine to evaluate constraints on `studies.variant`.
 *
 * Tracks table drops (including multi-table and cascaded variants drops), table renames, column drops,
 * column renames, explicit constraint additions/drops/renames, and implicit PostgreSQL constraint name allocation.
 *
 * @param {string} [dir=MIGRATIONS_DIR] Migrations directory path.
 * @returns {{
 *   check: { file: string, name: string, variants: string[] } | null,
 *   checks: Array<{ file: string, name: string, variants: string[] }>,
 *   hasForeignKey: boolean
 * }} Effective check constraint on studies.variant and whether an active foreign key referencing variants(code) exists.
 */
export function replayStudiesSchema(dir = MIGRATIONS_DIR) {
  /**
   * @type {Map<string, {
   *   hasVariantColumn: boolean,
   *   constraintNamespace: Set<string>,
   *   variantConstraints: Set<string>,
   *   activeChecks: Map<string, { file: string, name: string, variants: string[] }>,
   *   activeFks: Set<string>
   * }>}
   */
  const tables = new Map();

  function getOrCreateTable(key) {
    let t = tables.get(key);
    if (!t) {
      t = {
        hasVariantColumn: false,
        constraintNamespace: new Set(),
        variantConstraints: new Set(),
        activeChecks: new Map(),
        activeFks: new Set(),
      };
      tables.set(key, t);
    }
    return t;
  }

  for (const file of migrationFiles(dir)) {
    const rawSql = readFileSync(join(dir, file), 'utf8');
    const stripped = stripComments(rawSql, 'sql');
    const tokens = tokenizeSql(stripped);
    const statements = splitSqlStatements(tokens);

    for (const stmt of statements) {
      if (stmt.length < 2) continue;

      // -----------------------------------------------------------------------
      // 1. DROP TABLE [IF EXISTS] [ONLY] table1 [, table2 ...] [CASCADE | RESTRICT]
      // -----------------------------------------------------------------------
      if (stmt[0].value === 'drop' && stmt[1].value === 'table') {
        let idx = 2;
        if (stmt[idx]?.value === 'if' && stmt[idx + 1]?.value === 'exists') {
          idx += 2;
        }

        const hasCascade = stmt.some((t) => t.value === 'cascade');

        while (idx < stmt.length) {
          if (stmt[idx]?.value === 'cascade' || stmt[idx]?.value === 'restrict') {
            break;
          }
          const ref = parseQualifiedTableTarget(stmt, idx);
          if (ref === null) break;
          idx = ref.nextIndex;

          const key = tableKey(ref);

          if (key === VARIANTS_TABLE_KEY && hasCascade) {
            for (const tbl of tables.values()) {
              for (const fkName of tbl.activeFks) {
                tbl.constraintNamespace.delete(fkName);
                tbl.variantConstraints.delete(fkName);
              }
              tbl.activeFks.clear();
            }
          }

          if (key === STUDIES_TABLE_KEY || tables.has(key)) {
            tables.delete(key);
          }

          if (stmt[idx]?.type === 'punct' && stmt[idx].value === ',') {
            idx++;
          } else {
            break;
          }
        }
        continue;
      }

      // -----------------------------------------------------------------------
      // 2. ALTER TABLE [IF EXISTS] [ONLY] target ...
      // -----------------------------------------------------------------------
      if (stmt[0].value === 'alter' && stmt[1].value === 'table') {
        let idx = 2;
        let isTableIfExists = false;
        if (stmt[idx]?.value === 'if' && stmt[idx + 1]?.value === 'exists') {
          isTableIfExists = true;
          idx += 2;
        }

        const ref = parseQualifiedTableTarget(stmt, idx);
        if (ref === null) {
          continue;
        }

        const key = tableKey(ref);
        if (key !== STUDIES_TABLE_KEY && !tables.has(key)) {
          continue;
        }

        if (isTableIfExists && !tables.has(key)) {
          continue;
        }

        const currentTable = getOrCreateTable(key);
        idx = ref.nextIndex;

        // Table rename: ALTER TABLE target RENAME TO new_name
        if (stmt[idx]?.value === 'rename' && stmt[idx + 1]?.value === 'to') {
          const newName = stmt[idx + 2]?.value;
          if (newName) {
            const newKey = tableKey({ schema: ref.schema || 'public', table: newName });
            tables.delete(key);
            tables.set(newKey, currentTable);
          }
          continue;
        }

        // Table schema move: ALTER TABLE target SET SCHEMA new_schema
        if (stmt[idx]?.value === 'set' && stmt[idx + 1]?.value === 'schema') {
          const newSchema = stmt[idx + 2]?.value;
          if (newSchema) {
            const newKey = tableKey({ schema: newSchema, table: ref.table });
            tables.delete(key);
            tables.set(newKey, currentTable);
          }
          continue;
        }

        const actionTokens = stmt.slice(idx);
        const actionClauses = splitAlterActions(actionTokens);

        for (const action of actionClauses) {
          if (action.length === 0) continue;

          // Action A: DROP CONSTRAINT [IF EXISTS] <name>
          if (action[0].value === 'drop' && action[1]?.value === 'constraint') {
            let cIdx = 2;
            if (action[cIdx]?.value === 'if' && action[cIdx + 1]?.value === 'exists') {
              cIdx += 2;
            }
            if (action[cIdx]?.type === 'word' || action[cIdx]?.type === 'ident') {
              const name = action[cIdx].value;
              currentTable.constraintNamespace.delete(name);
              currentTable.variantConstraints.delete(name);
              currentTable.activeChecks.delete(name);
              currentTable.activeFks.delete(name);
            }
            continue;
          }

          // Action B: RENAME CONSTRAINT <old_name> TO <new_name>
          if (action[0].value === 'rename' && action[1]?.value === 'constraint') {
            const oldName = action[2]?.value;
            if (oldName && currentTable.activeChecks.has(oldName)) {
              throw new Error(
                `${file} renames the constraint governing \`studies.variant\` ` +
                  `(\`${oldName}\`). Teach this guard \`RENAME CONSTRAINT\` rather than leaving it ` +
                  `tracking a name nothing answers to.`,
              );
            }
            if (oldName && action[3]?.value === 'to' && action[4]) {
              const newName = action[4].value;
              if (currentTable.constraintNamespace.has(oldName)) {
                currentTable.constraintNamespace.delete(oldName);
                currentTable.constraintNamespace.add(newName);
              }
              if (currentTable.variantConstraints.has(oldName)) {
                currentTable.variantConstraints.delete(oldName);
                currentTable.variantConstraints.add(newName);
              }
              if (currentTable.activeFks.has(oldName)) {
                currentTable.activeFks.delete(oldName);
                currentTable.activeFks.add(newName);
              }
            }
            continue;
          }

          // Action C: DROP [COLUMN] [IF EXISTS] <col_name>
          if (action[0].value === 'drop') {
            let cIdx = 1;
            if (action[cIdx]?.value === 'column') cIdx++;
            if (action[cIdx]?.value === 'if' && action[cIdx + 1]?.value === 'exists') cIdx += 2;
            if (action[cIdx]?.value === 'variant') {
              currentTable.hasVariantColumn = false;
              for (const name of currentTable.variantConstraints) {
                currentTable.constraintNamespace.delete(name);
              }
              currentTable.variantConstraints.clear();
              currentTable.activeChecks.clear();
              currentTable.activeFks.clear();
            }
            continue;
          }

          // Action D: RENAME [COLUMN] <old_col> TO <new_col>
          if (action[0].value === 'rename') {
            let cIdx = 1;
            if (action[cIdx]?.value === 'column') cIdx++;
            if (action[cIdx]?.value === 'variant' && action[cIdx + 1]?.value === 'to') {
              currentTable.hasVariantColumn = false;
              currentTable.variantConstraints.clear();
              currentTable.activeChecks.clear();
              currentTable.activeFks.clear();
            }
            continue;
          }

          // Action E: ADD [COLUMN] [IF NOT EXISTS] variant ...
          let colIdx = 0;
          if (action[colIdx]?.value === 'add') colIdx++;
          if (action[colIdx]?.value === 'column') colIdx++;
          let isColIfNotExists = false;
          if (action[colIdx]?.value === 'if' && action[colIdx + 1]?.value === 'not' && action[colIdx + 2]?.value === 'exists') {
            isColIfNotExists = true;
            colIdx += 3;
          }
          if (action[colIdx]?.value === 'variant') {
            if (currentTable.hasVariantColumn && isColIfNotExists) {
              continue;
            }
            currentTable.hasVariantColumn = true;
            scanColumnConstraints(action.slice(colIdx), file, currentTable.constraintNamespace, currentTable.variantConstraints, currentTable.activeChecks, currentTable.activeFks);
            continue;
          }

          // Action F: Table-level ADD [CONSTRAINT <name>] CHECK (variant IN (...)) or FOREIGN KEY
          let explicitName = null;
          let aIdx = 0;
          if (action[aIdx]?.value === 'add') aIdx++;
          if (action[aIdx]?.value === 'constraint') {
            explicitName = action[aIdx + 1]?.value ?? null;
            aIdx += 2;
          }

          let handled = false;

          // Search for table-level CHECK (variant ...)
          for (let i = 0; i < action.length; i++) {
            if (action[i].value === 'check' && action[i + 1]?.value === '(') {
              let depth = 1;
              let endIdx = i + 2;
              while (endIdx < action.length && depth > 0) {
                if (action[endIdx].value === '(') depth++;
                else if (action[endIdx].value === ')') depth--;
                endIdx++;
              }
              const checkTokens = action.slice(i + 2, endIdx - 1);
              const referencesVariant = checkTokens.some((t) => (t.type === 'word' || t.type === 'ident') && t.value === 'variant');
              if (referencesVariant) {
                const pIdx = i + 2;
                if (action[pIdx]?.value === 'variant' && action[pIdx + 1]?.value === 'in' && action[pIdx + 2]?.value === '(') {
                  let name = explicitName;
                  if (name === null && i >= 2 && action[i - 2]?.value === 'constraint') {
                    name = action[i - 1]?.value ?? null;
                  }
                  const parsedIn = parseStrictVariantInList(action, pIdx + 3);
                  if (parsedIn === null) {
                    throw new Error(
                      `${file} defines an unsupported CHECK predicate shape on \`studies.variant\` ` +
                        `(\`${action.map((t) => t.raw).join(' ')}\`). Teach this guard non-standard CHECK predicates ` +
                        `rather than ignoring the constraint.`,
                    );
                  }
                  if (action[parsedIn.nextIndex]?.value !== ')') {
                    throw new Error(
                      `${file} defines a compound or non-standard CHECK predicate on \`studies.variant\` ` +
                        `(\`${action.map((t) => t.raw).join(' ')}\`). Teach this guard compound CHECK predicates ` +
                        `rather than ignoring suffix expressions.`,
                    );
                  }
                  const assignedName = name ?? nextImplicitConstraintName(currentTable.constraintNamespace, 'studies_variant_check');
                  currentTable.constraintNamespace.add(assignedName);
                  currentTable.variantConstraints.add(assignedName);
                  currentTable.activeChecks.set(assignedName, { file, name: assignedName, variants: parsedIn.variants });
                  handled = true;
                } else {
                  throw new Error(
                    `${file} defines an unsupported CHECK predicate shape on \`studies.variant\` ` +
                      `(\`${action.map((t) => t.raw).join(' ')}\`). Teach this guard non-standard CHECK predicates ` +
                      `rather than ignoring the constraint.`,
                  );
                }
              }
            }
          }

          // Search for table-level FOREIGN KEY (variant) REFERENCES [public.]variants(code)
          const fkIdx = action.findIndex((t) => t.value === 'foreign');
          if (
            fkIdx !== -1 &&
            action[fkIdx + 1]?.value === 'key' &&
            action[fkIdx + 2]?.value === '(' &&
            action[fkIdx + 3]?.value === 'variant' &&
            action[fkIdx + 4]?.value === ')'
          ) {
            let rIdx = fkIdx + 5;
            if (action[rIdx]?.value === 'references') {
              const refTarget = parseQualifiedTableTarget(action, rIdx + 1);
              if (refTarget && isTableTarget(refTarget, 'variants')) {
                const afterRef = refTarget.nextIndex;
                if (action[afterRef]?.value === '(' && action[afterRef + 1]?.value === 'code' && action[afterRef + 2]?.value === ')') {
                  const name = explicitName ?? nextImplicitConstraintName(currentTable.constraintNamespace, 'studies_variant_fkey');
                  currentTable.constraintNamespace.add(name);
                  currentTable.variantConstraints.add(name);
                  currentTable.activeFks.add(name);
                  handled = true;
                }
              }
            }
          }

          if (handled) continue;

          // Register any other explicitly named constraint
          if (explicitName !== null) {
            currentTable.constraintNamespace.add(explicitName);
          }
        }
        continue;
      }

      // -----------------------------------------------------------------------
      // 3. CREATE TABLE [IF NOT EXISTS] target (...)
      // -----------------------------------------------------------------------
      if (stmt[0].value === 'create' && stmt[1].value === 'table') {
        let idx = 2;
        let isTableIfNotExists = false;
        if (stmt[idx]?.value === 'if' && stmt[idx + 1]?.value === 'not' && stmt[idx + 2]?.value === 'exists') {
          isTableIfNotExists = true;
          idx += 3;
        }
        const ref = parseQualifiedTableTarget(stmt, idx);
        if (ref === null) {
          continue;
        }

        const key = tableKey(ref);
        if (key !== STUDIES_TABLE_KEY && !tables.has(key)) {
          continue;
        }

        if (tables.has(key) && isTableIfNotExists) {
          continue;
        }

        const currentTable = {
          hasVariantColumn: false,
          constraintNamespace: new Set(),
          variantConstraints: new Set(),
          activeChecks: new Map(),
          activeFks: new Set(),
        };
        tables.set(key, currentTable);

        const openParen = stmt.findIndex((t) => t.type === 'punct' && t.value === '(');
        if (openParen === -1) continue;

        const bodyTokens = stmt.slice(openParen + 1);
        const clauses = splitAlterActions(bodyTokens);

        for (const clause of clauses) {
          if (clause.length === 0) continue;

          // Column-level: variant <TYPE> ...
          if (clause[0]?.value === 'variant') {
            currentTable.hasVariantColumn = true;
            scanColumnConstraints(clause, file, currentTable.constraintNamespace, currentTable.variantConstraints, currentTable.activeChecks, currentTable.activeFks);
            continue;
          }

          let explicitName = null;
          let cIdx = 0;
          if (clause[cIdx]?.value === 'constraint') {
            explicitName = clause[cIdx + 1]?.value ?? null;
            cIdx += 2;
          }

          let handled = false;

          // Table-level CHECK (variant ...)
          for (let i = 0; i < clause.length; i++) {
            if (clause[i].value === 'check' && clause[i + 1]?.value === '(') {
              let depth = 1;
              let endIdx = i + 2;
              while (endIdx < clause.length && depth > 0) {
                if (clause[endIdx].value === '(') depth++;
                else if (clause[endIdx].value === ')') depth--;
                endIdx++;
              }
              const checkTokens = clause.slice(i + 2, endIdx - 1);
              const referencesVariant = checkTokens.some((t) => (t.type === 'word' || t.type === 'ident') && t.value === 'variant');
              if (referencesVariant) {
                const pIdx = i + 2;
                if (clause[pIdx]?.value === 'variant' && clause[pIdx + 1]?.value === 'in' && clause[pIdx + 2]?.value === '(') {
                  let name = explicitName;
                  if (name === null && i >= 2 && clause[i - 2]?.value === 'constraint') {
                    name = clause[i - 1]?.value ?? null;
                  }
                  const parsedIn = parseStrictVariantInList(clause, pIdx + 3);
                  if (parsedIn === null) {
                    throw new Error(
                      `${file} defines an unsupported CHECK predicate shape on \`studies.variant\` ` +
                        `(\`${clause.map((t) => t.raw).join(' ')}\`). Teach this guard non-standard CHECK predicates ` +
                        `rather than ignoring the constraint.`,
                    );
                  }
                  if (clause[parsedIn.nextIndex]?.value !== ')') {
                    throw new Error(
                      `${file} defines a compound or non-standard CHECK predicate on \`studies.variant\` ` +
                        `(\`${clause.map((t) => t.raw).join(' ')}\`). Teach this guard compound CHECK predicates ` +
                        `rather than ignoring suffix expressions.`,
                    );
                  }
                  const assignedName = name ?? nextImplicitConstraintName(currentTable.constraintNamespace, 'studies_variant_check');
                  currentTable.constraintNamespace.add(assignedName);
                  currentTable.variantConstraints.add(assignedName);
                  currentTable.activeChecks.set(assignedName, { file, name: assignedName, variants: parsedIn.variants });
                  handled = true;
                } else {
                  throw new Error(
                    `${file} defines an unsupported CHECK predicate shape on \`studies.variant\` ` +
                      `(\`${clause.map((t) => t.raw).join(' ')}\`). Teach this guard non-standard CHECK predicates ` +
                      `rather than ignoring the constraint.`,
                  );
                }
              }
            }
          }

          // Table-level FOREIGN KEY (variant) REFERENCES [public.]variants(code)
          const fkIdx = clause.findIndex((t) => t.value === 'foreign');
          if (
            fkIdx !== -1 &&
            clause[fkIdx + 1]?.value === 'key' &&
            clause[fkIdx + 2]?.value === '(' &&
            clause[fkIdx + 3]?.value === 'variant' &&
            clause[fkIdx + 4]?.value === ')'
          ) {
            let rIdx = fkIdx + 5;
            if (clause[rIdx]?.value === 'references') {
              const refTarget = parseQualifiedTableTarget(clause, rIdx + 1);
              if (refTarget && isTableTarget(refTarget, 'variants')) {
                const afterRef = refTarget.nextIndex;
                if (clause[afterRef]?.value === '(' && clause[afterRef + 1]?.value === 'code' && clause[afterRef + 2]?.value === ')') {
                  const name = explicitName ?? nextImplicitConstraintName(currentTable.constraintNamespace, 'studies_variant_fkey');
                  currentTable.constraintNamespace.add(name);
                  currentTable.variantConstraints.add(name);
                  currentTable.activeFks.add(name);
                  handled = true;
                }
              }
            }
          }

          if (handled) continue;

          if (explicitName !== null) {
            currentTable.constraintNamespace.add(explicitName);
          }
        }
      }
    }
  }

  const studiesTable = tables.get(STUDIES_TABLE_KEY);
  if (!studiesTable) {
    return {
      check: null,
      checks: [],
      hasForeignKey: false,
    };
  }

  let latestCheck = null;
  for (const item of studiesTable.activeChecks.values()) {
    latestCheck = item;
  }

  return {
    check: latestCheck,
    checks: Array.from(studiesTable.activeChecks.values()),
    hasForeignKey: studiesTable.activeFks.size > 0,
  };
}

/**
 * Replays all migrations to compute the effective CHECK constraint governing `studies.variant`.
 *
 * @param {string} [dir=MIGRATIONS_DIR] Path to the migrations directory.
 * @returns {{ file: string, name: string, variants: string[] } | null} The active CHECK constraint or null if none exists.
 */
export function effectiveStudyVariantConstraint(dir = MIGRATIONS_DIR) {
  return replayStudiesSchema(dir).check;
}

/**
 * Replays all migrations to determine whether `studies.variant` has an active foreign key
 * referencing `variants(code)`.
 *
 * @param {string} dir The migrations directory to replay.
 * @returns {boolean} Whether studies.variant has an active foreign key referencing variants(code).
 */
export function effectiveStudyVariantForeignKey(dir = MIGRATIONS_DIR) {
  return replayStudiesSchema(dir).hasForeignKey;
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
  const replayed = replayStudiesSchema(dir);
  for (const checkItem of replayed.checks) {
    mirrors.push({
      label: `\`studies.variant\` CHECK constraint (${checkItem.name}), after all migrations`,
      file: join(dir, checkItem.file),
      variants: checkItem.variants,
    });
  }
  return { mirrors, studyConstraint: replayed.check, hasStudyVariantFk: replayed.hasForeignKey };
}

/**
 * Evaluates variant parity across TypeScript mirrors and SQL migrations.
 *
 * @param {string} [dir=MIGRATIONS_DIR] Path to the migrations directory.
 * @returns {{
 *   failures: string[],
 *   mirrors: Array<{ label: string, file: string, variants: string[] }>,
 *   studyConstraint: { file: string, name: string, variants: string[] } | null,
 *   hasStudyVariantFk: boolean
 * }} Parity evaluation results and any failure descriptions.
 */
export function evaluateParity(dir = MIGRATIONS_DIR) {
  const root = extractRegion(ROOT);
  const { mirrors, studyConstraint, hasStudyVariantFk } = collectMirrors(dir);
  const failures = [];

  for (const mirror of mirrors) {
    const problems = disagreements(root.variants, mirror.variants);
    if (problems.length > 0) {
      failures.push(`${mirror.label} (${mirror.file}): ${problems.join('; ')}`);
    }
  }

  if (studyConstraint === null && !hasStudyVariantFk) {
    failures.push('`studies.variant` has no CHECK constraint and no foreign key referencing `variants(code)`');
  }

  return { failures, mirrors, studyConstraint, hasStudyVariantFk };
}

function main() {
  const root = extractRegion(ROOT);
  const { failures, mirrors, studyConstraint, hasStudyVariantFk } = evaluateParity();

  console.log(`root: ${root.label} (${root.file})`);
  console.log(`      ${root.variants.join(', ')}\n`);

  for (const mirror of mirrors) {
    const problems = disagreements(root.variants, mirror.variants);
    if (problems.length === 0) {
      console.log(`  ok    ${mirror.label}`);
    } else {
      console.log(`  FAIL  ${mirror.label} (${mirror.file}): ${problems.join('; ')}`);
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

