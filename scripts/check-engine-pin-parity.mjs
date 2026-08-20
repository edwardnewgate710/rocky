#!/usr/bin/env node
/**
 * Fails when the pinned Stockfish artefact stops being the same one in every place that names it.
 *
 * The engine is pinned in four files now: the CI workflow that proves the engine boundary, the two
 * production Dockerfiles that ship it, and the ADR that records the decision. Nothing derives from
 * anything else, so they agree only for as long as somebody keeps them agreeing.
 *
 * The failure this exists for is not a typo. It is a partial upgrade — someone moves CI to a newer
 * release, the images keep the old one, and production silently runs an engine no test exercises.
 * That is exactly the state M15 Increment 12 found and fixed: CI on Stockfish 16, production on
 * whatever Debian bookworm resolved (`stockfish 15.1-4`). A digest that matches in three files and
 * not the fourth is the same defect wearing a smaller hat.
 *
 * Checks, across every location below:
 *   1. the release tag is the same;
 *   2. the artefact filename is the same, where the location names one;
 *   3. the SHA-256 is the same.
 *
 * A location whose pin cannot be found at all is a hard failure, never a skip — a guard that stops
 * looking after a refactor keeps printing green while the thing it guarded rots.
 *
 * Deliberately narrow. This is four files and one artefact, not a dependency-pinning framework.
 * Fairy-Stockfish is pinned in the CI workflow and ADR-0120 but ships in no image (it is not
 * deployed — see ADR-0121), so it is not covered here; adding it would mean adding a second artefact
 * to this shape, which is a change to make when Fairy is actually deployed, not before.
 *
 * Run: node scripts/check-engine-pin-parity.mjs
 */
import { readFileSync } from 'node:fs';

/** Everywhere the Stockfish pin is written down. */
export const PIN_LOCATIONS = [
  { label: 'CI workflow', file: '.github/workflows/ci.yml' },
  { label: 'API image', file: 'Dockerfile.api' },
  { label: 'gateway image', file: 'Dockerfile.gateway' },
  {
    label: 'ADR-0121',
    file: 'docs/adr/0121-deterministic-engine-install-in-ci.md',
    // Scoped to the Decision table row, which carries release, asset and digest together.
    //
    // An ADR accumulates history: this one already names `sf_16` five times, and an upgrade to
    // `sf_17` would rightly add the new release while leaving every sentence about the old one in
    // place. Reading the whole file would then see two releases and refuse a correct change — a
    // guard that blocks the upgrade it exists to keep consistent. The table row is the one place
    // that states the *current* pin, so it is the only place read. Raised in the Qodo review of
    // PR #143.
    //
    // Every matching row is read, not the first: an upgrade that adds a row while leaving the old
    // one above it is precisely the drift this guard exists for, and taking the first match would
    // read the superseded pin and call the file consistent. Raised in the CodeRabbit review of
    // PR #143.
    scope: /^\|\s*`sf_[^\n]*`\s*\|\s*$/m,
  },
];

/** The release tag, as it appears in a download URL or as a bare `sf_NN` in prose. */
const RELEASE = /\bsf_(\d+(?:\.\d+)?)\b/g;
/** The asset filename, wherever it is named. */
const ASSET = /\bstockfish-ubuntu-x86-64(?:-[a-z0-9]+)?\.tar\b/g;
/** A SHA-256, anywhere. */
const DIGEST = /\b[0-9a-f]{64}\b/g;

/**
 * What marks a line as carrying *this* artefact's digest.
 *
 * Scoped to the line, because these files legitimately hold more than one digest and picking the
 * wrong one would be worse than picking none. `ci.yml` also pins Fairy-Stockfish; ADR-0121 also
 * records the extracted binary's digest a few lines under the archive's. Requiring the line itself
 * to name the archive — as `STOCKFISH_SHA256`, as `/tmp/stockfish.tar`, or as the asset filename in
 * the ADR's table — separates them without depending on how far apart they happen to sit.
 */
const STOCKFISH_DIGEST_LINE = /STOCKFISH_SHA256|stockfish[^\s"]*\.tar/i;

/** Every distinct match of `pattern` in `text`. */
function findAll(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((m) => m[0]))];
}

/** Digests on lines that identify themselves as this artefact's. */
function findStockfishDigests(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    if (!STOCKFISH_DIGEST_LINE.test(line)) continue;
    found.push(...findAll(line, DIGEST));
  }
  return [...new Set(found)];
}

/**
 * The pin one file declares.
 *
 * Each field must be present and unambiguous. Two different digests in one file is as much a
 * disagreement as two files differing, and reporting only the first would hide a half-finished edit
 * — which is the most likely way this actually breaks.
 *
 * `scope` narrows *where* in the file the pin is read from; it never narrows it down to one match.
 * All matching regions are read together, so a scoped location is held to the same standard as an
 * unscoped one: ambiguity fails loudly instead of resolving to whichever match came first.
 */
export function readPin({ label, file, text, scope }) {
  const whole = text ?? readFileSync(file, 'utf8');
  let source = whole;
  if (scope !== undefined) {
    const everyRegion = new RegExp(scope.source, scope.flags.includes('g') ? scope.flags : `${scope.flags}g`);
    const regions = [...whole.matchAll(everyRegion)].map((match) => match[0]);
    if (regions.length === 0) {
      throw new Error(
        `${label} (${file}) no longer contains the region this guard reads its pin from. ` +
          'Point `scope` at wherever the current pin now lives, rather than letting the guard read the whole file and mistake a historical mention for the active one.',
      );
    }
    source = regions.join('\n');
  }
  const releases = findAll(source, RELEASE);
  const assets = findAll(source, ASSET);
  const digests = findStockfishDigests(source);

  const problems = [];
  if (releases.length === 0) problems.push('names no Stockfish release');
  if (releases.length > 1) problems.push(`names ${releases.length} releases (${releases.join(', ')})`);
  if (digests.length === 0) problems.push('names no Stockfish archive SHA-256');
  if (digests.length > 1) problems.push(`names ${digests.length} conflicting digests`);
  // The asset filename is optional: the ADR states it in a table, the workflow and Dockerfiles carry
  // it inside the URL. A location that never names one is not wrong, only less specific.
  if (assets.length > 1) problems.push(`names ${assets.length} assets (${assets.join(', ')})`);

  if (problems.length > 0) {
    throw new Error(
      `${label} (${file}) ${problems.join('; ')}. Fix the file, or teach this guard the new shape — ` +
        'do not let it fall back to checking nothing.',
    );
  }

  return { label, file, release: releases[0], asset: assets[0] ?? null, digest: digests[0] };
}

/** Which fields disagree between two pins. */
export function comparePins(reference, other) {
  const differences = [];
  if (other.release !== reference.release) {
    differences.push(`release \`${other.release}\` vs \`${reference.release}\``);
  }
  if (other.digest !== reference.digest) {
    differences.push(`digest \`${other.digest.slice(0, 12)}…\` vs \`${reference.digest.slice(0, 12)}…\``);
  }
  if (other.asset !== null && reference.asset !== null && other.asset !== reference.asset) {
    differences.push(`asset \`${other.asset}\` vs \`${reference.asset}\``);
  }
  return differences;
}

function main() {
  const pins = PIN_LOCATIONS.map(readPin);
  const reference = pins[0];
  const failures = [];

  console.log(`reference: ${reference.label} (${reference.file})`);
  console.log(`           release ${reference.release}, asset ${reference.asset ?? '(not named)'}`);
  console.log(`           sha256 ${reference.digest}\n`);

  for (const pin of pins.slice(1)) {
    const differences = comparePins(reference, pin);
    if (differences.length === 0) {
      console.log(`  ok    ${pin.label}`);
    } else {
      console.log(`  FAIL  ${pin.label} (${pin.file}): ${differences.join('; ')}`);
      failures.push(pin.label);
    }
  }

  if (failures.length > 0) {
    console.log(
      `\nThe Stockfish pin disagrees with ${reference.label} in ${failures.length} place(s).\n` +
        'All four must move together: a release upgraded in CI but not in the images means production\n' +
        'runs an engine no test exercises, which is the defect ADR-0121 and Increment 12 closed.',
    );
    process.exit(1);
  }

  console.log(`\nAll ${pins.length} locations pin the same Stockfish artefact.`);
}

// Run as a command, stay quiet when imported by the tests.
if (process.argv[1] !== undefined && import.meta.url.endsWith('check-engine-pin-parity.mjs')) {
  const invokedDirectly = process.argv[1].replace(/\\/g, '/').endsWith('check-engine-pin-parity.mjs');
  if (invokedDirectly) {
    try {
      main();
    } catch (err) {
      console.error(`engine pin parity check could not run: ${err.message}`);
      process.exit(1);
    }
  }
}
