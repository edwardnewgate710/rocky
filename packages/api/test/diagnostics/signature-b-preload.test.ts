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
  readonly testFile?: string | null;
  readonly nodeTestContext?: string | null;
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

interface RunChildOptions {
  readonly extraPreloads?: (dir: string) => readonly string[];
  readonly useNodeTestRunner?: boolean;
}

/**
 * Internal runner that executes a synthetic child script under the diagnostic preload
 * in an isolated temporary directory with optional extra preload hooks.
 */
function runChild(
  code: string,
  envOverride: Record<string, string> = {},
  options: RunChildOptions = {},
): {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly logDir: string;
  readonly records: readonly DiagnosticRecord[];
} {
  const generatedLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-test-'));
  const rawLogDir = envOverride.SIGB_LOG_DIR;
  const targetLogDir = rawLogDir
    ? path.resolve(generatedLogDir, rawLogDir)
    : generatedLogDir;
  const scriptPath = path.join(generatedLogDir, 'test-target.cjs');
  fs.writeFileSync(scriptPath, code, 'utf8');

  const extraPreloads = options.extraPreloads ? options.extraPreloads(generatedLogDir) : [];
  const preloads = [...extraPreloads, PRELOAD_PATH];
  const args = preloads.flatMap((p) => ['--require', p]);
  if (options.useNodeTestRunner) {
    args.push('--test');
  }
  args.push(scriptPath);

  const env: Record<string, string | undefined> = {
    ...process.env,
    SIGB_LOG_DIR: rawLogDir ?? targetLogDir,
  };
  delete env.NODE_TEST_CONTEXT;
  for (const [k, v] of Object.entries(envOverride)) {
    env[k] = v;
  }

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
) {
  return runChild(code, envOverride, { useNodeTestRunner });
}

/**
 * Executes a synthetic child script with a test-only safe abort shim loaded BEFORE the real preload.
 *
 * Execution order:
 * 1. `safe-abort-shim.cjs` replaces native `process.abort` with a harmless sentinel that logs to stdout and calls `process.exit(99)`.
 * 2. `signature-b-preload.cjs` loads second, capturing the sentinel function as `originalAbort` and installing `patchedAbort`.
 * 3. The child script runs and calls `process.abort()`.
 * 4. `patchedAbort` synchronously writes the `process.abort` JSONL diagnostic record and delegates to `originalAbort`.
 * 5. The harmless sentinel runs and calls `process.exit(99)`, preventing native `process.abort()` / OS crash dumps.
 */
function runWithSafeAbortShimAndPreload(
  code: string,
  envOverride: Record<string, string> = {},
) {
  return runChild(code, envOverride, {
    extraPreloads: (dir: string) => {
      const shimPath = path.join(dir, 'safe-abort-shim.cjs');
      fs.writeFileSync(
        shimPath,
        `
          const fs = require('node:fs');
          process.abort = function harmlessSentinelAbort(...args) {
            fs.writeSync(1, '__SAFE_ABORT_SENTINEL_INVOKED__\\n');
            process.exit(99);
          };
        `,
        'utf8',
      );
      return [shimPath];
    },
  });
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

test('diagnostic preload: process.abort wrapper synchronously writes record and delegates at runtime without native abort', (t) => {
  // Safe runtime execution test:
  // 1. safe-abort-shim.cjs preloads first and overrides native process.abort with harmless sentinel.
  // 2. signature-b-preload.cjs preloads second, capturing the sentinel as originalAbort and installing patchedAbort.
  // 3. Child script calls process.abort().
  // 4. patchedAbort synchronously writes the JSONL diagnostic record to SIGB_LOG_DIR before delegating to the sentinel.
  // 5. Sentinel receives delegation and exits with status 99.
  // 6. Child process does NOT execute native abort (no core dumps or OS crash handlers).
  const { status, signal, stdout, records, logDir } = runWithSafeAbortShimAndPreload(`
    // Verify runtime wrapper identity before calling
    if (process.abort.name !== 'patchedAbort') {
      process.exit(101);
    }
    // Call process.abort()
    process.abort();
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  // Process exited cleanly via harmless sentinel delegation
  assert.equal(signal, null, 'must not be terminated by signal');
  assert.equal(status, 99, 'harmless sentinel was executed via originalAbort delegation');
  assert.ok(stdout.includes('__SAFE_ABORT_SENTINEL_INVOKED__'), 'sentinel output verified on stdout');

  // Preload lifecycle and abort records were written
  const kinds = records.map((r) => r.kind);
  assert.ok(kinds.includes('start'), 'records start');
  assert.ok(kinds.includes('preload-installed'), 'records preload-installed');
  const abortRecord = records.find((r) => r.kind === 'process.abort');
  assert.ok(abortRecord, 'synchronously records process.abort event to JSONL');
  assert.ok(typeof abortRecord?.callerStack === 'string', 'includes callerStack in abort record');
  assert.ok(abortRecord?.callerStack?.includes('test-target'), 'callerStack traces abort invocation site');
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
  assert.ok(warnings.length >= 3, 'all 3 emitted warning records successfully serialized and written');

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

test('diagnostic preload: redacts postgres/postgresql credentials, tokens, Authorization headers, cookies, and quoted secrets with spaces or escaped quotes', (t) => {
  const { records, logDir } = runWithPreload(`
    const parts = [
      'Connect failed to postgresql://app_user:s3cr3tpass@db.internal:5432/chess',
      'postgres://admin:supersecret@10.0.0.1:5432/main',
      'sk-1234567890abcdef12345',
      'password="correct \\\\\\"horse\\\\\\" battery staple"',
      "secret='top \\\\\\'secret\\\\\\' key phrase'",
      'Authorization: Basic dXNlcjpwYXNzd29yZA==,',
      'Cookie: session=xyz123; token=abc456; other=789',
    ];
    const err = new Error(parts.join(' and '));
    err.name = 'CustomError password="supersecretname"';
    throw err;
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const uncaught = records.find((r) => r.kind === 'uncaughtExceptionMonitor');
  assert.ok(uncaught, 'uncaught record exists');
  const msg = uncaught?.err?.message ?? '';
  const errName = uncaught?.err?.name ?? '';
  assert.ok(errName.includes('password=[REDACTED]'), 'redacts password in error name');
  assert.ok(!errName.includes('supersecretname'), 'raw password not present in error name');
  assert.ok(msg.includes('postgres://[REDACTED_CREDS]@db.internal:5432/chess'), 'redacts postgresql credentials');
  assert.ok(msg.includes('postgres://[REDACTED_CREDS]@10.0.0.1:5432/main'), 'redacts postgres credentials');
  assert.ok(msg.includes('[REDACTED_API_KEY]'), 'redacts OpenAI-style api key');
  assert.ok(msg.includes('password=[REDACTED]'), 'redacts double-quoted password with escaped quotes');
  assert.ok(msg.includes('secret=[REDACTED]'), 'redacts single-quoted secret with escaped quotes');
  assert.ok(msg.includes('Authorization=[REDACTED]'), 'redacts Basic authorization header');
  assert.ok(msg.includes('Cookie=[REDACTED]'), 'redacts multi-cookie header');
  assert.ok(!msg.includes('s3cr3tpass'), 'raw password 1 not present');
  assert.ok(!msg.includes('supersecret'), 'raw password 2 not present');
  assert.ok(!msg.includes('horse'), 'raw quoted password content with escaped quotes not present');
  assert.ok(!msg.includes('key phrase'), 'raw single-quoted secret content with escaped quotes not present');
  assert.ok(!msg.includes('dXNlcjpwYXNzd29yZA=='), 'raw basic auth credential not present');
  assert.ok(!msg.includes('session=xyz123'), 'raw cookie session not present');
  assert.ok(!msg.includes('token=abc456'), 'raw cookie token not present');
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

test('diagnostic preload: relative SIGB_LOG_DIR resolves correctly', (t) => {
  const relDir = `./tmp-sigb-rel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { records, logDir } = runWithPreload('const relOk = true;', { SIGB_LOG_DIR: relDir });
  const absDir = path.resolve(logDir, relDir);
  t.after(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(absDir, { recursive: true, force: true });
  });

  assert.ok(fs.existsSync(absDir), 'creates directory at resolved relative path in child cwd');
  assert.ok(records.length > 0, 'reads child diagnostic records from relative SIGB_LOG_DIR');
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

test('diagnostic preload: captures testFile when NODE_TEST_CONTEXT is "child" or "child-v8"', (t) => {
  const childRun = runWithPreload('const ok = true;', { NODE_TEST_CONTEXT: 'child' });
  t.after(() => fs.rmSync(childRun.logDir, { recursive: true, force: true }));

  const childRecord = childRun.records.find((r) => r.kind === 'preload-installed');
  assert.ok(childRecord, 'preload-installed record exists for child context');
  assert.equal(childRecord?.nodeTestContext, 'child', 'records nodeTestContext');
  assert.ok(typeof childRecord?.testFile === 'string', 'testFile is a string for child context');
  assert.ok(childRecord?.testFile?.includes('test-target.cjs'), 'testFile captures script path for child context');

  const v8Run = runWithPreload('const ok = true;', { NODE_TEST_CONTEXT: 'child-v8' });
  t.after(() => fs.rmSync(v8Run.logDir, { recursive: true, force: true }));

  const v8Record = v8Run.records.find((r) => r.kind === 'preload-installed');
  assert.ok(v8Record, 'preload-installed record exists for child-v8 context');
  assert.equal(v8Record?.nodeTestContext, 'child-v8', 'records nodeTestContext');
  assert.ok(typeof v8Record?.testFile === 'string', 'testFile is a string for child-v8 context');
  assert.ok(v8Record?.testFile?.includes('test-target.cjs'), 'testFile captures script path for child-v8 context');

  const rootRun = runWithPreload('const ok = true;');
  t.after(() => fs.rmSync(rootRun.logDir, { recursive: true, force: true }));

  const rootRecord = rootRun.records.find((r) => r.kind === 'preload-installed');
  assert.ok(rootRecord, 'preload-installed record exists for root context');
  assert.equal(rootRecord?.nodeTestContext, null, 'nodeTestContext is null for non-runner process');
  assert.equal(rootRecord?.testFile, null, 'testFile is null for non-runner process');
});

