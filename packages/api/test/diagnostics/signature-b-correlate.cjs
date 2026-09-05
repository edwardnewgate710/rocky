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
 * A path with separators normalised to `/`. For Windows paths (identified by drive letter, UNC,
 * or explicit flag/metadata), backslashes are directory separators and are converted to `/`.
 * For POSIX paths, backslashes are valid filename characters and are preserved to avoid
 * splitting a single filename into multiple path segments.
 *
 * @param {string} filePath
 * @param {boolean} [isWindows]
 * @returns {string}
 */
function normalizePath(filePath, isWindows) {
  const str = String(filePath);
  const win = isWindows !== undefined ? isWindows : isWindowsPath(str);
  if (win) {
    return str.replace(/\\/g, '/').replace(/^\.\//, '');
  }
  return str.replace(/^\.\//, '');
}

/**
 * Last path segment, platform-independently.
 *
 * @param {string} filePath
 * @param {boolean} [isWindows]
 * @returns {string}
 */
function fileKey(filePath, isWindows) {
  const segments = normalizePath(filePath, isWindows).split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * Detect whether a path string represents a Windows path based strictly on unambiguous
 * Windows path syntax: a Windows drive prefix (e.g. `C:/` or `C:\`) or a UNC prefix (`//` or `\\`).
 * Analyzer host platform (`process.platform`) is deliberately omitted so that POSIX captures
 * analyzed on Windows preserve case-sensitivity, and Windows captures analyzed on Linux
 * apply case-insensitive matching.
 *
 * Backslash alone is NOT treated as proof of Windows origin because POSIX permits backslashes
 * in filenames. A path starting with a single slash is an absolute POSIX path and is never Windows.
 * For relative paths, Windows origin is determined via child-log capture metadata or explicit markers.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isWindowsPath(filePath) {
  const str = String(filePath);
  if (str.startsWith('/')) {
    return false;
  }
  return (
    /^[a-zA-Z]:(?:[/\\]|$)/.test(str) ||
    /^\\{2}[^/\\]/.test(str)
  );
}

/**
 * What an observed exit status *suggests*, keyed by the status the parent saw.
 *
 * Every code below was measured on this platform (Windows 11, Node v24.15.0) rather than assumed,
 * with one labelled exception: `process.abort()` and `process.exit(1)` by running them under the
 * test runner and reading the TAP block, and the external kills by spawning a sleeper and
 * terminating it from outside. Windows has no POSIX signals — `signal` is `null` for every external
 * kill and native fault — so the exit code is the only discriminator, and `1` does not discriminate
 * at all.
 *
 * The exception is `0xC000013A`, which is taken from documented Windows console semantics rather
 * than measured here. It is in the table because its absence was worse: it sits inside the
 * `0xC0000000` range, and the range fallback used to call anything in that range a native-fault
 * candidate, which for a console interrupt is simply wrong.
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
  { code: 3221225786, id: 'external-control-c', specific: true,
    meaning: 'candidate: STATUS_CONTROL_C_EXIT (0xC000013A), a console CTRL+C or CTRL+BREAK — an external interrupt, not a native fault; documented rather than measured here, and an external kill may pass the same value' },
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
  const unsigned = typeof exitCode === 'number' ? (exitCode >>> 0) : null;
  const known = EXIT_CODE_TABLE.find((entry) => entry.code === exitCode || (unsigned !== null && entry.code === unsigned));
  if (known) return { id: known.id, meaning: known.meaning, specific: known.specific };
  if (unsigned !== null && unsigned >= 0xc0000000) {
    // Membership of the range is not a finding. A native fault produces a value here, but so does a
    // console CTRL+C (`STATUS_CONTROL_C_EXIT`, in the table above), and an external TerminateProcess
    // can pass any of them deliberately. An unmeasured value in the range therefore narrows the
    // shape of the answer without naming a mechanism, and must not be reported as though it had.
    return {
      id: 'ntstatus-unmeasured',
      meaning: `exit code ${exitCode} (0x${unsigned.toString(16)}) is an NTSTATUS value this table does not cover; a native fault is one candidate, but the range also carries non-fault statuses such as STATUS_CONTROL_C_EXIT, so the number alone names no mechanism`,
      specific: false,
    };
  }
  return { id: 'unclassified', meaning: `exit code ${String(exitCode)} is not in the measured table`, specific: false };
}

/**
 * The only lines a dying child prints that name its own cause.
 *
 * Node prints these itself, and they are what separates a V8 heap exhaustion from a JS
 * `process.abort()` or an external kill when all three can leave exit code 134.
 */
const FATAL_MARKERS = [
  'FATAL ERROR:',
  'JavaScript heap out of memory',
  '<--- Last few GCs --->',
  '----- Native stack trace -----',
  '----- JavaScript stack trace -----',
];

/**
 * The lines of a TAP region that are Node's own diagnostics, and nothing else.
 *
 * A child's stderr reaches the report as `# ` comment lines, which is what makes a banner readable
 * at all. Ordinary suite output reaches it too — as YAML bodies, as quoted error messages — and a
 * substring scan over the raw region cannot tell a test that PRINTED `FATAL ERROR:` from a child
 * that died of one. Keeping only the diagnostic lines is not a complete defence (a test that writes
 * the banner to its own stderr is indistinguishable by construction) but it removes every case
 * where the text was never presented as a diagnostic in the first place.
 *
 * @param {string} region
 * @returns {string} the region's `# ` lines, joined
 */
function childDiagnostics(region) {
  return String(region)
    .split('\n')
    .filter((line) => /^#\s/.test(line))
    .join('\n');
}

/**
 * Which fatal markers a run's reporter output contained, and never the output itself.
 *
 * Read the REPORT, not the parent's stderr. Node's runner attaches a readline interface to each
 * child's stderr and re-emits every line as a `test:stderr` reporter event, so a child's fatal
 * banner reaches the TAP file as `# ` diagnostics and never reaches the parent process's own
 * stderr at all — measured here on a real bounded heap exhaustion as zero bytes on the parent's
 * stderr against the full banner in the TAP.
 *
 * A whitelist rather than a redaction pass: a suite's output can contain anything a test chose to
 * print, so matching known markers is the only way to be sure a token, request body or connection
 * string cannot reach a capture file. Presence is all the evidence is worth anyway — the marker
 * names the mechanism, the surrounding text does not.
 *
 * @param {string | undefined} text Reporter output, typically the TAP report.
 * @returns {string[]} markers present, in the order listed above
 */
function fatalMarkersIn(text) {
  const haystack = String(text ?? '');
  return FATAL_MARKERS.filter((marker) => haystack.includes(marker));
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
/**
 * @param {string} tapText
 * @param {{ isWindows?: boolean }} [options]
 * @returns {Array<{ file: string, exitCode: number | null, signal: string | null, failureType: string | null, durationMs: number | null, fatalMarkers: string[], isWindows?: boolean }>}
 */
function parseTapFailures(tapText, options = {}) {
  const text = String(tapText);
  const blocks = text.matchAll(/^not ok \d+ - (.+?)$\r?\n\s*---\r?\n([\s\S]*?)^\s*\.\.\.$/gm);
  // Where each reported test's own output ends, so a run's diagnostic lines can be split between
  // the files that produced them. Node emits a child's stderr as top-level `# ` diagnostics as it
  // arrives, ahead of the point line for the file that produced it, so everything between the end of
  // the previous report and this point line belongs to this file.
  //
  // The boundary is the end of the previous test's YAML block, not the end of its point line: the
  // block comes AFTER the point line, so stopping at the line would leave the previous failure's
  // whole body — its error message, its stack — inside the next file's region, and a suite that
  // fails while quoting one of these banners would hand it to whichever file failed next.
  //
  // Attribution needs one child reporting at a time. The two packages this runner targets both pass
  // `--test-concurrency=1` (`packages/api` and `packages/persistence`; no other workspace package
  // does). A report produced at Node's default concurrency interleaves several children's output and
  // is not attributable this way — reading one here would be reading a different experiment.
  const regionEnds = [];
  for (const point of text.matchAll(/^(?:not )?ok \d+ - .*$/gm)) {
    const afterPoint = point.index + point[0].length;
    const yaml = /^\r?\n\s*---\r?\n[\s\S]*?\r?\n\s*\.\.\.[^\r\n]*/.exec(text.slice(afterPoint));
    regionEnds.push(yaml === null ? afterPoint : afterPoint + yaml[0].length);
  }
  const out = [];
  const isWin = typeof options?.isWindows === 'boolean' ? options.isWindows : undefined;
  for (const match of blocks) {
    const [, rawName, body] = match;
    if (!/^\s*error:\s*['"]?test failed['"]?\s*$/m.test(body)) continue;
    if (!/^\s*failureType:\s*['"]?testCodeFailure['"]?\s*$/m.test(body)) continue;
    if (out.length >= MAX_RECORDS) break;
    const scalar = (key) => {
      const found = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(body);
      return found ? found[1].trim() : null;
    };
    const unquote = (s) => (s === null || s === undefined ? null : s.replace(/^['"]|['"]$/g, ''));
    const exit = unquote(scalar('exitCode'));
    const sig = unquote(scalar('signal'));
    const dur = unquote(scalar('duration_ms'));
    const parsedExit = exit === null || exit === '~' || exit === '' ? null : Number(exit);
    const parsedDur = dur === null || dur === '~' || dur === '' ? null : Number(dur);
    let sliceStart = 0;
    for (const end of regionEnds) {
      if (end >= match.index) break;
      sliceStart = end;
    }
    out.push({
      fatalMarkers: fatalMarkersIn(childDiagnostics(text.slice(sliceStart, match.index))),
      file: rawName.trim().replace(/\\\\/g, '\\'),
      exitCode: parsedExit !== null && Number.isFinite(parsedExit) ? parsedExit : null,
      signal: sig === null || sig === '~' ? null : sig,
      failureType: unquote(scalar('failureType')),
      durationMs: parsedDur !== null && Number.isFinite(parsedDur) ? parsedDur : null,
      ...(typeof isWin === 'boolean' ? { isWindows: isWin } : {}),
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
 * @returns {Map<string, { pidCount: number, pid: number | null, kinds: string[] }>} keyed by the
 *   child's whole normalised path. Each entry counts the processes that ran that file, and reports
 *   a pid and its events only when there was exactly one.
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
      const isWin = typeof record.isWindows === 'boolean'
        ? record.isWindows
        : (typeof record.platform === 'string'
          ? record.platform === 'win32'
          : isWindowsPath(record.testFile));
      // Keyed on the child's whole path, not its basename. A suite run spans directories, and
      // `foo/a.test.js` and `bar/a.test.js` are different files whose events must never be merged.
      const normalized = normalizePath(record.testFile, isWin);
      let key = normalized;
      if (isWin) {
        const lower = normalized.toLowerCase();
        for (const existingKey of byFile.keys()) {
          const candidate = byFile.get(existingKey);
          if (candidate?.isWindows && existingKey.toLowerCase() === lower) {
            key = existingKey;
            break;
          }
        }
      }
      // Events are bucketed by the process that emitted them, never appended to one list. One
      // directory can hold logs from more than one run of the same file — the preload defaults to a
      // shared temp directory nothing cleans — and concatenating those would put an earlier run's
      // `exit` into a later run's evidence, which is exactly what makes `narrowFromChildEvidence`
      // announce that an external termination and a native fault are ruled out.
      //
      // The bucket is keyed by the log FILE as well as the pid, because a pid is not an identity:
      // Windows reuses them freely, and two runs of one file in one directory can carry the same
      // number. Each process writes its own `run-<pid>-<ms>.jsonl`, so the file supplies the part
      // the pid cannot.
      const pid = typeof record.pid === 'number' ? record.pid : null;
      const existing = byFile.get(key) ?? { processes: new Map(), isWindows: false };
      const bucketKey = `${entry}\u0000${pid === null ? 'unknown' : pid}`;
      const bucket = existing.processes.get(bucketKey) ?? { pid, kinds: [] };
      if (typeof record.kind === 'string') bucket.kinds.push(record.kind);
      existing.processes.set(bucketKey, bucket);
      if (isWin) existing.isWindows = true;
      byFile.set(key, existing);
    }
  }
  // A file with one process on record reports that process. A file with several is not evidence
  // about either of them, and says so through `pidCount` rather than by picking one.
  for (const record of byFile.values()) {
    const buckets = [...record.processes.values()];
    record.pidCount = buckets.length;
    record.pid = buckets.length === 1 ? buckets[0].pid : null;
    record.kinds = buckets.length === 1 ? buckets[0].kinds : [];
  }
  return byFile;
}

/**
 * One path matched one entry — but an entry holding several processes is still not evidence.
 *
 * Two runs of the same file in one log directory match that file equally well, and there is no
 * sound way to choose between them: the newest is not necessarily the failing one, and attaching
 * either one's lifecycle events to the other's failure would make the diagnostic assert something
 * false. Reporting that it does not know is the only honest answer.
 *
 * @param {{ pidCount?: number, pid: number | null, kinds: string[] }} child
 */
function single(child) {
  const count = child?.pidCount ?? 1;
  if (count > 1) return { child: null, ambiguous: true, candidates: count };
  return { child, ambiguous: false, candidates: 1 };
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
 * @param {boolean} [parentIsWindows]
 * @returns {{ child: { pid: number | null, kinds: string[] } | null, ambiguous: boolean, candidates: number }}
 */
function matchChild(childLogs, parentFile, parentIsWindows) {
  const isWantedWin = typeof parentIsWindows === 'boolean'
    ? parentIsWindows
    : isWindowsPath(parentFile);
  const parentNorm = normalizePath(parentFile, isWantedWin);
  const entries = [...childLogs.entries()];

  const bySuffix = entries.filter(([key, child]) => {
    const isWin = Boolean(child?.isWindows || isWantedWin);
    const wantedNorm = isWin ? parentNorm.toLowerCase() : parentNorm;
    const keyNorm = isWin ? key.toLowerCase() : key;
    return keyNorm === wantedNorm || keyNorm.endsWith(`/${wantedNorm}`);
  });
  if (bySuffix.length === 1) return single(bySuffix[0][1]);
  if (bySuffix.length > 1) return { child: null, ambiguous: true, candidates: bySuffix.length };

  // Basename fallback is ONLY for a parent path too short to disambiguate (i.e. bare filename with no slashes).
  // When the parent specified a directory path and bySuffix found 0 matches, that file has no child log.
  // Matching a different directory's child would be a false cross-directory attribution.
  if (!parentNorm.includes('/')) {
    const base = fileKey(parentFile, isWantedWin);
    const byBase = entries.filter(([key, child]) => {
      const isWin = Boolean(child?.isWindows || isWantedWin);
      const kBase = fileKey(key, isWin);
      if (isWin) {
        return kBase.toLowerCase() === base.toLowerCase();
      }
      return kBase === base;
    });
    if (byBase.length === 1) return single(byBase[0][1]);
    if (byBase.length > 1) return { child: null, ambiguous: true, candidates: byBase.length };
  }

  return { child: null, ambiguous: false, candidates: 0 };
}

/**
 * Join parent-observed failures to child-observed lifecycle evidence, one record per failure.
 *
 * Matching is by whole normalised path, not by basename. The parent names the file as the runner
 * received it while the child records its own resolved `argv[1]`, an absolute one. Matching is therefore
 * by path *suffix* rather than equality, which identifies `dist-test/test/foo/a.test.js` uniquely even
 * when `bar/a.test.js` exists. Basename is only a fallback for a parent path too short to disambiguate,
 * and when either step finds more than one candidate the answer is reported ambiguous rather than resolved.
 *
 * @param {ReturnType<typeof parseTapFailures>} failures
 * @param {ReturnType<typeof readChildLogs>} childLogs
 * @param {{ isWindows?: boolean }} [options]
 * @returns {Array<object>}
 */
function correlate(failures, childLogs, options = {}) {
  const defaultIsWin = typeof options?.isWindows === 'boolean' ? options.isWindows : undefined;
  return failures.map((rawFailure) => {
    const failure = typeof rawFailure === 'string'
      ? { file: rawFailure, exitCode: null, signal: null, failureType: null, durationMs: null, fatalMarkers: [] }
      : rawFailure;
    const parentIsWin = typeof failure?.isWindows === 'boolean'
      ? failure.isWindows
      : defaultIsWin;
    const match = matchChild(childLogs, failure.file, parentIsWin);
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
      fatalMarkers: failure.fatalMarkers ?? [],
      classification: classification.id,
      meaning: classification.meaning,
      specific: classification.specific,
      narrowed: match.ambiguous ? false : narrowing.narrowed,
      statement: match.ambiguous
        ? `${match.candidates} child processes are on record for this file — a second directory of the same name, or a second run left in the same log directory — so no lifecycle evidence can be attributed to it without guessing`
        : narrowing.statement,
    };
  });
}

module.exports = {
  EXIT_CODE_TABLE,
  FATAL_MARKERS,
  MAX_RECORDS,
  classifyTermination,
  correlate,
  fatalMarkersIn,
  isWindowsPath,
  matchChild,
  narrowFromChildEvidence,
  normalizePath,
  parseTapFailures,
  readChildLogs,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const known = new Set(['--tap', '--child-logs', '--windows', '--posix']);
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
    process.stderr.write(`${usage ?? 'usage'}: signature-b-correlate.cjs --tap <report.tap> --child-logs <dir> [--windows|--posix]\n`);
    process.exitCode = 2;
  } else {
    const isWindowsExplicit = args.includes('--windows') ? true : (args.includes('--posix') ? false : undefined);
    const childLogs = readChildLogs(logDir);
    // Derive capture platform only when child logs are uniformly Windows or POSIX; never let mixed or stale logs force Windows semantics
    const children = [...childLogs.values()];
    const allWindows = children.length > 0 && children.every((child) => child?.isWindows);
    const allPosix = children.length > 0 && children.every((child) => !child?.isWindows);
    const isWin = typeof isWindowsExplicit === 'boolean'
      ? isWindowsExplicit
      : (allWindows ? true : (allPosix ? false : undefined));
    const records = correlate(
      parseTapFailures(fs.readFileSync(tapPath, 'utf8'), { isWindows: isWin }),
      childLogs,
      { isWindows: isWin },
    );
    for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
    if (records.length === 0) process.stderr.write('no Signature B failures in this report\n');
  }
}
