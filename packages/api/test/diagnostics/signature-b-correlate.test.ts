import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIAGNOSTICS_DIR = path.resolve(__dirname, '../../../test/diagnostics');
const CORRELATE_PATH = path.join(DIAGNOSTICS_DIR, 'signature-b-correlate.cjs');
const PRELOAD_PATH = path.join(DIAGNOSTICS_DIR, 'signature-b-preload.cjs');

/**
 * One record per parent-observed failure, exactly as `correlate` emits it.
 *
 * Declared once so the tests assert against the contract instead of each call site casting to its
 * own guess of the shape. A field that moves or is dropped then fails to compile here, rather than
 * silently passing every test that did not happen to name it.
 */
interface CorrelatedRecord {
  file: string;
  parent: {
    exitCode: number | null;
    signal: string | null;
    failureType: string | null;
    durationMs: number | null;
  };
  child: {
    logFound: boolean;
    ambiguous: boolean;
    candidates: number;
    pid: number | null;
    kinds: string[];
  };
  classification: string;
  meaning: string;
  specific: boolean;
  narrowed: boolean;
  statement: string;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const correlator = require(CORRELATE_PATH) as {
  EXIT_CODE_TABLE: ReadonlyArray<{ code: number; id: string; specific: boolean }>;
  MAX_RECORDS: number;
  classifyTermination(t: { exitCode: number | null; signal: string | null }): {
    id: string;
    meaning: string;
    specific: boolean;
  };
  correlate(failures: unknown[], childLogs: Map<string, unknown>): CorrelatedRecord[];
  narrowFromChildEvidence(
    c: { id: string; specific: boolean },
    kinds: readonly string[],
  ): { narrowed: boolean; statement: string };
  parseTapFailures(tap: string): Array<{
    file: string;
    exitCode: number | null;
    signal: string | null;
    failureType: string | null;
    durationMs: number | null;
  }>;
  readChildLogs(dir: string): Map<string, { pid: number | null; kinds: string[] }>;
  matchChild(logs: Map<string, unknown>, file: string): { child: unknown; ambiguous: boolean; candidates: number };
  normalizePath(p: string): string;
  isWindowsPath(p: string): boolean;
};

/** A TAP block in the exact shape Node's built-in reporter emits for a file-level failure. */
function tapFailure(file: string, exitCode: string, signal = '~', failureType = 'testCodeFailure'): string {
  return [
    `# Subtest: ${file}`,
    `not ok 1 - ${file}`,
    '  ---',
    '  duration_ms: 612.4',
    "  type: 'test'",
    `  location: 'C:\\repo\\${file}:1:1'`,
    `  failureType: '${failureType}'`,
    `  exitCode: ${exitCode}`,
    `  signal: ${signal}`,
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
  ].join('\n');
}

test('correlator: reads the exit status the spec reporter discards out of a TAP block', () => {
  const failures = correlator.parseTapFailures(tapFailure('studies-api.test.js', '3221225477'));

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.exitCode, 3221225477, 'the NTSTATUS code survives as an unsigned integer');
  assert.equal(failures[0]?.signal, null, 'a YAML ~ is null, not the string "~"');
  assert.equal(failures[0]?.failureType, 'testCodeFailure');
});

test('correlator: ignores a test that failed on its own assertion', () => {
  const realFailure = [
    'not ok 1 - some genuine test',
    '  ---',
    '  duration_ms: 3.1',
    "  error: 'Expected values to be strictly equal'",
    '  ...',
  ].join('\n');

  assert.deepEqual(correlator.parseTapFailures(realFailure), [], 'only Node\'s bare fallback is Signature B');
});

test('correlator: an ordinary failing assertion is not a Signature B capture', () => {
  // Node writes `error: 'test failed'` for any file whose child exited non-zero, so a file holding
  // an ordinary failing test carries the identical message — under `subtestsFailed`, because a
  // subtest did fail. Matching the message alone would report every regression as a capture and
  // halt the pass on a false positive.
  const ordinary = tapFailure('has-a-failing-test.test.js', '1', '~', 'subtestsFailed');

  assert.deepEqual(correlator.parseTapFailures(ordinary), [], 'only the no-subtest-failed branch is this defect');
  assert.equal(correlator.parseTapFailures(tapFailure('died.test.js', '1')).length, 1, 'testCodeFailure still counts');
});

test('correlator: classifies every termination code that was measured on this platform', () => {
  assert.equal(correlator.classifyTermination({ exitCode: 134, signal: null }).id, 'native-abort-or-v8-fatal');
  assert.equal(correlator.classifyTermination({ exitCode: 3221225477, signal: null }).id, 'native-access-violation');
  assert.equal(correlator.classifyTermination({ exitCode: 4294967295, signal: null }).id, 'external-terminate-process');
  assert.equal(
    correlator.classifyTermination({ exitCode: 3221225786, signal: null }).id,
    'external-control-c',
    '0xC000013A is STATUS_CONTROL_C_EXIT, a console interrupt — not a native fault',
  );
});

test('correlator: an unmeasured NTSTATUS code names no mechanism', () => {
  // The range fallback used to report anything at or above 0xC0000000 as a native-fault candidate.
  // STATUS_CONTROL_C_EXIT (0xC000013A) disproves that as a rule: it lives in the range and means a
  // console CTRL+C. So membership narrows the shape of the answer and nothing more, and a value the
  // measured table does not cover has to be reported non-specific.
  const unmeasured = correlator.classifyTermination({ exitCode: 0xc0000022, signal: null });

  assert.equal(unmeasured.id, 'ntstatus-unmeasured');
  assert.equal(unmeasured.specific, false, 'an unmeasured status in the range must not claim a mechanism');
  assert.match(unmeasured.meaning, /does not cover/);
  assert.doesNotMatch(unmeasured.meaning, /^candidate:/, 'it names no candidate to lead with');
});

test('correlator: an exit status names a candidate mechanism, never a proven one', () => {
  // An exit status is a 32-bit integer the terminating party chooses. `TerminateProcess(h,
  // 0xC0000005)` produces the same number as a real access violation, so treating the number as
  // proof of a native fault would be an unsupported claim dressed as a measurement.
  for (const exitCode of [134, 3221225477, 3221226505, 3221225725, 3221225540, 4294967295, 3221225786]) {
    const classification = correlator.classifyTermination({ exitCode, signal: null });
    assert.equal(classification.specific, true, `${exitCode} names a specific mechanism`);
    assert.match(classification.meaning, /candidate/, `${exitCode} must be described as a candidate`);
  }

  assert.ok(
    correlator.EXIT_CODE_TABLE.every((entry) => !('conclusive' in entry)),
    'no entry may claim to be conclusive from its status number alone',
  );
});

test('correlator: same-basename files in different directories are never merged', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-collide-'));
  try {
    const lines = [
      { kind: 'start', pid: 111, testFile: 'C:\\r\\dist-test\\test\\foo\\a.test.js' },
      { kind: 'exit', pid: 111, testFile: 'C:\\r\\dist-test\\test\\foo\\a.test.js' },
      { kind: 'start', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
      { kind: 'preload-installed', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-c.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/bar/a.test.js', '1')),
      logs,
    );
    assert.equal(resolved[0]?.child.pid, 222, 'the full path picks the right one of two same-named files');
    assert.equal(resolved[0]?.child.ambiguous, false);
    assert.deepEqual(resolved[0]?.child.kinds, ['start', 'preload-installed']);

    // A parent path too short to disambiguate must be reported as ambiguous, never guessed.
    const ambiguous = correlator.correlate(
      correlator.parseTapFailures(tapFailure('a.test.js', '1')),
      logs,
    );
    assert.equal(ambiguous[0]?.child.ambiguous, true, 'two candidates is not an answer');
    assert.equal(ambiguous[0]?.child.pid, null, 'and no PID may be attributed');
    assert.equal(ambiguous[0]?.narrowed, false, 'evidence that is not this file\'s narrows nothing');
    assert.match(ambiguous[0]?.statement ?? '', /without guessing/);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: an option given no value is a usage error, not a path', () => {
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [CORRELATE_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });

  // `--tap --child-logs d` must not read a file literally called "--child-logs".
  const swallowed = run(['--tap', '--child-logs', 'd']);
  assert.notEqual(swallowed.status, 0);
  assert.match(`${swallowed.stderr}`, /--tap requires a value/);

  const missing = run(['--tap']);
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}`, /requires a value/);
});

test('correlator: names the signal that killed a child but never claims who sent it', () => {
  // Node's exit contract reports the signal, not its sender, so an external SIGKILL on Linux is
  // indistinguishable here from a runner cancellation. Attributing one would be the same
  // unsupported leap this module refuses to make for exit code 1.
  const classification = correlator.classifyTermination({ exitCode: null, signal: 'SIGKILL' });

  assert.equal(classification.id, 'signal-terminated');
  assert.equal(classification.specific, false, 'the mechanism is known; the actor is not');
  assert.match(classification.meaning, /SIGKILL/);
  assert.doesNotMatch(classification.meaning, /the test runner killed/, 'no sender may be named');
});

test('correlator: refuses to identify exit code 1, which four different causes produce', () => {
  const classification = correlator.classifyTermination({ exitCode: 1, signal: null });

  assert.equal(classification.id, 'inconclusive');
  assert.equal(classification.specific, false, 'claiming a cause from exit code 1 would be the wrong answer');
});

test('correlator: an unrun JS exit path narrows an inconclusive code without identifying it', () => {
  const inconclusive = { id: 'inconclusive', specific: false };

  const silent = correlator.narrowFromChildEvidence(inconclusive, ['start', 'preload-installed']);
  assert.equal(silent.narrowed, true);
  assert.match(silent.statement, /excludes process\.exit and an uncaught exception/);

  const exited = correlator.narrowFromChildEvidence(inconclusive, ['start', 'preload-installed', 'process.exit']);
  assert.equal(exited.narrowed, false, 'a child whose own log names the cause explains itself');

  const nothing = correlator.narrowFromChildEvidence(inconclusive, []);
  assert.equal(nothing.narrowed, false, 'no child log is no evidence');
});

test('correlator: a shutdown event is not a cause, and is not reported as one', () => {
  // `exit` and `beforeExit` fire for any orderly termination, so treating them as causal would let
  // a child that merely finished be reported as having explained itself. What they do establish is
  // narrower and still useful: neither fires for an external kill or a native fault.
  const inconclusive = { id: 'inconclusive', specific: false };

  const named = correlator.narrowFromChildEvidence(inconclusive, ['preload-installed', 'process.exit', 'exit']);
  assert.equal(named.narrowed, false, 'a hook that names the cause explains the child');
  assert.match(named.statement, /process\.exit, which names the cause/);

  const shutdownOnly = correlator.narrowFromChildEvidence(inconclusive, ['preload-installed', 'exit']);
  assert.equal(shutdownOnly.narrowed, true, 'reaching shutdown is evidence, just not of a cause');
  assert.doesNotMatch(shutdownOnly.statement, /names the cause/, 'no cause may be claimed from a lifecycle event');
  assert.match(shutdownOnly.statement, /does not say why it exited/);

  const beforeOnly = correlator.narrowFromChildEvidence(inconclusive, ['preload-installed', 'beforeExit']);
  assert.doesNotMatch(beforeOnly.statement, /names the cause/, 'beforeExit names nothing either');
});

test('correlator: joins the parent record to the child that ran that file', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-correlate-'));
  try {
    // The unrelated child is written FIRST on purpose: a correlator that took whichever log came
    // to hand rather than the one for this file would report PID 9999, and ordering it the other
    // way round would let that mistake pass unnoticed.
    const lines = [
      { kind: 'start', pid: 9999, testFile: 'C:\\repo\\dist-test\\test\\other.test.js' },
      { kind: 'exit', pid: 9999, testFile: 'C:\\repo\\dist-test\\test\\other.test.js' },
      { kind: 'start', pid: 4242, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js' },
      { kind: 'preload-installed', pid: 4242, testFile: 'C:\\repo\\dist-test\\test\\studies-api.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const records = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      correlator.readChildLogs(logDir),
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.child.pid, 4242, 'the PID comes from the child that ran this file, not another');
    assert.deepEqual(records[0]?.child.kinds, ['start', 'preload-installed']);
    assert.equal(records[0]?.parent.exitCode, 1);
    assert.equal(records[0]?.classification, 'inconclusive');
    assert.equal(records[0]?.narrowed, true, 'silence on the child side is what makes exit code 1 informative');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: joins a capture taken on either platform, read on either platform', () => {
  // A capture is taken on the developer machine and may be read anywhere, CI included. The host's
  // own path helpers split only on the host's separator, so a Windows log read on Linux would keep
  // its backslashes and match nothing — which is exactly how CI caught this.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-sep-'));
  try {
    const lines = [
      { kind: 'start', pid: 111, testFile: 'C:\\repo\\dist-test\\test\\windows-style.test.js' },
      { kind: 'start', pid: 222, testFile: '/home/runner/repo/dist-test/test/posix-style.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-3.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const logs = correlator.readChildLogs(logDir);

    assert.deepEqual(
      [...logs.keys()].sort(),
      ['/home/runner/repo/dist-test/test/posix-style.test.js', 'C:/repo/dist-test/test/windows-style.test.js'].sort(),
      'both separators normalise to / so the key never depends on the reading platform',
    );

    const pidFor = (file: string): number | null =>
      correlator.correlate(correlator.parseTapFailures(tapFailure(file, '1')), logs)[0]?.child.pid ?? null;

    assert.equal(pidFor('dist-test/test/windows-style.test.js'), 111, 'a backslash-recorded child matches its parent');
    assert.equal(pidFor('dist-test/test/posix-style.test.js'), 222, 'so does a forward-slash one');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: a malformed trailing line does not discard the record before it', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-correlate-'));
  try {
    const good = JSON.stringify({ kind: 'start', pid: 7, testFile: 'a.test.js' });
    fs.writeFileSync(path.join(logDir, 'run-2.jsonl'), `${good}\n{"kind":"preload-inst`);

    const logs = correlator.readChildLogs(logDir);

    assert.equal(logs.get('a.test.js')?.pid, 7, 'a child killed mid-write still yields what it managed to log');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: bounds how many records one report can produce', () => {
  const many = Array.from({ length: correlator.MAX_RECORDS + 25 }, (_, i) => tapFailure(`f${i}.test.js`, '1')).join('\n');

  assert.equal(correlator.parseTapFailures(many).length, correlator.MAX_RECORDS);
});

/** Runs the pass script and returns its result, isolated from this suite's own test context. */
function runPass(args: string[], cwd?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), ...args], {
    cwd: cwd ?? path.resolve(DIAGNOSTICS_DIR, '../..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
}

/**
 * Read a worker pid once the file actually holds one.
 *
 * `existsSync` turns true when the worker creates the file, which can precede it writing the bytes.
 * An empty read gives `Number('') === 0`, and pid 0 is not "no process" — `process.kill(0, ...)`
 * addresses this test's *own* process group, so a naive read would have the test signalling itself
 * and then reporting the worker as still alive.
 *
 * @returns the pid, or null if none appeared before the deadline
 */
async function readWorkerPid(pidFile: string, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Kill a pid outright, tolerating one that is already gone.
 *
 * Used from `finally` in the tests that deliberately start a long-sleeping worker: if their cleanup
 * assertion fails, the worker they were complaining about would otherwise outlive the suite and
 * interfere with whatever runs next. A test that leaks the process it is policing is worse than no
 * test at all.
 */
function reap(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone, which is what the assertion wanted */
  }
}

/**
 * Wait for a pid to disappear, or give up.
 *
 * `process.kill(pid, 0)` sends no signal and throws ESRCH once the process is gone, but signal
 * delivery and reaping are asynchronous — sampling once right after a kill can still see a process
 * that is on its way out. Polling to a deadline tests the guarantee that actually matters ("it does
 * not survive") without asserting anything about how fast the OS gets there.
 */
async function waitForExit(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A test file that finishes immediately, so a pass over it costs a process start and nothing more. */
function trivialTarget(dir: string): string {
  const file = path.join(dir, 'noop.test.cjs');
  fs.writeFileSync(file, "require('node:test').test('noop', () => {});\n");
  return file;
}

test('pass runner: --runs is a whole, finite, positive count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-runs-'));
  try {
    const target = trivialTarget(dir);

    // A fractional count is the one that matters: 1.5 passes a naive positive-number check and then
    // executes runs 1 and 2, exceeding the ceiling the pass just declared to the reader.
    for (const bad of ['1.5', '0', '-3', 'Infinity', 'twenty', '']) {
      const result = runPass(['--runs', bad, '--target', target, '--out', path.join(dir, `r${bad || 'empty'}`)]);
      assert.notEqual(result.status, 0, `--runs ${JSON.stringify(bad)} must be refused`);
      assert.match(`${result.stderr}`, /must be a (positive number|whole number of runs)/, `--runs ${JSON.stringify(bad)} must say why`);
      assert.doesNotMatch(`${result.stdout}`, /was not observed/, 'a refused ceiling must not report a clean pass');
    }

    for (const good of ['1', '2']) {
      const out = path.join(dir, `ok${good}`);
      const result = runPass(['--runs', good, '--target', target, '--out', out]);
      assert.equal(result.status, 0, `--runs ${good} must be accepted`);
      const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as { runs: unknown[] };
      assert.equal(summary.runs.length, Number(good), `--runs ${good} must execute exactly ${good} run(s)`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an option consumed as another option is a usage error', () => {
  for (const args of [['--out', '--target', 'x'], ['--target', '--out'], ['--max-minutes']]) {
    const result = runPass(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} must be refused`);
    assert.match(`${result.stderr}`, /requires a value/);
  }
  assert.ok(!fs.existsSync(path.resolve(DIAGNOSTICS_DIR, '../..', '--target')), 'and must create no directory named after an option');
});

test('pass runner: the ceiling kills the run and every process it started', async () => {
  // Deterministic in both directions by a wide margin: the target blocks for 30s while the ceiling
  // is 6s, which has to outlast two process starts — this script starts `node --test`, which then
  // spawns the per-file worker that records its pid at load time. This is the one behaviour that
  // needs a real timeout, because it is the process-tree cleanup being asserted: node:test spawns
  // one child per file, and on POSIX a SIGKILL to the runner is not delivered to that child.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-tree-'));
  let workerPid: number | null = null;
  try {
    const pidFile = path.join(dir, 'child.pid');
    const target = path.join(dir, 'blocks.test.cjs');
    fs.writeFileSync(
      target,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        "require('node:test').test('blocks', async () => {\n" +
        '  await new Promise((r) => setTimeout(r, 30000));\n' +
        '});\n',
    );
    const out = path.join(dir, 'out');

    const result = runPass(['--runs', '1', '--max-minutes', '0.1', '--target', target, '--out', out]);

    assert.notEqual(result.status, 0, 'a pass with no readable run must not exit successfully');
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      runs: Array<{ timedOut: boolean; collectionError: string | null }>;
    };
    assert.equal(summary.runs[0]?.timedOut, true, 'the deadline, not a signal, is what marks a run timed out');
    assert.match(`${summary.runs[0]?.collectionError}`, /ceiling/);

    workerPid = await readWorkerPid(pidFile);
    assert.ok(workerPid !== null, 'the per-file child recorded its pid');
    assert.equal(await waitForExit(workerPid), true, 'the per-file child must not outlive the ceiling');
    // Proven gone, so there is nothing left to reap — and `waitForExit` only ever held the number.
    // Passing a dead pid to `reap` would signal whatever the OS has since reused it for.
    workerPid = null;
  } finally {
    reap(workerPid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: a completed run is not reported as timed out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-nottimeout-'));
  try {
    const out = path.join(dir, 'out');
    const result = runPass(['--runs', '1', '--target', trivialTarget(dir), '--out', out]);

    assert.equal(result.status, 0);
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      runs: Array<{ timedOut: boolean; collectionError: string | null }>;
    };
    assert.equal(summary.runs[0]?.timedOut, false, 'a run that finished inside its budget did not time out');
    assert.equal(summary.runs[0]?.collectionError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: interrupting the pass takes the detached test tree with it', {
  skip: process.platform === 'win32'
    ? 'SIGTERM on Windows terminates without running handlers, and libuv already reaps the tree there'
    : false,
}, async () => {
  // Detaching the run is what makes its group killable, and it is also what stops a terminal Ctrl-C
  // reaching it: the runner is no longer in the foreground process group. Without the handlers this
  // asserts, interrupting a pass would leave node --test and every per-file worker running against
  // the suite database.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-signal-'));
  try {
    const pidFile = path.join(dir, 'child.pid');
    const target = path.join(dir, 'blocks.test.cjs');
    fs.writeFileSync(
      target,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        "require('node:test').test('blocks', async () => {\n" +
        '  await new Promise((r) => setTimeout(r, 30000));\n' +
        '});\n',
    );

    let workerPid: number | null = null;
    const pass = spawn(
      process.execPath,
      [path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'), '--runs', '1', '--target', target, '--out', path.join(dir, 'out')],
      { cwd: path.resolve(DIAGNOSTICS_DIR, '../..'), env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: 'ignore' },
    );

    try {
      // Wait for the worker to have written a usable pid, so the interrupt has something to clean
      // up and the liveness probe addresses the worker rather than this process group.
      workerPid = await readWorkerPid(pidFile);
      assert.ok(workerPid !== null, 'the per-file worker started and recorded its pid');

      pass.kill('SIGTERM');
      await new Promise((resolve) => pass.on('close', resolve));

      assert.equal(
        await waitForExit(workerPid),
        true,
        'the detached per-file worker must not survive the interrupted pass',
      );
      // Same reason as the ceiling test: once the pid is proven gone it belongs to nobody, and
      // reaping it later could kill an unrelated process the OS gave that number to.
      workerPid = null;
    } finally {
      // Two ways this test could leak the tree it started: the worker never appears, so the
      // assertion throws before the interrupt is sent; or the cleanup being asserted did not happen,
      // so the worker is still sleeping. Both are covered here rather than in the happy path.
      pass.kill('SIGKILL');
      reap(workerPid);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: a capture keeps the normalised record and discards the raw TAP', () => {
  // The raw TAP is a full transcript of whatever the suite printed. Once `capture.json` holds the
  // enumerated fields, keeping the transcript retains arbitrary test output for no diagnostic gain.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-capture-'));
  try {
    const target = path.join(dir, 'dies.test.cjs');
    fs.writeFileSync(target, 'process.exit(3);\n');
    const out = path.join(dir, 'out');

    const result = runPass(['--runs', '3', '--target', target, '--out', out]);

    assert.equal(result.status, 0);
    const capture = JSON.parse(fs.readFileSync(path.join(out, 'capture.json'), 'utf8')) as {
      run: number;
      records: Array<{ parent: { exitCode: number | null } }>;
    };
    assert.equal(capture.run, 1, 'the pass stops at the first capture');
    assert.equal(capture.records[0]?.parent.exitCode, 3, 'and the normalised record carries the exit status');

    assert.ok(!fs.existsSync(path.join(out, 'run1.tap')), 'the raw TAP must not outlive the normalised record');
    assert.ok(fs.existsSync(path.join(out, 'child-logs-run1')), 'the child lifecycle log is enumerated and kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an existing group-readable --out is secured or refused', { skip: process.platform === 'win32' ? 'POSIX permission bits are not meaningful on Windows; this guarantee is offered on POSIX only' : false }, () => {
  // `mkdirSync`'s mode applies only when it creates the directory, so an existing `--out` keeps
  // whatever permissions it had — and a captured run's artifacts would land in a shared directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-perm-'));
  try {
    const out = path.join(dir, 'shared');
    fs.mkdirSync(out, { recursive: true });
    fs.chmodSync(out, 0o777);

    const result = runPass(['--runs', '1', '--target', trivialTarget(dir), '--out', out]);

    assert.equal(result.status, 0, 'a securable directory is narrowed rather than refused');
    assert.equal(fs.statSync(out).mode & 0o077, 0, 'and it is owner-only before anything is written into it');
    assert.match(`${result.stdout}`, /narrowed/, 'and the narrowing is stated rather than done silently');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pass runner: an experiment that runs nothing is refused, not reported clean', () => {
  const runner = path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs');
  const attempt = (runs: string): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [runner, '--runs', runs], {
      cwd: path.resolve(DIAGNOSTICS_DIR, '../..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });

  for (const runs of ['0', '-3', 'twenty']) {
    const result = attempt(runs);
    assert.notEqual(result.status, 0, `--runs ${runs} must not exit successfully`);
    assert.match(`${result.stderr}`, /must be a positive number/, `--runs ${runs} must say why`);
    assert.doesNotMatch(
      `${result.stdout}`,
      /was not observed/,
      'an experiment that never ran must never claim the defect was not observed',
    );
  }
});

test('pass runner: a pass whose every run was unreadable is refused, not reported clean', () => {
  // The report is made unreadable by construction rather than by racing a clock: `run1.tap` is
  // pre-created as a *directory*, so the reporter cannot write it and reading it back raises
  // EISDIR. That is deterministic on every machine, needs no timeout, and leaves nothing running —
  // a fixture that instead outlived a short ceiling would leak the test-file child the runner had
  // already spawned, which survives being killed at one level up.
  //
  // `--target` points the nested run at one trivial file of this test's own making. Without it the
  // run would launch a second copy of the whole API suite against the database the suite running
  // this very test is already using.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-target-'));
  try {
    const trivial = path.join(dir, 'noop.test.cjs');
    fs.writeFileSync(trivial, "require('node:test').test('noop', () => {});\n");
    const out = path.join(dir, 'out');
    fs.mkdirSync(path.join(out, 'run1.tap'), { recursive: true });

    const result = spawnSync(
      process.execPath,
      [
        path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'),
        '--runs', '1',
        '--target', trivial,
        '--out', out,
      ],
      {
        cwd: path.resolve(DIAGNOSTICS_DIR, '../..'),
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );

    assert.notEqual(result.status, 0, 'an unreadable pass must not exit successfully');
    assert.doesNotMatch(`${result.stdout}`, /was not observed/, 'and must not claim the defect was not observed');
    assert.match(`${result.stderr}`, /observed nothing/, 'and must say the pass observed nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlator: captures a real child termination end to end through the parent reporter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-e2e-'));
  try {
    // Reproduces Signature B's exact shape: the child dies before registering a single test, so
    // the runner has no subtest failure to report and falls back to the bare 'test failed'.
    fs.writeFileSync(path.join(dir, 'dies.test.cjs'), 'process.exit(3);\n');
    const tapPath = path.join(dir, 'report.tap');
    const logDir = path.join(dir, 'child-logs');
    fs.mkdirSync(logDir, { recursive: true });

    const run = spawnSync(
      process.execPath,
      [
        '--require', PRELOAD_PATH,
        '--test-reporter=tap', `--test-reporter-destination=${tapPath}`,
        '--test', 'dies.test.cjs',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        // NODE_TEST_CONTEXT is set in this process because a test runner spawned it. Inheriting it
        // would tell the nested Node it is already a test child, so it would never act as a runner.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, SIGB_LOG_DIR: logDir },
      },
    );

    assert.notEqual(run.status, 0, 'the runner must report the file as failed');

    const records = correlator.correlate(
      correlator.parseTapFailures(fs.readFileSync(tapPath, 'utf8')),
      correlator.readChildLogs(logDir),
    );

    assert.equal(records.length, 1, 'the file-level failure is correlated');
    assert.equal(
      records[0]?.parent.exitCode,
      3,
      'the exit code the spec reporter would have discarded is recovered from the parent',
    );
    assert.equal(records[0]?.parent.signal, null, 'Windows reports no signal for a self-terminating child');
    assert.ok(typeof records[0]?.child.pid === 'number', 'the child that died is identified by PID');
    assert.ok(
      records[0]?.child.kinds.includes('process.exit'),
      'and its own log agrees with the parent about how it went',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('correlator: a missing child log from one directory is never falsely matched to a child in another directory', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-nodup-'));
  try {
    // Only bar/a.test.js logged; foo/a.test.js died before writing any log
    const lines = [
      { kind: 'start', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
      { kind: 'preload-installed', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
      { kind: 'exit', pid: 222, testFile: 'C:\\r\\dist-test\\test\\bar\\a.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-single.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent reports dist-test/test/foo/a.test.js failed.
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/foo/a.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(
      resolved[0]?.child.logFound,
      false,
      'a file in foo/ must not claim the log of a different file in bar/ just because the basename matches',
    );
    assert.equal(resolved[0]?.child.pid, null, 'no PID may be attributed to the unlogged file');
    assert.deepEqual(resolved[0]?.child.kinds, [], 'no lifecycle events may be falsely attributed');
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: classifies signed negative 32-bit NTSTATUS codes identically to unsigned equivalents', () => {
  // NTSTATUS 0xC0000005 in 32-bit signed two's complement is -1073741819 (unsigned 3221225477)
  const signedViolation = correlator.classifyTermination({ exitCode: -1073741819, signal: null });
  assert.equal(signedViolation.id, 'native-access-violation');
  assert.equal(signedViolation.specific, true);

  // Unmeasured NTSTATUS 0xC0000022 in 32-bit signed is -1073741790
  const signedUnmeasured = correlator.classifyTermination({ exitCode: -1073741790, signal: null });
  assert.equal(signedUnmeasured.id, 'ntstatus-unmeasured');
  assert.equal(signedUnmeasured.specific, false);
});

test('correlator: parses TAP failure blocks with double-quoted or unquoted YAML values', () => {
  const doubleQuoted = [
    '# Subtest: dist-test/test/foo.test.js',
    'not ok 1 - dist-test/test/foo.test.js',
    '  ---',
    '  duration_ms: 123.4',
    '  failureType: "testCodeFailure"',
    '  exitCode: 1',
    '  signal: ~',
    '  error: "test failed"',
    '  code: "ERR_TEST_FAILURE"',
    '  ...',
  ].join('\n');

  const unquoted = [
    '# Subtest: dist-test/test/bar.test.js',
    'not ok 2 - dist-test/test/bar.test.js',
    '  ---',
    '  duration_ms: 234.5',
    '  failureType: testCodeFailure',
    '  exitCode: 134',
    '  signal: ~',
    '  error: test failed',
    '  code: ERR_TEST_FAILURE',
    '  ...',
  ].join('\n');

  const dqFailures = correlator.parseTapFailures(doubleQuoted);
  assert.equal(dqFailures.length, 1);
  assert.equal(dqFailures[0]?.file, 'dist-test/test/foo.test.js');
  assert.equal(dqFailures[0]?.exitCode, 1);
  assert.equal(dqFailures[0]?.failureType, 'testCodeFailure');

  const uqFailures = correlator.parseTapFailures(unquoted);
  assert.equal(uqFailures.length, 1);
  assert.equal(uqFailures[0]?.file, 'dist-test/test/bar.test.js');
  assert.equal(uqFailures[0]?.exitCode, 134);
  assert.equal(uqFailures[0]?.failureType, 'testCodeFailure');

  const singleQuoted = [
    '# Subtest: dist-test/test/baz.test.js',
    'not ok 3 - dist-test/test/baz.test.js',
    '  ---',
    '  duration_ms: \'345.6\'',
    '  failureType: \'testCodeFailure\'',
    '  exitCode: \'1\'',
    '  signal: ~',
    '  error: \'test failed\'',
    '  code: \'ERR_TEST_FAILURE\'',
    '  ...',
  ].join('\n');

  const sqFailures = correlator.parseTapFailures(singleQuoted);
  assert.equal(sqFailures.length, 1);
  assert.equal(sqFailures[0]?.file, 'dist-test/test/baz.test.js');
  assert.equal(sqFailures[0]?.exitCode, 1);
  assert.equal(sqFailures[0]?.durationMs, 345.6);
  assert.equal(sqFailures[0]?.failureType, 'testCodeFailure');
});

test('correlator: path suffix matching for Windows-origin paths is case-insensitive across platforms', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-case-'));
  try {
    const lines = [
      { kind: 'start', pid: 333, testFile: 'C:\\Repo\\Dist-Test\\Test\\Studies-Api.Test.js' },
      { kind: 'preload-installed', pid: 333, testFile: 'C:\\Repo\\Dist-Test\\Test\\Studies-Api.Test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-case.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const logs = correlator.readChildLogs(logDir);

    // Parent uses lower-case path
    const resolved = correlator.correlate(
      correlator.parseTapFailures(tapFailure('dist-test/test/studies-api.test.js', '1')),
      logs,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.child.pid, 333, 'casing difference must not prevent matching for Windows-origin paths');
    assert.equal(resolved[0]?.child.logFound, true);
    assert.equal(resolved[0]?.child.ambiguous, false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('correlator: isWindowsPath identifies Windows drive letters and UNC paths', () => {
  assert.equal(correlator.isWindowsPath('C:/repo/test.js'), true);
  assert.equal(correlator.isWindowsPath('d:/repo/test.js'), true);
  assert.equal(correlator.isWindowsPath('//server/share/test.js'), true);
  if (process.platform !== 'win32') {
    assert.equal(correlator.isWindowsPath('/home/runner/repo/test.js'), false);
    assert.equal(correlator.isWindowsPath('dist-test/test.js'), false);
  } else {
    assert.equal(correlator.isWindowsPath('/any/path'), true);
  }
});
