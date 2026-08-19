/**
 * Nothing outside the codec may read a FEN's clocks by fixed index.
 *
 * Three-Check now carries a counter field in position five, so `split(' ')[4]` is the halfmove
 * clock for seven variants and the check counters for the eighth. Code that indexes it directly is
 * right most of the time and wrong for exactly one variant — the failure mode that is hardest to
 * notice, because standard chess keeps working.
 *
 * Fields 0-3 are unaffected by the insertion and are left alone deliberately: normalising the
 * en-passant square or reading the side to move by index is fine and widespread. This guard is only
 * about the fields that moved.
 *
 * The allowlist is the audit. Adding an entry is a decision someone has to make in review, which is
 * the point — the alternative is a silent index that only misbehaves in Three-Check.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Repo root, from `packages/chess-core`. */
const ROOT = join(process.cwd(), '..', '..');
const PACKAGES = join(ROOT, 'packages');

/**
 * Known readers of a FEN field at index 4 or 5, each checked by hand.
 *
 * - `chess-core/src/fen.ts` is the codec itself; it reads the clocks through the layout it just
 *   determined, which is the whole point of this change.
 * - `web/src/app/studies-helpers.ts` reads `[5]` for a study's fullmove number. Studies have no
 *   variant column and are parsed as standard everywhere, so a Three-Check FEN cannot reach it.
 *   Left as it is rather than refactored: it is correct for every input it can actually receive.
 */
const ALLOWED = new Set(['chess-core/src/fen.ts', 'web/src/app/studies-helpers.ts']);

/** `parts[4]`, `fields[5]`, `.split(' ')[4]` — any fixed read of the two fields that moved. */
const INDEXED_FIELD = /\[\s*[45]\s*\]/;
/** Only lines that are plausibly about a FEN at all, to keep the scan honest rather than noisy. */
const FEN_CONTEXT = /fen/i;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-test') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

test('no source file reads a FEN clock field by fixed index without being on the audit list', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(PACKAGES)) {
    const rel = relative(PACKAGES, file).split(sep).join('/');
    // Tests are excluded: they build FENs deliberately and assert on their fields, which is what
    // the tests in this very directory do.
    if (rel.includes('/test/') || rel.endsWith('.test.ts')) continue;
    if (ALLOWED.has(rel)) continue;

    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
      if (INDEXED_FIELD.test(line) && FEN_CONTEXT.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'a FEN clock field read by index is correct for seven variants and wrong for Three-Check; ' +
      'use the parser, or add the file to the audit list with a reason',
  );
});

test('the audit list names only files that still exist and still index a field', () => {
  // An allowlist that outlives its entries stops being an audit and starts being a blindfold.
  for (const rel of ALLOWED) {
    const full = join(PACKAGES, rel);
    const text = readFileSync(full, 'utf8');
    assert.ok(
      INDEXED_FIELD.test(text),
      `${rel} no longer indexes field 4 or 5 — remove it from the audit list`,
    );
  }
});
