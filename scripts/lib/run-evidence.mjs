/**
 * Self-identifying evidence for a load or chaos run.
 *
 * Before this, a run's only durable output was a k6 metrics blob — `deploy/load/results/*.json`
 * with no scenario name, no timestamp, no target, no thresholds, and no pass/fail. A file like that
 * cannot answer the two questions anybody reading it actually has: *what was this measured
 * against*, and *is this from the run I just did*. The chaos suite produced no artifact at all; its
 * entire result was console scrollback.
 *
 * Two rules shape everything here:
 *
 *   1. **Nothing secret is ever written.** The harnesses hold live access tokens — the WebSocket
 *      scenario already avoids k6's built-in summary export for precisely that reason. So the
 *      writer scans the envelope and *refuses* rather than trusting its callers to have been
 *      careful. Fail-closed, because the failure it guards is a credential on disk and in a CI
 *      artifact.
 *   2. **A stale file must never read as a current one.** Every envelope carries its own run
 *      identity and timestamps, and the writer removes the target before writing, so an
 *      interrupted run leaves no file rather than yesterday's.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Versioned, so a reader can tell an old artifact from one it does not understand. */
export const EVIDENCE_SCHEMA = 'gambit.run-evidence/1';

/**
 * Where evidence lands: the same gitignored directory k6 writes its summaries to, because a run's
 * metrics and the envelope describing that run belong together. Stated here rather than imported
 * from `k6-docker.mjs`, since the chaos suite writes evidence and runs no k6 at all. The contract
 * test pins the two constants against each other so the duplication cannot drift.
 */
export const EVIDENCE_DIR = 'deploy/load/results';

/** Conventional shell exit codes for the interrupts a harness can receive: 128 + the signal. */
const SIGNAL_EXIT_CODE = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/**
 * Key names that may not appear anywhere in an evidence envelope.
 *
 * Matched on the key, not the value, and matched as a substring so `accessToken`, `tokens`,
 * `refresh_token` and `Authorization` are all caught by one entry. Over-broad on purpose: a field
 * genuinely named `sessionCount` being refused costs one rename, while a missed `token` costs a
 * credential rotation.
 */
const CREDENTIAL_KEY = /token|password|passwd|secret|credential|cookie|authorization|session|apikey|api_key|bearer/i;

/**
 * Value shapes that are a credential regardless of what the key is called.
 *
 * A JWT is the one the harnesses actually hold, and `Bearer ` catches a whole header copied in as a
 * label.
 */
const CREDENTIAL_VALUE = [
  { name: 'a JWT', test: /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  { name: 'an Authorization header', test: /^\s*bearer\s+\S/i },
];

/**
 * A credential carried inside a URL, which the key-name rule cannot see.
 *
 * Every URL in an envelope comes from an environment variable — `BASE_URL`, `API_URL`,
 * `NODE1_WS_URL`, the health and metrics endpoints — and lands under an entirely innocent key like
 * `topology.baseUrl`. `https://user:password@host` and `wss://host/live?access_token=…` are both
 * ordinary ways to write one, and both would otherwise be copied verbatim into a CI artifact.
 *
 * Only strings that actually parse as a URL are inspected, so a compose command line or a scenario
 * name is left alone.
 */
function urlCredential(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return 'URL user-info credentials';
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_KEY.test(name)) return `a credential-bearing "${name}" query parameter`;
  }
  return null;
}

function describe(path) {
  return path.length === 0 ? 'the envelope root' : path.join('.');
}

/**
 * Throw if anything in `value` is, or is named like, a credential.
 *
 * Walks the whole structure rather than checking the top level: the interesting leak is a nested
 * `topology.node1.headers.Authorization`, not a top-level field somebody would have noticed.
 */
export function assertNoCredentials(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, [...path, String(index)]));
    return value;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) {
        throw new Error(
          `run evidence would persist "${describe([...path, key])}", whose name matches a ` +
            'credential; evidence is written to disk and uploaded as a CI artifact, so it carries ' +
            'no secrets. Record a non-secret fact instead, or rename the field.',
        );
      }
      assertNoCredentials(child, [...path, key]);
    }
    return value;
  }
  if (typeof value === 'string') {
    for (const { name, test } of CREDENTIAL_VALUE) {
      if (test.test(value)) {
        throw new Error(
          `run evidence would persist ${name} at "${describe(path)}"; evidence carries no secrets.`,
        );
      }
    }
    const inUrl = urlCredential(value);
    if (inUrl) {
      throw new Error(
        `run evidence would persist ${inUrl} at "${describe(path)}"; evidence carries no secrets. ` +
          'Point the harness at a URL without embedded credentials, or supply them out of band.',
      );
    }
  }
  return value;
}

/**
 * Build the envelope. Pure: the clock and the id generator are arguments so the tests can pin them.
 *
 * `expected` and `observed` sit beside each other on purpose. A measurement with no threshold next
 * to it cannot be read as a pass or a fail by anyone who was not there when it ran, which is every
 * reader of an artifact.
 */
export function buildEvidence({
  harness,
  outcome,
  exitCode,
  startedAt,
  finishedAt,
  topology = {},
  configuration = {},
  expected = {},
  observed = {},
  scenarios = [],
  notes = [],
  runId = randomUUID(),
  runner = defaultRunner(),
}) {
  if (typeof harness !== 'string' || harness.length === 0) {
    throw new Error('run evidence needs a harness name');
  }
  if (!Number.isInteger(exitCode)) {
    throw new Error(`run evidence needs an integer exit code, got ${String(exitCode)}`);
  }
  const started = new Date(startedAt);
  const finished = new Date(finishedAt);
  if (Number.isNaN(started.getTime()) || Number.isNaN(finished.getTime())) {
    throw new Error('run evidence needs valid start and finish timestamps');
  }

  return assertNoCredentials({
    schema: EVIDENCE_SCHEMA,
    harness,
    runId,
    outcome,
    exitCode,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    runner,
    topology,
    configuration,
    expected,
    observed,
    scenarios,
    notes,
  });
}

function defaultRunner() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: process.env['CI'] === 'true' || process.env['CI'] === '1',
  };
}

/**
 * Remove any evidence a previous run left at this path.
 *
 * Called at the *start* of a run, not only before the write: a run that dies between here and its
 * finish must leave nothing rather than an artifact describing a different run that happened to
 * finish. `runK6` already does this for k6's summary; the chaos suite had no equivalent because it
 * had no artifact.
 */
export function clearEvidence(directory, file) {
  rmSync(join(directory, file), { force: true });
}

/**
 * Guarantee this run leaves an artifact behind, however it ends.
 *
 * `clearEvidence` removes the previous run's file before the harness touches anything external, so
 * that a reader can never mistake an old artifact for this run. The cost is that a failure between
 * that point and the harness's own `writeEvidence` — a stack that will not come up, a k6 image that
 * will not pull, a summary that will not parse — leaves no artifact at all, and several of those
 * paths call `process.exit` directly rather than throwing somewhere a `catch` could see.
 *
 * So the fallback is armed on process exit instead: whatever ends the run, the last thing it does
 * is write a failure envelope, unless a real one has already been written. Building the envelope is
 * deferred to `buildFallback` so it can record the exit code it is explaining. A failure to write
 * one is reported and never masks the original exit.
 *
 * @param {(exitCode: number) => object} buildFallback
 * @returns {{ markWritten: () => void }} call `markWritten` once the real envelope is on disk
 */
export function armFailureEvidence(directory, file, buildFallback, { onSignal } = {}) {
  let written = false;

  /** Write the fallback at most once. Synchronous throughout: an exit handler cannot await. */
  const persist = (exitCode) => {
    if (written) return;
    written = true;
    try {
      writeEvidence(directory, file, buildFallback(exitCode));
      console.error(`[evidence] run ended without a result; wrote a failure envelope to ${file}`);
    } catch (err) {
      console.error(`[evidence] could not write a failure envelope: ${err?.message ?? err}`);
    }
  };

  process.on('exit', persist);

  // `process.on('exit')` alone is not enough. Under the DEFAULT disposition for SIGINT or SIGTERM,
  // Node terminates without running exit handlers at all — so Ctrl-C on a harness that has already
  // cleared the previous artifact would leave nothing behind, which is the case this whole
  // mechanism exists for. Installing a listener is what moves those signals off the default path.
  // One listener per signal, owning the whole interrupt path. A harness that installed its own
  // alongside this one would give the signal two termination policies: the chaos suite's did
  // exactly that, exiting 130 for SIGTERM as well as SIGINT, so an interrupted run reported
  // SIGINT's status, disagreed with its own artifact, and turned a signal death into an ordinary
  // exit. Harness-specific cleanup belongs in `onSignal`, not in a competing listener.
  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODE)) {
    const handler = () => {
      // Evidence first: it is one synchronous write, while cleanup shells out and can throw or
      // block. The artifact is the thing that must survive an interrupt.
      persist(exitCode);
      try {
        onSignal?.(signal);
      } catch (err) {
        console.error(`[evidence] cleanup on ${signal} failed: ${err?.message ?? err}`);
      }
      // Then die the way the signal asked. Removing this listener restores the default
      // disposition, so re-raising terminates the process *by the signal* rather than turning an
      // interrupt into an ordinary exit — a caller waiting on this process still sees what
      // happened to it.
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }

  return {
    markWritten: () => {
      written = true;
    },
  };
}

/**
 * Open a run's evidence lifecycle: arm the fallback FIRST, then clear the previous artifact.
 *
 * The ordering is the whole point, and it is the reason this is one function rather than two calls
 * at each of three call sites. Clearing first opens a window — a dozen lines wide in the load
 * harnesses, which build their configuration in between — where the old artifact is already gone
 * and no handler is installed yet. An interrupt landing there leaves *neither* the previous run's
 * evidence nor this one's, which is precisely the guarantee the fallback exists to make. Arming
 * first closes it: an interrupt in the gap now writes this run's aborted envelope over the old one.
 *
 * @param {(exitCode: number) => object} buildFallback
 * @param {{ onSignal?: (signal: string) => void }} [options] synchronous cleanup for the signal path
 */
export function beginEvidence(directory, file, buildFallback, options) {
  const armed = armFailureEvidence(directory, file, buildFallback, options);
  clearEvidence(directory, file);
  return armed;
}

/** Write the envelope, refusing anything that carries a credential. Returns the path written. */
export function writeEvidence(directory, file, evidence) {
  assertNoCredentials(evidence);
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
