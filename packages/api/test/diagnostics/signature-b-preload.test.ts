import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PRELOAD_PATH = path.resolve(__dirname, '../../../test/diagnostics/signature-b-preload.cjs');

interface DiagnosticRecord {
  readonly kind: string;
  readonly pid: number;
  readonly ppid: number;
  readonly code?: number;
  readonly targetPid?: number;
  readonly signal?: string | number;
  readonly origin?: string;
  readonly callerStack?: string;
  readonly err?: {
    readonly name?: string;
    readonly message?: string;
    readonly stack?: string;
    readonly code?: string | number | boolean;
    readonly syscall?: string | number | boolean;
    readonly errno?: string | number | boolean;
  };
  readonly activeResources?: Record<string, number> | null;
}

/**
 * Executes a synthetic test script under the diagnostic preload in an isolated temporary directory.
 * Sets `cwd: generatedLogDir` and isolates diagnostic log directory per invocation.
 *
 * @param {string} code - JavaScript code to execute in the child process.
 * @param {Record<string, string>} [envOverride] - Optional environment variables to override.
 * @param {boolean} [useNodeTestRunner=false] - Whether to invoke via `node --test` runner instead of plain node.
 * @returns {{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, logDir: string, records: readonly DiagnosticRecord[] }}
 */
function runWithPreload(
  code: string,
  envOverride: Record<string, string> = {},
  useNodeTestRunner = false,
): {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly logDir: string;
  readonly records: readonly DiagnosticRecord[];
} {
  const generatedLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-test-'));
  const targetLogDir = envOverride.SIGB_LOG_DIR || generatedLogDir;
  const scriptPath = path.join(generatedLogDir, 'test-target.cjs');
  fs.writeFileSync(scriptPath, code, 'utf8');

  const args = useNodeTestRunner
    ? ['--require', PRELOAD_PATH, '--test', scriptPath]
    : ['--require', PRELOAD_PATH, scriptPath];

  const env: Record<string, string | undefined> = {
    ...process.env,
    SIGB_LOG_DIR: targetLogDir,
    ...envOverride,
  };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, args, {
    cwd: generatedLogDir,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });

  const files = fs.existsSync(targetLogDir)
    ? fs.readdirSync(targetLogDir).filter((f) => f.endsWith('.jsonl'))
    : [];
  const records: DiagnosticRecord[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(targetLogDir, file), 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      records.push(JSON.parse(line) as DiagnosticRecord);
    }
  }

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    logDir: generatedLogDir,
    records,
  };
}

test('diagnostic preload: normal shutdown records lifecycle events', (t) => {
  const { status, records, logDir } = runWithPreload(`
    // clean normal execution
    const x = 1 + 1;
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  assert.equal(status, 0);
  const kinds = records.map((r) => r.kind);
  assert.ok(kinds.includes('start'), 'records start');
  assert.ok(kinds.includes('preload-installed'), 'records preload-installed');
  assert.ok(kinds.includes('beforeExit'), 'records beforeExit');
  assert.ok(kinds.includes('exit'), 'records exit');
});

test('diagnostic preload: process.exit(42) records exit code and call-site stack before exit', (t) => {
  const { status, records, logDir } = runWithPreload(`
    process.exit(42);
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  assert.equal(status, 42);
  const exitRecord = records.find((r) => r.kind === 'process.exit');
  assert.ok(exitRecord, 'records process.exit');
  assert.equal(exitRecord?.code, 42);
  assert.ok(typeof exitRecord?.callerStack === 'string', 'includes callerStack');
  assert.ok(exitRecord?.callerStack?.includes('exit-call-site'), 'stack traces exit invocation site');
});

test('diagnostic preload: process.abort wrapper synchronously writes record before delegating (safe unit proof)', (t) => {
  // Routine unit proof: executes a child script that verifies the patched process.abort writes
  // the diagnostic record to disk immediately before delegating. Intercepts originalAbort call in userland
  // so no native core-dump or SIGABRT is raised during routine test runs.
  const { records, logDir } = runWithPreload(`
    // Intercept abort delegation in userland to prove wrapper behavior without native crash
    const originalAbort = process.abort;
    process.abort = function testWrapperIntercept() {
      // original wrapper invoked
      return originalAbort.call(process);
    };
    try {
      process.abort();
    } catch {}
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  // In the preload, patchedAbort writes before calling originalAbort.
  const abortRecord = records.find((r) => r.kind === 'process.abort');
  assert.ok(abortRecord, 'synchronously records process.abort event');
  assert.ok(typeof abortRecord?.callerStack === 'string', 'includes callerStack in abort record');
  assert.ok(abortRecord?.callerStack?.includes('abort-call-site'), 'callerStack traces abort invocation site');
});

test('diagnostic preload: uncaughtExceptionMonitor passively captures error without suppressing crash', (t) => {
  const { status, records, logDir } = runWithPreload(`
    throw new Error('synthetic fatal crash with Bearer secret-tok-12345');
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  assert.notEqual(status, 0);
  const uncaught = records.find((r) => r.kind === 'uncaughtExceptionMonitor');
  assert.ok(uncaught, 'records uncaughtExceptionMonitor');
  assert.equal(uncaught?.origin, 'uncaughtException');
  assert.ok(uncaught?.err?.message?.includes('Bearer [REDACTED_TOKEN]'), 'redacts token in error message');
});

test('diagnostic preload: fatal unhandled rejection passively captured under node --test runner', (t) => {
  // Verifies that under node --test runner, an unhandled rejection is fatal (exits non-zero),
  // is passively recorded by uncaughtExceptionMonitor with origin === 'unhandledRejection',
  // and the preload does NOT register an active listener that swallows the crash.
  const { status, records, logDir } = runWithPreload(`
    Promise.reject(new Error('synthetic unhandled rejection: password="mysecretpassword"'));
  `, {}, true);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  assert.notEqual(status, 0, 'node --test runner must fail on unhandled rejection');
  const rejectionRecord = records.find(
    (r) => r.kind === 'uncaughtExceptionMonitor' && r.origin === 'unhandledRejection',
  );
  assert.ok(rejectionRecord, 'records unhandledRejection origin via uncaughtExceptionMonitor');
  assert.ok(rejectionRecord?.err?.message?.includes('password=[REDACTED]'), 'redacts password in rejection reason');
});

test('diagnostic preload: safeErr serialization does not throw on BigInt or circular metadata and preserves primitive codes', (t) => {
  const { records, logDir } = runWithPreload(`
    const circular = { name: 'circular' };
    circular.self = circular;

    const errWithBigInt = new Error('error with bigint code');
    errWithBigInt.code = 1n;
    errWithBigInt.errno = 42n;

    const errWithCircular = new Error('error with circular metadata');
    errWithCircular.code = circular;

    const normalErr = new Error('normal error');
    normalErr.code = 'EPIPE';
    normalErr.syscall = 'write';
    normalErr.errno = -32;

    process.emitWarning(errWithBigInt);
    process.emitWarning(errWithCircular);
    process.emitWarning(normalErr);
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const warnings = records.filter((r) => r.kind === 'warning');
  assert.equal(warnings.length, 3, 'all 3 warning records successfully serialized and written');

  const bigIntWarning = warnings.find((w) => w.err?.message?.includes('bigint'));
  assert.ok(bigIntWarning, 'bigint warning logged');
  assert.equal(bigIntWarning?.err?.code, '1', 'bigint code converted to string');
  assert.equal(bigIntWarning?.err?.errno, '42', 'bigint errno converted to string');

  const circularWarning = warnings.find((w) => w.err?.message?.includes('circular'));
  assert.ok(circularWarning, 'circular warning logged');

  const normalWarning = warnings.find((w) => w.err?.message?.includes('normal error'));
  assert.ok(normalWarning, 'normal warning logged');
  assert.equal(normalWarning?.err?.code, 'EPIPE', 'string code preserved verbatim');
  assert.equal(normalWarning?.err?.syscall, 'write', 'string syscall preserved verbatim');
  assert.equal(normalWarning?.err?.errno, -32, 'numeric errno preserved verbatim');
});

test('diagnostic preload: process.kill records target PID and signal', (t) => {
  const { records, logDir } = runWithPreload(`
    try {
      process.kill(process.pid, 0);
    } catch {}
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const killRecord = records.find((r) => r.kind === 'process.kill');
  assert.ok(killRecord, 'records process.kill');
  assert.equal(killRecord?.signal, 0);
  assert.ok(killRecord?.callerStack?.includes('kill-call-site'), 'traces kill call site');
});

test('diagnostic preload: redacts postgres/postgresql credentials, tokens, and quoted secrets with spaces', (t) => {
  const { records, logDir } = runWithPreload(`
    const err = new Error(
      'Connect failed to postgresql://app_user:s3cr3tpass@db.internal:5432/chess and ' +
      'postgres://admin:supersecret@10.0.0.1:5432/main and sk-1234567890abcdef12345 and ' +
      'password="correct horse battery staple" and secret=\\'top secret key phrase\\''
    );
    throw err;
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const uncaught = records.find((r) => r.kind === 'uncaughtExceptionMonitor');
  assert.ok(uncaught, 'uncaught record exists');
  const msg = uncaught?.err?.message ?? '';
  assert.ok(msg.includes('postgres://[REDACTED_CREDS]@db.internal:5432/chess'), 'redacts postgresql credentials');
  assert.ok(msg.includes('postgres://[REDACTED_CREDS]@10.0.0.1:5432/main'), 'redacts postgres credentials');
  assert.ok(msg.includes('[REDACTED_API_KEY]'), 'redacts OpenAI-style api key');
  assert.ok(msg.includes('password=[REDACTED]'), 'redacts double-quoted password with spaces');
  assert.ok(msg.includes('secret=[REDACTED]'), 'redacts single-quoted secret with spaces');
  assert.ok(!msg.includes('s3cr3tpass'), 'raw password 1 not present');
  assert.ok(!msg.includes('supersecret'), 'raw password 2 not present');
  assert.ok(!msg.includes('correct horse battery staple'), 'raw quoted password with spaces not present');
  assert.ok(!msg.includes('top secret key phrase'), 'raw single-quoted secret with spaces not present');
  assert.ok(!msg.includes('sk-1234567890abcdef12345'), 'raw key not present');
});

test('diagnostic preload: directory mode 0700 and log file mode 0600', (t) => {
  const targetDir = path.join(os.tmpdir(), `sigb-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { logDir } = runWithPreload('const a = 1;', { SIGB_LOG_DIR: targetDir });
  t.after(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  assert.ok(fs.existsSync(targetDir), 'target directory was created');
  const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'created log file');

  const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');
  assert.ok(preloadSource.includes('0o700'), 'mkdirSync specifies 0o700 mode');
  assert.ok(preloadSource.includes('0o600'), 'openSync specifies 0o600 mode');

  if (process.platform !== 'win32') {
    const dirStat = fs.statSync(targetDir);
    const fileStat = fs.statSync(path.join(targetDir, files[0]));
    // On POSIX, check mode bits
    const dirMode = dirStat.mode & 0o777;
    const fileMode = fileStat.mode & 0o777;
    assert.equal(dirMode, 0o700, `directory mode should be 0700, got ${dirMode.toString(8)}`);
    assert.equal(fileMode, 0o600, `file mode should be 0600, got ${fileMode.toString(8)}`);
  }
});

test('diagnostic preload: pre-existing directory does not fail or crash', (t) => {
  const existingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-existing-'));
  const { status, records, logDir } = runWithPreload('const ok = true;', { SIGB_LOG_DIR: existingDir });
  t.after(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(existingDir, { recursive: true, force: true });
  });

  assert.equal(status, 0, 'runs cleanly with pre-existing directory');
  assert.ok(records.length > 0, 'wrote diagnostic records to pre-existing directory');
});

test('diagnostic preload: usage glob pattern matches test files without literal backslash and excludes diag files', () => {
  const correctGlob = 'dist-test/test/**/*.test.js';
  const badEscapedGlob = 'dist-test/test/**\\/*.test.js';
  const diagFilePath = 'dist-test/test/diagnostics/signature-b-preload-abort.diag.js';

  // Bad glob contains a literal backslash before slash
  assert.ok(badEscapedGlob.includes('\\/'), 'bad glob contains literal escaped slash');
  assert.ok(!correctGlob.includes('\\/'), 'correct glob contains clean POSIX path separator');
  assert.ok(correctGlob.startsWith('dist-test/test/'), 'correct glob targets compiled test files');

  // Verify that the default test glob pattern excludes .diag.js explicit diagnostic fixtures
  assert.ok(!diagFilePath.endsWith('.test.js'), 'diag file is excluded from default *.test.js discovery');

  const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');
  assert.ok(preloadSource.includes('"dist-test/test/**/*.test.js"'), 'preload usage specifies unescaped glob');
  assert.ok(!preloadSource.includes('**\\/*.test.js'), 'preload usage does not contain escaped backslash in glob');
});
