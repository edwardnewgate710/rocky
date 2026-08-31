'use strict';
/**
 * Diagnostic preload for the "Signature B" node:test failure (docs/adr/0140
 * §4): a test file occasionally fails with a bare `'test failed'`, no
 * assertion, no stack, and none of that file's own tests reported. Node's
 * test runner spawns one child process per file; that exact message is its
 * own hardcoded fallback (`ERR_TEST_FAILURE('test failed', kTestCodeFailure)`
 * with `stack: undefined`) for when a child exits non-zero or signaled while
 * no subtest recorded a failure — see `internal/test_runner/runner.js`.
 *
 * This module distinguishes the JS-catchable causes of that shape
 * (`process.exit`, `process.abort`, an uncaught exception, a fatal unhandled
 * rejection promoted by Node, an EventEmitter `'error'` event with no listener)
 * from an external, uncatchable termination of the child (an OS-level kill or native crash),
 * by hooking process-level lifecycle events and writing what fired to a structured log.
 *
 * Passive fatal rejection observation: Deliberately does NOT register active
 * `unhandledRejection` or `rejectionHandled` listeners, because in Node.js
 * attaching an `unhandledRejection` listener alters runtime semantics and suppresses
 * default fatal crash behavior. Instead, `uncaughtExceptionMonitor` is registered
 * to passively observe both `origin === 'uncaughtException'` and `origin === 'unhandledRejection'`
 * without changing process exit codes or suppressing crash paths.
 *
 * Set SIGB_LOG_DIR to control where logs land (defaults under the OS temp
 * dir). Logs are structured JSONL, one line per event, one file per child
 * process. Nothing is written to stdout/stderr, so the test reporter's own
 * output is never touched.
 *
 * Does not log request bodies, Authorization headers, cookie values, raw
 * connection strings, or password hashes — see `redact`/`safeErr` below.
 *
 * Deliberately does NOT patch `EventEmitter.prototype.emit`. An earlier
 * version did, to catch an unlistened `'error'` event before Node re-raises
 * it; verified empirically to corrupt node:test's own internal `TestsStream`
 * (itself an EventEmitter) and crash the PARENT `node --test` process on a
 * trivial passing test with no Signature-B-related content at all —
 * `--require` loads into every node process spawned with that flag,
 * including the top-level runner, not just its per-file children. A global
 * prototype patch is not a safe way to observe this system. An unhandled
 * `'error'` event still surfaces below via `uncaughtExceptionMonitor`,
 * Node's own re-raise of it, just without the emitter's constructor name.
 */

// Usage (manual, not wired into `npm test`; run from packages/api):
//   node --require ./test/diagnostics/signature-b-preload.cjs \
//     --test --test-concurrency=1 "dist-test/test/**/*.test.js"

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = process.env.SIGB_LOG_DIR || path.join(os.tmpdir(), 'sigb-diag');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* best-effort; missing dir just drops logging */
}
const LOG_FILE = path.join(LOG_DIR, `run-${process.pid}-${Date.now()}.jsonl`);
let fd;
try {
  fd = fs.openSync(LOG_FILE, 'a', 0o600);
} catch {
  fd = null;
}

const REDACT_PATTERNS = [
  [/sk-[a-zA-Z0-9_-]{10,}/g, '[REDACTED_API_KEY]'],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED_TOKEN]'],
  [/(?:postgres|postgresql):\/\/[^:]+:[^@]+@/g, 'postgres://[REDACTED_CREDS]@'],
  [/(["']?)(password(?:[_\s-]?hash|Hash)?|secret|token|authorization|cookie)\1\s*[:=]\s*(?:\[(?:[^\]\\]|\\.)*\]|\{(?:[^\}\\]|\\.)*\}|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n}]+)/gi, '$1$2$1=[REDACTED]'],
];

/**
 * Redacts known sensitive patterns (API keys, bearer tokens, credentials, passwords)
 * from strings before writing to diagnostic logs.
 *
 * @param {unknown} value - The input value to redact.
 * @returns {unknown} The sanitized value with sensitive patterns replaced by redaction placeholders.
 */
function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [pattern, replacement] of REDACT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Safely normalizes error metadata values (code, syscall, errno) into a JSON-safe primitive or string.
 * Prevents BigInt, circular references, or large object metadata from breaking diagnostic serialization.
 *
 * @param {unknown} val - The metadata value to normalize.
 * @returns {string | number | boolean | null | undefined} A JSON-safe primitive representation.
 */
function normalizeMeta(val) {
  if (val == null) return val;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  if (typeof val === 'bigint') return String(val);
  try {
    return redact(String(val));
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

/**
 * Safely serializes an Error or error-like object into a redacted, JSON-safe structure.
 * Prevents circular reference crashes, BigInt serialization failures, and strips credentials.
 *
 * @param {unknown} err - The error or rejection value to serialize.
 * @returns {unknown} A serialized error object or redacted primitive.
 */
function safeErr(err) {
  if (err == null) return err;
  if (typeof err !== 'object') {
    if (typeof err === 'bigint') return String(err);
    return redact(String(err));
  }
  try {
    return {
      name: typeof err.name === 'string' ? redact(err.name) : undefined,
      message: redact(String(err.message ?? '')),
      stack: redact(String(err.stack ?? '')),
      code: normalizeMeta(err.code),
      syscall: normalizeMeta(err.syscall),
      errno: normalizeMeta(err.errno),
    };
  } catch {
    return { name: 'SerializationError', message: '[UNSERIALIZABLE_ERROR]' };
  }
}

/**
 * Collects a non-identifying, aggregate count of currently active Node async resources
 * using `process.getActiveResourcesInfo()` where available.
 *
 * @returns {Record<string, number> | null} Resource counts by type, or null if unsupported.
 */
function activeResourceCounts() {
  try {
    if (typeof process.getActiveResourcesInfo !== 'function') return null;
    const counts = {};
    for (const resource of process.getActiveResourcesInfo()) counts[resource] = (counts[resource] || 0) + 1;
    return counts;
  } catch {
    return null;
  }
}

/**
 * Synchronously appends a structured JSONL diagnostic record to the active log file.
 * Synchronous writes ensure diagnostic records survive abrupt process termination.
 * Serialization is guarded with BigInt replacer and try/catch to prevent dropped diagnostics.
 *
 * @param {string} kind - The event or lifecycle hook kind (e.g. 'start', 'process.abort').
 * @param {Record<string, unknown>} fields - Event-specific payload fields.
 * @returns {void}
 */
function write(kind, fields) {
  if (!fd) return;
  try {
    const line = JSON.stringify(
      {
        kind,
        pid: process.pid,
        ppid: process.ppid,
        testFile: Boolean(process.env.NODE_TEST_CONTEXT) ? (process.argv[1] || null) : null,
        nodeTestContext: process.env.NODE_TEST_CONTEXT || null,
        timeIso: new Date().toISOString(),
        timeNs: process.hrtime.bigint().toString(),
        ...fields,
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
    fs.writeSync(fd, line + '\n');
  } catch {
    /* best-effort; serialization or write failure dropped safely */
  }
}

write('start', {});

const originalExit = process.exit.bind(process);
/**
 * Patched wrapper around `process.exit` that synchronously records the exit code
 * and redacted caller stack before invoking the original `process.exit`.
 *
 * @param {number} [code] - The process exit code.
 * @returns {never}
 */
process.exit = function patchedExit(code) {
  write('process.exit', { code, callerStack: redact(new Error('exit-call-site').stack) });
  return originalExit(code);
};

const originalAbort = typeof process.abort === 'function' ? process.abort.bind(process) : null;
if (originalAbort) {
  /**
   * Patched wrapper around `process.abort` that synchronously records the abort event
   * and redacted caller stack before invoking the original `process.abort`.
   *
   * @param {...unknown} args - Any arguments forwarded to process.abort.
   * @returns {never}
   */
  process.abort = function patchedAbort(...args) {
    write('process.abort', { callerStack: redact(new Error('abort-call-site').stack) });
    return originalAbort(...args);
  };
}

const originalKill = process.kill.bind(process);
/**
 * Patched wrapper around `process.kill` that synchronously records target PID and signal
 * before delegating to the original `process.kill`.
 *
 * @param {number} pid - Target process ID.
 * @param {string | number} [signal] - Signal to send.
 * @returns {boolean} Result of original process.kill.
 */
process.kill = function patchedKill(pid, signal) {
  write('process.kill', { targetPid: pid, signal, callerStack: redact(new Error('kill-call-site').stack) });
  return originalKill(pid, signal);
};

// Passive observer only: unlike 'uncaughtException' or 'unhandledRejection', registering
// 'uncaughtExceptionMonitor' does NOT suppress Node's default crash behavior, so it cannot
// itself change whether or how the process exits. Node emits it for both 'uncaughtException'
// and 'unhandledRejection' origins.
process.on('uncaughtExceptionMonitor', (err, origin) => {
  write('uncaughtExceptionMonitor', { err: safeErr(err), origin, activeResources: activeResourceCounts() });
});

process.on('warning', (warning) => write('warning', { err: safeErr(warning) }));
process.on('beforeExit', (code) => write('beforeExit', { code, activeResources: activeResourceCounts() }));
process.on('exit', (code) => write('exit', { code }));

write('preload-installed', {});
