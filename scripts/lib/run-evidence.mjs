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
 * A JWT is the one the harnesses actually hold; `Bearer ` catches a whole header copied in as a
 * label, and a long unbroken URL-safe blob catches an opaque token stored under an innocent name.
 */
const CREDENTIAL_VALUE = [
  { name: 'a JWT', test: /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  { name: 'an Authorization header', test: /^\s*bearer\s+\S/i },
];

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

/** Write the envelope, refusing anything that carries a credential. Returns the path written. */
export function writeEvidence(directory, file, evidence) {
  assertNoCredentials(evidence);
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
