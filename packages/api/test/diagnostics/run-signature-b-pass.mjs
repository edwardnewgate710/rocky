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
 * The pass is **bounded by construction** and stops at the first capture. It never retries a failed
 * file, never reruns the suite to get a green result, and never lowers concurrency — those would
 * hide the defect rather than explain it. A pass that captures nothing proves nothing beyond "not
 * observed in N runs", and the printed summary says so.
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

const maxRuns = Number(flag('runs', 20));
const maxMs = Number(flag('max-minutes', 45)) * 60_000;
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
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const durationMs = Date.now() - startedRun;

  let records = [];
  try {
    records = correlate(parseTapFailures(fs.readFileSync(tapPath, 'utf8')), readChildLogs(logDir));
  } catch {
    /* a run that produced no readable report is recorded below as zero captures */
  }

  const summary = {
    run,
    durationMs,
    runnerExitCode: result.status,
    freeMemBeforeMb: Math.round(freeBefore / 1048576),
    freeMemAfterMb: Math.round(freemem() / 1048576),
    totalMemMb: Math.round(totalmem() / 1048576),
    captures: records.length,
  };
  runs.push(summary);
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({ runs }, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `run ${run}: ${Math.round(durationMs / 1000)}s  runnerExit=${result.status}  ` +
      `captures=${records.length}  freeMb ${summary.freeMemBeforeMb}->${summary.freeMemAfterMb}`,
  );

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
console.log(`\n${runs.length} run(s), ${minutes} minute(s), ${capture ? 1 : 0} capture(s).`);
if (!capture) {
  console.log('Signature B was not observed in this pass. That bounds its rate; it does not mean it is fixed.');
}
process.exitCode = 0;
