#!/usr/bin/env node
/**
 * Bounded reproduction pass for the Signature B failure (ADR-0140 §4): a `packages/api` test-file
 * subprocess that dies with a bare `'test failed'`, no assertion, no stack, and none of its own
 * tests reported.
 *
 * Every run is instrumented on both sides of the process boundary at once:
 *
 * - **Child side** — `signature-b-preload.cjs` is `--require`d into each per-file child and records
 *   which JS lifecycle path, if any, the child took before dying.
 * - **Parent side** — the built-in `tap` reporter writes to a file while `spec` keeps stdout. That
 *   pairing is the point: Node's runner attaches the child's `exitCode` and `signal` to the error it
 *   throws, `spec` discards them (its `formatError` replaces the error with `error.cause`, the bare
 *   string `'test failed'`), and `tap` serializes them into its YAML block. Running both recovers
 *   the exit status without a custom reporter, without patching Node internals, and without changing
 *   what a human sees on stdout.
 *
 * The pass is **bounded by construction** and stops at the first capture. The wall-clock ceiling is
 * passed to each child as a `timeout`, so it binds a run that hangs rather than only the decision to
 * start another one. It never retries a failed file, never reruns the suite to get a green result,
 * and never lowers concurrency — those would hide the defect rather than explain it. A pass that
 * captures nothing proves nothing beyond "not observed in N runs", and the printed summary says so;
 * a pass containing a run whose report could not be read says it is inconclusive instead.
 *
 * Usage, from `packages/api` (compile first: `npx tsc -p tsconfig.test.json`):
 *
 *     node ./test/diagnostics/run-signature-b-pass.mjs [--runs 20] [--max-minutes 45] [--out <dir>]
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { freemem, tmpdir, totalmem } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '../..');
const { correlate, parseTapFailures, readChildLogs } = createRequire(import.meta.url)('./signature-b-correlate.cjs');

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

/**
 * The only stderr lines a dying child produces that name its own cause. Node prints these itself,
 * and they are what separates a V8 heap exhaustion from a JS `process.abort()` when both leave the
 * same exit code 134.
 */
const FATAL_MARKERS = [
  'FATAL ERROR:',
  'JavaScript heap out of memory',
  '<--- Last few GCs --->',
  '----- Native stack trace -----',
  '----- JavaScript stack trace -----',
];

/**
 * Record which fatal markers a run's stderr contained, and never the stderr itself.
 *
 * A whitelist rather than a redaction pass: the suite's own output can contain anything a test
 * chose to print, so matching known markers is the only way to be sure a token, request body or
 * connection string cannot reach the capture file. Presence is all the evidence is worth anyway —
 * the marker names the mechanism, the surrounding text does not.
 *
 * @param {string | undefined} stderr
 * @returns {string[]} markers present, in the order listed above
 */
function fatalMarkersIn(stderr) {
  const text = String(stderr ?? '');
  return FATAL_MARKERS.filter((marker) => text.includes(marker));
}

/**
 * A ceiling that does not describe a real experiment must stop the run, not shrink it.
 *
 * `--runs 0`, a negative value or a typo would otherwise execute nothing and still print that
 * Signature B was not observed — an empty experiment presented as a clean pass, which is the exact
 * dishonesty this whole diagnostic exists to avoid.
 *
 * @param {string} name
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(name, raw, fallback) {
  if (raw === fallback) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number; got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
}

const maxRuns = positiveNumber('runs', flag('runs', 20), 20);
const maxMs = positiveNumber('max-minutes', flag('max-minutes', 45), 45) * 60_000;
const outDir = flag('out', fs.mkdtempSync(path.join(tmpdir(), 'sigb-pass-')));

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
console.log(`Signature B bounded pass — ceiling ${maxRuns} runs or ${maxMs / 60_000} minutes, stopping at first capture.`);
console.log(`Artifacts: ${outDir}\n`);

const startedAt = Date.now();
const runs = [];
let capture = null;

for (let run = 1; run <= maxRuns; run++) {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= maxMs) {
    console.log(`ceiling reached: ${Math.round(elapsed / 1000)}s elapsed`);
    break;
  }

  const tapPath = path.join(outDir, `run${run}.tap`);
  const logDir = path.join(outDir, `child-logs-run${run}`);
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });

  const freeBefore = freemem();
  const startedRun = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      '--require', './test/diagnostics/signature-b-preload.cjs',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=tap', `--test-reporter-destination=${tapPath}`,
      '--test', '--test-concurrency=1', 'dist-test/test/**/*.test.js',
    ],
    {
      cwd: API_DIR,
      encoding: 'utf8',
      env: { ...process.env, SIGB_LOG_DIR: logDir },
      // `spec` goes straight to this terminal, which is the whole point of running it alongside
      // `tap`: the human-facing output must stay exactly what it would be without the diagnostic.
      // Only stderr is captured, and only to test it for known fatal markers.
      stdio: ['ignore', 'inherit', 'pipe'],
      // The ceiling has to bind a run that hangs, not merely the decision to start another one.
      timeout: Math.max(1, maxMs - elapsed),
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const durationMs = Date.now() - startedRun;

  // A run whose report cannot be read has not answered the question, and must not be filed next to
  // the runs that did. Reporting it as "zero captures" would let a broken pass look like a quiet one.
  let records = [];
  let collectionError = result.error ? `${result.error.name}: ${result.error.message}` : null;
  if (collectionError === null) {
    try {
      records = correlate(parseTapFailures(fs.readFileSync(tapPath, 'utf8')), readChildLogs(logDir));
    } catch (error) {
      collectionError = `${error.name}: ${error.message}`;
    }
  }

  const summary = {
    run,
    durationMs,
    runnerExitCode: result.status,
    timedOut: result.signal !== null && result.signal !== undefined,
    freeMemBeforeMb: Math.round(freeBefore / 1048576),
    freeMemAfterMb: Math.round(freemem() / 1048576),
    totalMemMb: Math.round(totalmem() / 1048576),
    captures: records.length,
    collectionError,
  };
  runs.push(summary);
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({ runs }, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `run ${run}: ${Math.round(durationMs / 1000)}s  runnerExit=${result.status}  ` +
      `captures=${records.length}  freeMb ${summary.freeMemBeforeMb}->${summary.freeMemAfterMb}` +
      (collectionError === null ? '' : `  COLLECTION FAILED: ${collectionError}`),
  );

  if (collectionError !== null) {
    console.error(`\nRun ${run} produced no readable diagnostic result. Stopping rather than reporting a clean pass.`);
    process.exitCode = 1;
    break;
  }

  if (records.length > 0) {
    capture = { run, records, fatalMarkers: fatalMarkersIn(result.stderr) };
    fs.writeFileSync(path.join(outDir, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
    console.log(`\nCAPTURED on run ${run}:\n${records.map((r) => JSON.stringify(r, null, 2)).join('\n')}`);
    break;
  }

  // A clean run's artifacts answer nothing and would otherwise grow without bound across the pass.
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(tapPath, { force: true });
}

const minutes = Math.round((Date.now() - startedAt) / 60_000);
const unreadable = runs.filter((entry) => entry.collectionError !== null).length;
const readable = runs.length - unreadable;
console.log(`\n${runs.length} run(s), ${minutes} minute(s), ${capture ? 1 : 0} capture(s), ${unreadable} unreadable.`);

// Only a pass that actually observed something may say the defect was not observed. Counting the
// runs that produced a readable report — rather than the runs that were started — covers an empty
// experiment and a wholly unreadable one with the same test, and neither is a clean result.
if (capture) {
  console.log('See capture.json. A single capture names a mechanism; it does not establish a cause.');
} else if (readable === 0) {
  console.error('No run produced a readable result, so this pass observed nothing. It is not a clean result.');
  process.exitCode = 1;
} else if (unreadable > 0) {
  console.log('This pass is inconclusive: at least one run produced no readable diagnostic result.');
} else {
  console.log('Signature B was not observed in this pass. That bounds its rate; it does not mean it is fixed.');
}
