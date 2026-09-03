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
 * A path with both separators normalised to `/`, so a capture taken on one platform can be read on
 * another. `path.basename` and `path.normalize` use only the host's separator, so on Linux they
 * return a Windows path unchanged and every comparison against it silently fails.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizePath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Last path segment, platform-independently.
 *
 * @param {string} filePath
 * @returns {string}
 */
function fileKey(filePath) {
  const segments = normalizePath(filePath).split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * What an observed exit status *suggests*, keyed by the status the parent saw.
 *
 * Every code below was measured on this platform (Windows 11, Node v24.15.0) rather than assumed:
 * `process.abort()` and `process.exit(1)` by running them under the test runner and reading the TAP
 * block, and the external kills by spawning a sleeper and terminating it from outside. Windows has
 * no POSIX signals — `signal` is `null` for every external kill and native fault — so the exit code
 * is the only discriminator, and `1` does not discriminate at all.
 *
 * `specific` says whether the status names a *particular* mechanism, not whether that mechanism is
 * proven. Nothing here is proof: an exit status is a 32-bit integer the terminating party chooses,
 * and any process can exit with 134 or with a value in the NTSTATUS range without a native fault
 * having occurred. `TerminateProcess(h, 0xC0000005)` produces the same number as a real access
 * violation. Corroboration has to come from outside the number — see {@link narrowFromChildEvidence}.
 *
 * @type {ReadonlyArray<{ code: number, id: string, meaning: string, specific: boolean }>}
 */
const EXIT_CODE_TABLE = [
  { code: 134, id: 'native-abort-or-v8-fatal', specific: true,
    meaning: 'candidate: CRT/V8 abort(), a V8 fatal error such as heap OOM, or a native assertion; any process can also exit 134 deliberately' },
  { code: 3221225477, id: 'native-access-violation', specific: true,
    meaning: 'candidate: STATUS_ACCESS_VIOLATION (0xC0000005); an external TerminateProcess may pass the same value' },
  { code: 3221226505, id: 'native-fast-fail', specific: true,
    meaning: 'candidate: STATUS_STACK_BUFFER_OVERRUN (0xC0000409), __fastfail; an external kill may pass the same value' },
  { code: 3221225725, id: 'native-stack-overflow', specific: true,
    meaning: 'candidate: STATUS_STACK_OVERFLOW (0xC00000FD); an external kill may pass the same value' },
  { code: 3221225540, id: 'job-object-quota', specific: true,
    meaning: 'candidate: STATUS_QUOTA_EXCEEDED (0xC0000044), a job object or quota limit; an external kill may pass the same value' },
  { code: 4294967295, id: 'external-terminate-process', specific: true,
    meaning: 'candidate: TerminateProcess with exit code -1, which is what PowerShell Stop-Process -Force produces' },
  { code: 1, id: 'inconclusive', specific: false,
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
 * @returns {{ id: string, meaning: string, specific: boolean }}
 */
function classifyTermination({ exitCode, signal }) {
  if (signal !== null && signal !== undefined) {
    return {
      id: 'signal-terminated',
      meaning: `the child was terminated by ${signal}; the exit contract names the signal, not its sender, so the runner, the OS and an external process are all still possible`,
      specific: false,
    };
  }
  const known = EXIT_CODE_TABLE.find((entry) => entry.code === exitCode);
  if (known) return { id: known.id, meaning: known.meaning, specific: known.specific };
  if (typeof exitCode === 'number' && exitCode >= 0xc0000000) {
    return {
      id: 'native-ntstatus',
      meaning: `candidate: exit code ${exitCode} (0x${exitCode.toString(16)}) lies in the NTSTATUS range, which a native fault produces — and which an external TerminateProcess can also pass deliberately`,
      specific: true,
    };
  }
  return { id: 'unclassified', meaning: `exit code ${String(exitCode)} is not in the measured table`, specific: false };
}

/**
 * Events that name *why* the process ended: a call the preload intercepted, or a fault it observed.
 */
const CAUSAL_KINDS = ['process.exit', 'process.abort', 'uncaughtExceptionMonitor'];

/**
 * Events that prove the process reached Node's shutdown path but say nothing about why.
 *
 * `exit` and `beforeExit` fire for any orderly termination. Treating them as causal would let a
 * child that merely finished be reported as having explained itself. What they do establish is
 * real and worth separating: neither fires for an external `TerminateProcess` or a native fault.
 */
const LIFECYCLE_KINDS = ['exit', 'beforeExit'];

/** Every event the preload records that implies the child was still running JS. */
const JS_EXIT_KINDS = [...CAUSAL_KINDS, ...LIFECYCLE_KINDS];

/**
 * State the strongest claim the combined evidence supports, and no stronger.
 *
 * The child-side log is what makes an otherwise ambiguous exit code informative: `process.exit(1)`
 * and an uncaught exception both log something and both fire Node's `exit` event, so a child that
 * reached `preload-installed` and then logged nothing at all cannot have died either way. What
 * remains — an external `TerminateProcess`, or a native path that bypasses JS entirely — is a
 * narrowing, not an identification, and this returns it as such.
 *
 * @param {{ id: string, specific: boolean }} classification
 * @param {readonly string[]} childKinds Event kinds the child logged, in order.
 * @returns {{ narrowed: boolean, statement: string }}
 */
function narrowFromChildEvidence(classification, childKinds) {
  const reachedPreload = childKinds.includes('preload-installed');
  const causal = CAUSAL_KINDS.find((kind) => childKinds.includes(kind));
  const lifecycle = LIFECYCLE_KINDS.some((kind) => childKinds.includes(kind));

  if (!reachedPreload) {
    return { narrowed: false, statement: 'the child never recorded preload-installed, so nothing is known about its JS lifecycle' };
  }
  if (causal !== undefined) {
    return {
      narrowed: false,
      statement: `the child logged ${causal}, which names the cause; the exit status only corroborates it`,
    };
  }
  if (lifecycle) {
    // Worth stating separately rather than folding into either branch: reaching `exit` proves the
    // child shut down through JS, which no external kill or native fault does — but no hook of ours
    // fired, so nothing here says why it chose to exit.
    return {
      narrowed: true,
      statement:
        "the child reached Node's shutdown events without any hook naming a cause, which rules out an " +
        'external termination and a native fault — both bypass them — but does not say why it exited',
    };
  }
  if (classification.specific) {
    return {
      narrowed: true,
      statement:
        `the child ran no JS exit path, which excludes process.exit and an uncaught exception, and the exit status names ${classification.id} ` +
        'as the candidate mechanism — the status is a number the terminating party chose, so this is the strongest candidate rather than proof',
    };
  }
  return {
    narrowed: true,
    statement:
      'the child reached preload-installed and then ran no JS exit path at all, which excludes process.exit and an uncaught exception; ' +
      'an external TerminateProcess or a native path that bypasses JS remains, and the exit status alone does not choose between them',
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
 * @returns {Map<string, { pid: number | null, kinds: string[] }>} keyed by the child's whole normalised path
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
      // Keyed on the child's whole path, not its basename. A suite run spans directories, and
      // `foo/a.test.js` and `bar/a.test.js` are different files whose events must never be merged.
      const key = normalizePath(record.testFile);
      const existing = byFile.get(key) ?? { pid: null, kinds: [] };
      existing.pid = typeof record.pid === 'number' ? record.pid : existing.pid;
      if (typeof record.kind === 'string') existing.kinds.push(record.kind);
      byFile.set(key, existing);
    }
  }
  return byFile;
}

/**
 * Find the child log belonging to one parent failure, or say that it cannot be told apart.
 *
 * The parent names the file as the runner received it, usually a relative path; the child records
 * its own resolved `argv[1]`, an absolute one. Matching is therefore by path *suffix* rather than
 * equality, which identifies `dist-test/test/foo/a.test.js` uniquely even when `bar/a.test.js`
 * exists. Basename is only a fallback for a parent path too short to disambiguate, and when either
 * step finds more than one candidate the answer is **ambiguous** rather than the first match:
 * attaching one file's PID and lifecycle events to another file's failure would make the diagnostic
 * assert something false, which is worse than reporting that it does not know.
 *
 * @param {ReturnType<typeof readChildLogs>} childLogs
 * @param {string} parentFile
 * @returns {{ child: { pid: number | null, kinds: string[] } | null, ambiguous: boolean, candidates: number }}
 */
function matchChild(childLogs, parentFile) {
  const wanted = normalizePath(parentFile);
  const entries = [...childLogs.entries()];

  const bySuffix = entries.filter(([key]) => key === wanted || key.endsWith(`/${wanted}`));
  if (bySuffix.length === 1) return { child: bySuffix[0][1], ambiguous: false, candidates: 1 };
  if (bySuffix.length > 1) return { child: null, ambiguous: true, candidates: bySuffix.length };

  const base = fileKey(wanted);
  const byBase = entries.filter(([key]) => fileKey(key) === base);
  if (byBase.length === 1) return { child: byBase[0][1], ambiguous: false, candidates: 1 };
  if (byBase.length > 1) return { child: null, ambiguous: true, candidates: byBase.length };

  return { child: null, ambiguous: false, candidates: 0 };
}

/**
 * Join parent-observed failures to child-observed lifecycle evidence, one record per failure.
 *
 * Matching is by whole normalised path, not by basename. The parent names the file as the runner
 * received it while the child records its own resolved `argv[1]`, so the child's key is the longer
 * path and the parent's name is a suffix of it; a basename comparison is the fallback, not the rule.
 * Basenames are *not* unique across the suite's compiled output, which is why a name matching more
 * than one child is reported `ambiguous` rather than resolved to whichever came first. A failure
 * with no matching child log is reported with `child.logFound: false` rather than being dropped,
 * because "the child never wrote a log" is itself evidence.
 *
 * @param {ReturnType<typeof parseTapFailures>} failures
 * @param {ReturnType<typeof readChildLogs>} childLogs
 * @returns {Array<object>}
 */
function correlate(failures, childLogs) {
  return failures.map((failure) => {
    const match = matchChild(childLogs, failure.file);
    const kinds = match.child?.kinds ?? [];
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
        logFound: match.child !== null,
        ambiguous: match.ambiguous,
        candidates: match.candidates,
        pid: match.child?.pid ?? null,
        kinds,
      },
      classification: classification.id,
      meaning: classification.meaning,
      specific: classification.specific,
      narrowed: match.ambiguous ? false : narrowing.narrowed,
      statement: match.ambiguous
        ? `${match.candidates} child logs match this file's name and none matches its path, so no lifecycle evidence can be attributed to it without guessing`
        : narrowing.statement,
    };
  });
}

module.exports = {
  EXIT_CODE_TABLE,
  MAX_RECORDS,
  classifyTermination,
  correlate,
  matchChild,
  narrowFromChildEvidence,
  normalizePath,
  parseTapFailures,
  readChildLogs,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const known = new Set(['--tap', '--child-logs']);
  let usage = null;
  // `--tap --child-logs dir` must be a usage error, not a request to read a file called
  // "--child-logs". An option that swallows the next option produces a confident wrong answer.
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    if (at === -1) return null;
    const value = args[at + 1];
    if (value === undefined || known.has(value)) {
      usage = `${flag} requires a value`;
      return null;
    }
    return value;
  };
  const tapPath = valueOf('--tap');
  const logDir = valueOf('--child-logs');
  if (usage !== null || tapPath === null || logDir === null) {
    process.stderr.write(`${usage ?? 'usage'}: signature-b-correlate.cjs --tap <report.tap> --child-logs <dir>\n`);
    process.exitCode = 2;
  } else {
    const records = correlate(parseTapFailures(fs.readFileSync(tapPath, 'utf8')), readChildLogs(logDir));
    for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
    if (records.length === 0) process.stderr.write('no Signature B failures in this report\n');
  }
}
