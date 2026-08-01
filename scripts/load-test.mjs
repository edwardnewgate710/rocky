#!/usr/bin/env node
/**
 * Runs the k6 load baseline against a already-running Gambit stack and reports the result against
 * the SLOs in docs/SLO.md.
 *
 * k6 runs from its Docker image rather than as an npm dependency, matching how helm, kubeconform
 * and promtool are already used here — load tooling is not something the application should carry.
 *
 * Exits non-zero when a k6 threshold is breached. Those thresholds ARE the SLOs, so a failure means
 * either the service regressed or the objective was never achievable; both need a human.
 *
 * Usage:
 *   docker compose up -d --build          # or point BASE_URL at any running stack
 *   node scripts/load-test.mjs
 *
 * Env:
 *   BASE_URL   API base as seen FROM THE CONTAINER (default http://host.docker.internal:8080)
 *   HEALTH_URL API base as seen from this process  (default http://localhost:8080)
 *   READ_VUS, AUTH_VUS, DURATION   passed through to the scenario
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const K6_IMAGE = 'grafana/k6:0.55.0'; // pinned: a load baseline is worthless if the tool drifts
const SCENARIO = 'deploy/load/scenarios/api-baseline.js';
const RESULTS_DIR = 'deploy/load/results';

const baseUrl = process.env['BASE_URL'] ?? 'http://host.docker.internal:8080';
const healthUrl = process.env['HEALTH_URL'] ?? 'http://localhost:8080';

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function assertStackIsUp() {
  process.stdout.write(`Checking ${healthUrl}/v1/health ... `);
  try {
    const res = await fetch(`${healthUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) fail(`health returned ${res.status}. Start the stack first: docker compose up -d --build`);
    console.log('up');
  } catch (err) {
    fail(
      `cannot reach the API (${err instanceof Error ? err.message : String(err)}).\n` +
        '  Start it with:  docker compose up -d --build\n' +
        '  Or point HEALTH_URL/BASE_URL at a running stack.',
    );
  }
}

function runK6() {
  if (!existsSync(SCENARIO)) fail(`scenario not found: ${SCENARIO}`);
  mkdirSync(RESULTS_DIR, { recursive: true });

  const summaryPath = join(RESULTS_DIR, 'summary.json');
  const args = [
    'run', '--rm', '-i',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${process.cwd()}/deploy/load:/load`,
    '-e', `BASE_URL=${baseUrl}`,
  ];
  for (const key of ['READ_VUS', 'AUTH_VUS', 'DURATION']) {
    if (process.env[key]) args.push('-e', `${key}=${process.env[key]}`);
  }
  args.push(
    K6_IMAGE,
    'run',
    '--summary-export', '/load/results/summary.json',
    `/load/scenarios/${SCENARIO.split('/').pop()}`,
  );

  console.log(`\nRunning k6 (${K6_IMAGE}) against ${baseUrl}\n`);
  const proc = spawnSync('docker', args, { stdio: 'inherit' });

  if (proc.error) fail(`could not run docker: ${proc.error.message}`);
  return { code: proc.status ?? 1, summaryPath };
}

function report(summaryPath, k6ExitCode) {
  if (!existsSync(summaryPath)) {
    fail('k6 produced no summary — the run did not complete.');
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const m = summary.metrics ?? {};

  const num = (v) => (typeof v === 'number' ? v : undefined);
  const pct = (v) => (v === undefined ? 'n/a' : `${(v * 100).toFixed(3)}%`);
  const ms = (v) => (v === undefined ? 'n/a' : `${v.toFixed(1)} ms`);

  const failedRate = num(m.http_req_failed?.value ?? m.http_req_failed?.rate);
  const availability = failedRate === undefined ? undefined : 1 - failedRate;

  // Report the SAME series the threshold enforces. The latency SLO is scoped to `scenario:read`;
  // printing the aggregate mixes in the scrypt-bound registration path, which is precisely what
  // splitting the scenarios was meant to prevent — and it is what the first version of this
  // reporter did, quoting 98.29 ms when the SLO-relevant figure was 98.64 ms.
  //
  // p(99) exists at all only because the scenario asks for it via summaryTrendStats; k6's default
  // trend stats stop at p(95).
  const read = m['http_req_duration{scenario:read}'];
  const auth = m['http_req_duration{scenario:auth}'];

  console.log('\n=== Measured against docs/SLO.md ===\n');
  console.log(`  requests:                 ${num(m.http_reqs?.count) ?? 'n/a'}`);
  console.log(`  availability:             ${pct(availability)}   (SLO 99.5%, 5xx only)`);
  console.log('');
  console.log('  read path — the SLO-scoped series:');
  console.log(`    p95:                    ${ms(num(read?.['p(95)']))}`);
  console.log(`    p99:                    ${ms(num(read?.['p(99)']))}   (SLO: 99% under 250 ms)`);
  console.log(`    max:                    ${ms(num(read?.max))}`);
  console.log('');
  console.log('  auth path — separate threshold, scrypt-bound, NOT part of the latency SLO:');
  console.log(`    p95:                    ${ms(num(auth?.['p(95)']))}`);
  const limited = num(m.auth_rate_limited?.value ?? m.auth_rate_limited?.rate);
  if (limited !== undefined) {
    console.log(`    rate-limited:           ${pct(limited)}   (expected: 5/hour/IP, ADR-0013)`);
  }
  console.log('');

  if (k6ExitCode !== 0) {
    console.log('=== Result: THRESHOLD BREACHED ===');
    console.log('A k6 threshold here is an SLO from docs/SLO.md. Either the service regressed, or');
    console.log('the objective was never achievable on this hardware — both need a human decision,');
    console.log('so this exits non-zero rather than recording a number nobody looked at.');
    process.exit(1);
  }

  console.log('=== Result: every SLO threshold held ===');
  console.log(`Summary written to ${summaryPath}`);
}

async function main() {
  await assertStackIsUp();
  const { code, summaryPath } = runK6();
  report(summaryPath, code);
}

await main();
