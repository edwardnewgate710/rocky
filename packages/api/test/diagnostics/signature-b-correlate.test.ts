import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIAGNOSTICS_DIR = path.resolve(__dirname, '../../../test/diagnostics');
const CORRELATE_PATH = path.join(DIAGNOSTICS_DIR, 'signature-b-correlate.cjs');
const PRELOAD_PATH = path.join(DIAGNOSTICS_DIR, 'signature-b-preload.cjs');

/* eslint-disable @typescript-eslint/no-var-requires */
const correlator = require(CORRELATE_PATH) as {
  EXIT_CODE_TABLE: ReadonlyArray<{ code: number; id: string; conclusive: boolean }>;
  MAX_RECORDS: number;
  classifyTermination(t: { exitCode: number | null; signal: string | null }): {
    id: string;
    meaning: string;
    conclusive: boolean;
  };
  correlate(failures: unknown[], childLogs: Map<string, unknown>): Array<Record<string, never>>;
  narrowFromChildEvidence(
    c: { id: string; conclusive: boolean },
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
    'native-ntstatus',
    'an unlisted 0xC0000000-range code is still recognisably a native fault',
  );
});

test('correlator: names the signal that killed a child but never claims who sent it', () => {
  // Node's exit contract reports the signal, not its sender, so an external SIGKILL on Linux is
  // indistinguishable here from a runner cancellation. Attributing one would be the same
  // unsupported leap this module refuses to make for exit code 1.
  const classification = correlator.classifyTermination({ exitCode: null, signal: 'SIGKILL' });

  assert.equal(classification.id, 'signal-terminated');
  assert.equal(classification.conclusive, false, 'the mechanism is known; the actor is not');
  assert.match(classification.meaning, /SIGKILL/);
  assert.doesNotMatch(classification.meaning, /the test runner killed/, 'no sender may be named');
});

test('correlator: refuses to identify exit code 1, which four different causes produce', () => {
  const classification = correlator.classifyTermination({ exitCode: 1, signal: null });

  assert.equal(classification.id, 'inconclusive');
  assert.equal(classification.conclusive, false, 'claiming a cause from exit code 1 would be the wrong answer');
});

test('correlator: an unrun JS exit path narrows an inconclusive code without identifying it', () => {
  const inconclusive = { id: 'inconclusive', conclusive: false };

  const silent = correlator.narrowFromChildEvidence(inconclusive, ['start', 'preload-installed']);
  assert.equal(silent.narrowed, true);
  assert.match(silent.statement, /excludes process\.exit and an uncaught exception/);

  const exited = correlator.narrowFromChildEvidence(inconclusive, ['start', 'preload-installed', 'exit']);
  assert.equal(exited.narrowed, false, 'a child that ran an exit path explains itself');

  const nothing = correlator.narrowFromChildEvidence(inconclusive, []);
  assert.equal(nothing.narrowed, false, 'no child log is no evidence');
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
    ) as unknown as Array<{
      child: { pid: number | null; kinds: string[]; logFound: boolean };
      parent: { exitCode: number | null };
      classification: string;
      narrowed: boolean;
    }>;

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
  // A capture is taken on the developer machine and may be read anywhere, CI included. `path.basename`
  // splits only on the host's separator, so a Windows log read on Linux would yield the whole path as
  // its own key and join nothing — which is exactly how CI caught this.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-sep-'));
  try {
    const lines = [
      { kind: 'start', pid: 111, testFile: 'C:\\repo\\dist-test\\test\\windows-style.test.js' },
      { kind: 'start', pid: 222, testFile: '/home/runner/repo/dist-test/test/posix-style.test.js' },
    ];
    fs.writeFileSync(path.join(logDir, 'run-3.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const logs = correlator.readChildLogs(logDir);

    assert.equal(logs.get('windows-style.test.js')?.pid, 111, 'a backslash path keys on its last segment');
    assert.equal(logs.get('posix-style.test.js')?.pid, 222, 'so does a forward-slash path');
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
  // A wall-clock ceiling smaller than a single run makes the child time out, so the run yields no
  // readable report. The pass observed nothing and must say so rather than print the same summary
  // as a quiet one — the failure mode the ceiling and the collection check exist to prevent.
  //
  // `--target` points the nested run at one trivial file. Without it the run would launch a second
  // copy of the whole API suite against the same database as the suite running this very test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-target-'));
  try {
    const trivial = path.join(dir, 'noop.test.cjs');
    fs.writeFileSync(trivial, "require('node:test').test('noop', () => {});\n");

    const result = spawnSync(
      process.execPath,
      [
        path.join(DIAGNOSTICS_DIR, 'run-signature-b-pass.mjs'),
        '--runs', '5',
        '--max-minutes', '0.0001',
        '--target', trivial,
        '--out', path.join(dir, 'out'),
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
    ) as unknown as Array<{
      parent: { exitCode: number | null; signal: string | null };
      child: { pid: number | null; kinds: string[] };
    }>;

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
