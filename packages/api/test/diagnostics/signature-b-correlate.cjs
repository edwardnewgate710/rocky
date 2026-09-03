'use strict';
/**
 * Correlates the PARENT-side view of a Signature B failure with the CHILD-side view, which is the
 * observability boundary `docs/adr/0140-harness-ephemeral-port-acquisition.md` §4 stopped at.
 *
 * Signature B is a `packages/api` test-file subprocess dying with a bare `'test failed'`, no
 * assertion, no stack, and none of that file's own tests reported. The child-side preload
 * (`signature-b-preload.cjs`) established that on real captures no JS lifecycle hook fires at all —
 * not even Node's unconditional `exit` event — which rules out `process.exit`, uncaught exceptions
 * and fatal unhandled rejections, but cannot say how the process actually died.
 *
 * The parent knows. Node's runner already computes the child's exit status and attaches it to the
 * error it throws (`internal/test_runner/runner.js`):
 *
 *     err = ObjectAssign(new ERR_TEST_FAILURE('test failed', failureType), {
 *       __proto__: null, exitCode: code, signal: signal, stack: undefined });
 *
 * The default `spec` reporter then throws that away: `formatError` in
 * `internal/test_runner/reporter/utils.js` replaces the error with `error.cause`, which is the bare
 * string `'test failed'`, so every own property including `exitCode` is discarded before printing.
 * The built-in **TAP** reporter does not — `jsToYaml` walks the error's own enumerable properties
 * and skips only `cause` and `code` — so `exitCode` and `signal` survive into its YAML block. That
 * makes the exit status recoverable with no custom reporter and no patched internals, by running
 * `spec` to stdout and `tap` to a file at the same time. See `npm run test:diagnostics:signature-b`.
 *
 * This module joins the two sides on the test file path, which the preload records for every child,
 * and classifies the termination against exit codes verified on this platform (see
 * {@link classifyTermination}). It deliberately reports `inconclusive` rather than guessing: exit
 * code 1 has several possible causes and is not evidence of any one of them.
 *
 * Emits only enumerated fields — exit status, event kinds, PIDs, durations and test file paths.
 * It never copies an error message, a TAP diagnostic body, stderr, or any environment value, so no
 * token, request body or connection string can reach the output through it.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Records kept per correlation run, so a pathological TAP file cannot produce an unbounded report. */
const MAX_RECORDS = 200;

/**
 * Last path segment, treating both separators as separators whatever platform this runs on.
 *
 * `path.basename` uses only the host's separator, so on Linux it returns a Windows path unchanged
 * and the join silently finds nothing. Captures happen on the developer machine and may be read
 * anywhere, including CI, so the key cannot depend on where the analysis runs.
 *
 * @param {string} filePath
 * @returns {string}
 */
function fileKey(filePath) {
  const segments = String(filePath).split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

/**
 * How a child process terminated, keyed by the exit status the parent observed.
 *
 * Every code below was measured on this platform (Windows 11, Node v24.15.0) rather than assumed:
 * `process.abort()` and `process.exit(1)` by running them under the test runner and reading the TAP
 * block, and the external kills by spawning a sleeper and terminating it from outside. Windows has
 * no POSIX signals — `signal` is `null` for every external kill and native fault — so the exit code
 * is the only discriminator, and `1` does not discriminate at all.
 *
 * @type {ReadonlyArray<{ code: number, id: string, meaning: string, conclusive: boolean }>}
 */
const EXIT_CODE_TABLE = [
  { code: 134, id: 'native-abort-or-v8-fatal', conclusive: true,
    meaning: 'CRT/V8 abort(): a JS process.abort(), a V8 fatal error such as heap OOM, or a native assertion' },
  { code: 3221225477, id: 'native-access-violation', conclusive: true,
    meaning: 'STATUS_ACCESS_VIOLATION (0xC0000005): the process faulted on a bad memory access' },
  { code: 3221226505, id: 'native-fast-fail', conclusive: true,
    meaning: 'STATUS_STACK_BUFFER_OVERRUN (0xC0000409): __fastfail, raised by a security or consistency check' },
  { code: 3221225725, id: 'native-stack-overflow', conclusive: true,
    meaning: 'STATUS_STACK_OVERFLOW (0xC00000FD): the native stack was exhausted' },
  { code: 3221225540, id: 'job-object-quota', conclusive: true,
    meaning: 'STATUS_QUOTA_EXCEEDED (0xC0000044): a job object or quota limit terminated the process' },
  { code: 4294967295, id: 'external-terminate-process', conclusive: true,
    meaning: 'TerminateProcess with exit code -1, which is what PowerShell Stop-Process -Force produces' },
  { code: 1, id: 'inconclusive', conclusive: false,
    meaning: 'exit code 1 is produced by an uncaught exception, process.exit(1), taskkill /F and process.kill alike' },
];

/**
 * Classify a parent-observed child termination.
 *
 * A non-null `signal` establishes that the child died by signal and nothing more. Node's exit
 * contract names the signal that terminated the process, not the process that sent it, so an
 * external `SIGKILL`, a self-sent signal and a runner cancellation are indistinguishable here.
 * Naming a sender would be the same unsupported leap this module refuses to make for exit code 1.
 *
 * @param {{ exitCode: number | null, signal: string | null }} termination
 * @returns {{ id: string, meaning: string, conclusive: boolean }}
 */
function classifyTermination({ exitCode, signal }) {
  if (signal !== null && signal !== undefined) {
    return {
      id: 'signal-terminated',
      meaning: `the child was terminated by ${signal}; the exit contract names the signal, not its sender, so the runner, the OS and an external process are all still possible`,
      conclusive: false,
    };
  }
  const known = EXIT_CODE_TABLE.find((entry) => entry.code === exitCode);
  if (known) return { id: known.id, meaning: known.meaning, conclusive: known.conclusive };
  if (typeof exitCode === 'number' && exitCode >= 0xc0000000) {
    return {
      id: 'native-ntstatus',
      meaning: `exit code ${exitCode} (0x${exitCode.toString(16)}) is an NTSTATUS value, so the process was terminated by a native fault`,
      conclusive: true,
    };
  }
  return { id: 'unclassified', meaning: `exit code ${String(exitCode)} is not in the verified table`, conclusive: false };
}

/** JS lifecycle events whose absence proves the child never ran an exit path. */
const JS_EXIT_KINDS = ['process.exit', 'process.abort', 'uncaughtExceptionMonitor', 'exit', 'beforeExit'];

/**
 * State the strongest claim the combined evidence supports, and no stronger.
 *
 * The child-side log is what makes an otherwise ambiguous exit code informative: `process.exit(1)`
 * and an uncaught exception both log something and both fire Node's `exit` event, so a child that
 * reached `preload-installed` and then logged nothing at all cannot have died either way. What
 * remains — an external `TerminateProcess`, or a native path that bypasses JS entirely — is a
 * narrowing, not an identification, and this returns it as such.
 *
 * @param {{ id: string, conclusive: boolean }} classification
 * @param {readonly string[]} childKinds Event kinds the child logged, in order.
 * @returns {{ narrowed: boolean, statement: string }}
 */
function narrowFromChildEvidence(classification, childKinds) {
  const reachedPreload = childKinds.includes('preload-installed');
  const ranAnyExitPath = JS_EXIT_KINDS.some((kind) => childKinds.includes(kind));

  if (!reachedPreload) {
    return { narrowed: false, statement: 'the child never recorded preload-installed, so nothing is known about its JS lifecycle' };
  }
  if (ranAnyExitPath) {
    return { narrowed: false, statement: 'the child ran a JS exit path, so its own log identifies the cause and the exit code only corroborates it' };
  }
  if (classification.conclusive) {
    return { narrowed: true, statement: `the child ran no JS exit path, and the exit code identifies the termination as ${classification.id}` };
  }
  return {
    narrowed: true,
    statement:
      'the child reached preload-installed and then ran no JS exit path at all, which excludes process.exit and an uncaught exception; ' +
      'an external TerminateProcess or a native path that bypasses JS remains, and the exit code alone does not choose between them',
  };
}

/**
 * Extract the file-level failures Node reports as its own bare fallback from a TAP report.
 *
 * Both conditions are required, and the second is the one that matters. Node writes
 * `error: 'test failed'` for *any* file whose child exited non-zero, so a file containing an
 * ordinary failing assertion carries it too — with `failureType: 'subtestsFailed'`, because the
 * runner saw a subtest fail (`kSubtestsFailed`). Signature B is the other branch: no subtest
 * failed, so the runner falls back to `kTestCodeFailure`. Matching on the message alone would
 * report every ordinary regression as a capture and halt the pass on a false positive.
 *
 * @param {string} tapText
 * @returns {Array<{ file: string, exitCode: number | null, signal: string | null, failureType: string | null, durationMs: number | null }>}
 */
function parseTapFailures(tapText) {
  const blocks = String(tapText).matchAll(/^not ok \d+ - (.+?)$\r?\n\s*---\r?\n([\s\S]*?)^\s*\.\.\.$/gm);
  const out = [];
  for (const [, rawName, body] of blocks) {
    if (!/^\s*error: 'test failed'\s*$/m.test(body)) continue;
    if (!/^\s*failureType: 'testCodeFailure'\s*$/m.test(body)) continue;
    if (out.length >= MAX_RECORDS) break;
    const scalar = (key) => {
      const found = new RegExp(`^\\s*${key}: (.+)$`, 'm').exec(body);
      return found ? found[1].trim() : null;
    };
    const exit = scalar('exitCode');
    const sig = scalar('signal');
    const dur = scalar('duration_ms');
    out.push({
      file: rawName.trim().replace(/\\\\/g, '\\'),
      exitCode: exit === null || exit === '~' ? null : Number(exit),
      signal: sig === null || sig === '~' ? null : sig.replace(/^'|'$/g, ''),
      failureType: scalar('failureType')?.replace(/^'|'$/g, '') ?? null,
      durationMs: dur === null ? null : Number(dur),
    });
  }
  return out;
}

/**
 * Read every child log the preload wrote, keyed by the test file each child was running.
 *
 * The preload records `testFile` on every line for children (it is `null` for the parent runner,
 * which has no `NODE_TEST_CONTEXT`), so the join key is the file path and the PID comes with it.
 * Malformed lines are skipped rather than throwing: a child killed mid-write can leave a partial
 * final line, and losing that line must not lose the rest of the record.
 *
 * @param {string} logDir
 * @returns {Map<string, { pid: number | null, kinds: string[] }>} keyed by test file basename
 */
function readChildLogs(logDir) {
  const byFile = new Map();
  let entries;
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return byFile;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(logDir, entry), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record.testFile !== 'string' || record.testFile === '') continue;
      const key = fileKey(record.testFile);
      const existing = byFile.get(key) ?? { pid: null, kinds: [] };
      existing.pid = typeof record.pid === 'number' ? record.pid : existing.pid;
      if (typeof record.kind === 'string') existing.kinds.push(record.kind);
      byFile.set(key, existing);
    }
  }
  return byFile;
}

/**
 * Join parent-observed failures to child-observed lifecycle evidence, one record per failure.
 *
 * Matching is by file basename because the parent names the file as the runner received it while
 * the child records its own resolved `argv[1]`. Basenames are unique across the suite's compiled
 * output; a failure with no matching child log is reported with `childLogFound: false` rather than
 * being dropped, because "the child never wrote a log" is itself evidence.
 *
 * @param {ReturnType<typeof parseTapFailures>} failures
 * @param {ReturnType<typeof readChildLogs>} childLogs
 * @returns {Array<object>}
 */
function correlate(failures, childLogs) {
  return failures.map((failure) => {
    const child = childLogs.get(fileKey(failure.file)) ?? null;
    const kinds = child?.kinds ?? [];
    const classification = classifyTermination(failure);
    const narrowing = narrowFromChildEvidence(classification, kinds);
    return {
      file: failure.file,
      parent: {
        exitCode: failure.exitCode,
        signal: failure.signal,
        failureType: failure.failureType,
        durationMs: failure.durationMs,
      },
      child: {
        logFound: child !== null,
        pid: child?.pid ?? null,
        kinds,
      },
      classification: classification.id,
      meaning: classification.meaning,
      conclusive: classification.conclusive,
      narrowed: narrowing.narrowed,
      statement: narrowing.statement,
    };
  });
}

module.exports = {
  EXIT_CODE_TABLE,
  MAX_RECORDS,
  classifyTermination,
  correlate,
  narrowFromChildEvidence,
  parseTapFailures,
  readChildLogs,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : args[at + 1] ?? null;
  };
  const tapPath = valueOf('--tap');
  const logDir = valueOf('--child-logs');
  if (tapPath === null || logDir === null) {
    process.stderr.write('usage: signature-b-correlate.cjs --tap <report.tap> --child-logs <dir>\n');
    process.exitCode = 2;
  } else {
    const records = correlate(parseTapFailures(fs.readFileSync(tapPath, 'utf8')), readChildLogs(logDir));
    for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
    if (records.length === 0) process.stderr.write('no Signature B failures in this report\n');
  }
}
