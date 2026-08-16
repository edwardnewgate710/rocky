/**
 * Running a k6 scenario from the pinned Docker image.
 *
 * Shared by `scripts/load-test.mjs` (HTTP baseline, ADR-0065) and `scripts/ws-load-test.mjs`
 * (WebSocket baseline, ADR-0111). The part that must not be stated twice is the pin: ADR-0065
 * pinned `grafana/k6` because "a baseline measured with a drifting tool is not a baseline", and two
 * copies of a version pin are two versions waiting to disagree. The mount layout and the
 * host-gateway alias travel with it because they are the same recipe.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Pinned: a load baseline is worthless if the tool drifts. */
export const K6_IMAGE = 'grafana/k6:0.55.0';

/** Gitignored — a summary describes the machine that produced it (ADR-0065 §6). */
export const RESULTS_DIR = 'deploy/load/results';

export function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * Run one scenario and return k6's exit code alongside the summary it wrote.
 *
 * `env` values reach the container as `docker -e NAME=value` argv entries, never through a shell:
 * `spawnSync` is called without `shell: true`, so a value containing a space, a quote or a newline
 * stays one datum instead of becoming another command.
 */
export function buildK6Args(
  { scenario, env, summaryFile, summaryExport = true },
  workingDirectory = process.cwd(),
) {
  const args = [
    'run', '--rm', '-i',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${workingDirectory}/deploy/load:/load`,
  ];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) args.push('-e', `${name}=${value}`);
  }
  args.push(K6_IMAGE, 'run');
  if (summaryExport) args.push('--summary-export', `/load/results/${summaryFile}`);
  args.push(`/load/scenarios/${basename(scenario)}`);
  return args;
}

export function runK6({ scenario, env, summaryFile, target, summaryExport = true }) {
  if (!existsSync(scenario)) fail(`scenario not found: ${scenario}`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const summaryPath = join(RESULTS_DIR, summaryFile);
  // A failed k6 invocation must never leave the runner reading a previous successful run.
  rmSync(summaryPath, { force: true });

  const args = buildK6Args({ scenario, env, summaryFile, summaryExport });

  console.log(`\nRunning k6 (${K6_IMAGE}) against ${target}\n`);
  const proc = spawnSync('docker', args, { stdio: 'inherit' });

  if (proc.error) fail(`could not run docker: ${proc.error.message}`);
  return { code: proc.status ?? 1, summaryPath };
}

/** The `metrics` block k6 exported, or a hard failure when the run produced no summary at all. */
export function readSummaryMetrics(summaryPath) {
  if (!existsSync(summaryPath)) {
    fail('k6 produced no summary — the run did not complete.');
  }
  return JSON.parse(readFileSync(summaryPath, 'utf8')).metrics ?? {};
}

/** Read one exact, unlabelled counter from Prometheus text exposition. */
export function readPrometheusCounter(exposition, name) {
  for (const line of exposition.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)$/.exec(trimmed);
    if (match && match[1] === name) return Number(match[3]);
  }
  return null;
}
