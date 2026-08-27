/**
 * Contract tests for the run-evidence envelope (`scripts/lib/run-evidence.mjs`).
 *
 * Two properties, and both of them are the reason the module exists:
 *
 *   1. **Nothing secret reaches disk.** All three harnesses hold live access tokens — the
 *      WebSocket scenario already refuses k6's built-in summary export over exactly this — and
 *      evidence is written to a file and uploaded as a CI artifact. The writer therefore scans and
 *      refuses rather than trusting its callers, so these tests are the ones that would catch a
 *      caller quietly starting to pass one in.
 *   2. **A stale artifact cannot pass for a current one.** An envelope carries its own identity and
 *      timestamps, and the writer clears the target first, so an interrupted run leaves nothing
 *      rather than the previous run's file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EVIDENCE_DIR,
  EVIDENCE_SCHEMA,
  assertNoCredentials,
  buildEvidence,
  clearEvidence,
  writeEvidence,
} from '../../../scripts/lib/run-evidence.mjs';
import { RESULTS_DIR } from '../../../scripts/lib/k6-docker.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const envelope = (overrides = {}) =>
  buildEvidence({
    harness: 'chaos',
    outcome: 'passed',
    exitCode: 0,
    startedAt: '2026-08-27T10:00:00.000Z',
    finishedAt: '2026-08-27T10:02:30.000Z',
    runId: 'fixed-for-the-test',
    runner: { node: 'v20.0.0', platform: 'linux', arch: 'x64', ci: true },
    ...overrides,
  });

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────

test('a field named like a credential is refused wherever it is nested', () => {
  assert.throws(
    () => envelope({ topology: { nodes: [{ name: 'node1', token: 'anything' }] } }),
    /topology\.nodes\.0\.token/,
    'the interesting leak is nested, not a top-level field somebody would have noticed',
  );
  for (const key of ['accessToken', 'refresh_token', 'Authorization', 'password', 'cookie']) {
    assert.throws(() => envelope({ observed: { [key]: 'x' } }), /carries no secrets|credential/i);
  }
});

test('a credential-shaped value is refused even under an innocent field name', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
  assert.throws(() => envelope({ observed: { note: jwt } }), /JWT/);
  assert.throws(() => envelope({ notes: [`Bearer ${jwt}`] }), /Authorization header/);
  assert.throws(
    () => envelope({ scenarios: [{ name: 'A', detail: { header: 'bearer abc123' } }] }),
    /Authorization header/,
    'a harness that copied a request header into a scenario detail would leak one this way',
  );
});

test('a credential carried inside a URL is refused, however innocent the field name', () => {
  // Every URL in an envelope comes from an environment variable and lands under a harmless key.
  assert.throws(
    () => envelope({ topology: { baseUrl: 'https://ops:hunter2@api.example.com' } }),
    /URL user-info credentials/,
    'topology.baseUrl is exactly the sort of name the key rule waves through',
  );
  assert.throws(
    () => envelope({ topology: { wsUrl: 'wss://gw.example.com/live?access_token=abc123' } }),
    /credential-bearing "access_token" query parameter/,
  );
  assert.throws(
    () => envelope({ configuration: { endpoint: 'https://x.example.com/?sessionId=s3cr3t' } }),
    /query parameter/,
  );
});

test('ordinary URLs and non-URL strings are not mistaken for credentials', () => {
  const evidence = envelope({
    topology: {
      compose: 'docker compose -f docker-compose.yml -f docker-compose.chaos.yml',
      apiUrl: 'http://localhost:8080',
      wsUrl: 'ws://localhost:4175',
      healthUrl: 'http://host.docker.internal:4176/health',
      query: 'https://search.example.com/?q=defense&limit=20',
    },
    scenarios: [{ name: 'A: cross-node correctness', status: 'passed' }],
  });
  assert.equal(evidence.topology.apiUrl, 'http://localhost:8080');
  assert.equal(
    evidence.topology.query,
    'https://search.example.com/?q=defense&limit=20',
    'a benign query parameter must not trip the URL rule, or the harnesses cannot record targets',
  );
});

test('the ordinary contents of a real run pass the scan', () => {
  const evidence = envelope({
    topology: {
      compose: 'docker compose -f docker-compose.yml -f docker-compose.chaos.yml',
      apiUrl: 'http://localhost:8080',
      nodes: [{ name: 'node1', wsUrl: 'ws://localhost:4175', commandRouting: 'redis' }],
    },
    configuration: { leaseTtlSec: 6, renewalIntervalSec: 2 },
    expected: { gracefulFailoverBudgetMs: 5000 },
    observed: { scenariosPassed: 5, stackRestored: true },
    scenarios: [{ name: 'A: cross-node correctness', status: 'passed', durationMs: 4200 }],
  });
  assert.equal(evidence.topology.nodes[0].commandRouting, 'redis');
  assert.equal(evidence.observed.scenariosPassed, 5);
});

test('the scan refuses a credential the writer is handed directly, not only a built one', () => {
  assert.throws(() => assertNoCredentials({ deep: { list: [{ sessionToken: 'x' }] } }), /token/i);
  assert.equal(assertNoCredentials({ ok: [1, 'two', null] }).ok.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-identification
// ─────────────────────────────────────────────────────────────────────────────

test('an envelope says what it is, when it ran, and how it ended', () => {
  const evidence = envelope();
  assert.equal(evidence.schema, EVIDENCE_SCHEMA);
  assert.equal(evidence.harness, 'chaos');
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.startedAt, '2026-08-27T10:00:00.000Z');
  assert.equal(
    evidence.durationMs,
    150_000,
    'a duration the reader can check against the timestamps, rather than take on trust',
  );
  assert.ok(evidence.runId.length > 0, 'two runs must be distinguishable without reading the clock');
});

test('an envelope with no harness, no exit code, or an unreadable clock is refused', () => {
  assert.throws(() => envelope({ harness: '' }), /harness name/);
  assert.throws(() => envelope({ exitCode: 'one' }), /integer exit code/);
  assert.throws(() => envelope({ startedAt: 'not a date' }), /valid start and finish/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Staleness
// ─────────────────────────────────────────────────────────────────────────────

test('a previous run’s artifact is removed before this run can be mistaken for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gambit-evidence-'));
  const file = 'chaos-evidence.json';
  writeFileSync(join(dir, file), '{"runId":"yesterday"}', 'utf8');

  clearEvidence(dir, file);
  assert.equal(
    existsSync(join(dir, file)),
    false,
    'cleared at the START of a run, so a run that dies mid-scenario leaves nothing rather than an ' +
      'artifact describing a different run that happened to finish',
  );
  clearEvidence(dir, file); // absent is not an error; a first run has nothing to clear.

  const written = writeEvidence(dir, file, envelope({ runId: 'today' }));
  assert.equal(JSON.parse(readFileSync(written, 'utf8')).runId, 'today');
});

test('the writer refuses a credential rather than persisting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gambit-evidence-'));
  assert.throws(() => writeEvidence(dir, 'x.json', { tokens: { white: 'secret' } }), /token/i);
  assert.equal(existsSync(join(dir, 'x.json')), false, 'and writes nothing on the way to refusing');
});

// ─────────────────────────────────────────────────────────────────────────────
// Where it lands
// ─────────────────────────────────────────────────────────────────────────────

test('evidence lands beside the k6 summaries, in the directory git is told to ignore', () => {
  assert.equal(
    EVIDENCE_DIR,
    RESULTS_DIR,
    'stated in two modules because the chaos suite runs no k6; this is what stops them drifting',
  );
  assert.match(
    read('.gitignore'),
    new RegExp(`^${EVIDENCE_DIR}/$`, 'm'),
    'evidence describes the machine that produced it and names its own topology — it is not a ' +
      'repository artifact',
  );
});

test('every harness clears, arms a fallback, and writes evidence', () => {
  for (const harness of ['scripts/chaos-test.mjs', 'scripts/load-test.mjs', 'scripts/ws-load-test.mjs']) {
    const source = read(harness);
    assert.match(source, /clearEvidence\(EVIDENCE_DIR, EVIDENCE_FILE\)/, `${harness} clears first`);
    assert.match(source, /writeEvidence\(\s*EVIDENCE_DIR,/, `${harness} writes evidence`);
    assert.match(
      source,
      /armFailureEvidence\(EVIDENCE_DIR, EVIDENCE_FILE,/,
      `${harness} must arm a fallback: it has already deleted the previous run's artifact by the ` +
        'time anything can fail, and several of its failure paths call process.exit directly',
    );
    assert.match(source, /fallback\.markWritten\(\)/, `${harness} marks the real write`);
  }
});

/**
 * The fallback is behaviour, not a source-text claim, so it is exercised in a real process.
 *
 * `armFailureEvidence` hangs off `process.on('exit')` precisely because the paths that need it call
 * `process.exit` rather than throwing, and neither a `try/catch` nor an assertion about the source
 * would notice if it stopped firing.
 */
function runInChild(script, dir) {
  const file = join(dir, 'child.mjs');
  writeFileSync(file, script, 'utf8');
  return spawnSync(process.execPath, [file], { cwd: REPO_ROOT, encoding: 'utf8' });
}

const armScript = (dir, body) => `
import { armFailureEvidence, buildEvidence, clearEvidence, writeEvidence } from ${JSON.stringify(
  pathToFileURL(join(REPO_ROOT, 'scripts/lib/run-evidence.mjs')).href,
)};
const DIR = ${JSON.stringify(dir)};
const FILE = 'evidence.json';
const build = (exitCode) => buildEvidence({
  harness: 'test', outcome: 'aborted', exitCode,
  startedAt: '2026-08-27T10:00:00.000Z', finishedAt: '2026-08-27T10:00:01.000Z',
});
clearEvidence(DIR, FILE);
const fallback = armFailureEvidence(DIR, FILE, build);
${body}
`;

test('a run that dies after clearing still leaves a failure artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gambit-evidence-'));
  writeFileSync(join(dir, 'evidence.json'), '{"runId":"yesterday"}', 'utf8');

  const result = runInChild(armScript(dir, 'process.exit(1);'), dir);
  assert.equal(result.status, 1, 'the fallback must not change how the run ended');

  const written = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
  assert.equal(written.outcome, 'aborted');
  assert.equal(written.exitCode, 1);
  assert.notEqual(
    written.runId,
    'yesterday',
    'the previous run’s artifact was cleared, so leaving it in place would be worse than nothing',
  );
});

test('a run that wrote its own evidence is not overwritten by the fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gambit-evidence-'));
  const result = runInChild(
    armScript(
      dir,
      `writeEvidence(DIR, FILE, buildEvidence({
         harness: 'test', outcome: 'passed', exitCode: 0,
         startedAt: '2026-08-27T10:00:00.000Z', finishedAt: '2026-08-27T10:00:02.000Z',
       }));
       fallback.markWritten();`,
    ),
    dir,
  );
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')).outcome, 'passed');
});
