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
  };
  readonly activeResources?: Record<string, number> | null;
}

/**
 * Executes a synthetic test script under the diagnostic preload in an isolated temporary directory.
 * Explicit diagnostic integration runner for real native abort validation.
 *
 * @param {string} code - JavaScript code to execute in the child process.
 * @param {Record<string, string>} [envOverride] - Optional environment variables to override.
 * @returns {{ status: number | null, signal: NodeJS.Signals | null, logDir: string, records: readonly DiagnosticRecord[] }}
 */
function runDiagnosticChild(
  code: string,
  envOverride: Record<string, string> = {},
): {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly logDir: string;
  readonly records: readonly DiagnosticRecord[];
} {
  const generatedLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigb-abort-diag-'));
  const targetLogDir = envOverride.SIGB_LOG_DIR ? path.resolve(envOverride.SIGB_LOG_DIR) : generatedLogDir;
  const scriptPath = path.join(generatedLogDir, 'abort-target.cjs');
  fs.writeFileSync(scriptPath, code, 'utf8');

  const args = ['--require', PRELOAD_PATH, scriptPath];
  const env = {
    ...process.env,
    ...envOverride,
    SIGB_LOG_DIR: targetLogDir,
  };

  const result =
    process.platform !== 'win32'
      ? spawnSync('sh', ['-c', 'ulimit -c 0 2>/dev/null; exec "$@"', 'sh', process.execPath, ...args], {
          cwd: generatedLogDir,
          env,
          encoding: 'utf8',
          windowsHide: true,
        })
      : spawnSync(process.execPath, args, {
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
    logDir: generatedLogDir,
    records,
  };
}

test('explicit diagnostic integration: real native process.abort() records synchronous diagnostic before termination', (t) => {
  const { status, signal, records, logDir } = runDiagnosticChild(`
    process.abort();
  `);
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  // On Windows/POSIX, abort causes abnormal termination
  assert.ok(status !== 0 || signal !== null, 'process terminates abnormally');
  assert.ok(records.some((r) => r.kind === 'preload-installed'), 'records preload-installed');
  const abortRecord = records.find((r) => r.kind === 'process.abort');
  assert.ok(abortRecord, 'synchronously records process.abort event');
  assert.ok(typeof abortRecord?.callerStack === 'string', 'includes callerStack in abort record');
  assert.ok(abortRecord?.callerStack?.includes('abort-call-site'), 'callerStack traces abort invocation site');

  // Verify process.on('exit') does NOT fire on process.abort()
  const exitRecord = records.find((r) => r.kind === 'exit');
  assert.equal(exitRecord, undefined, 'exit event must not fire on process.abort');
});
