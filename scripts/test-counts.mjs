#!/usr/bin/env node
/** Run every suite through npm and report Node test-runner totals portably. */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('npm_execpath is unavailable; run this script through "npm run test:counts"');
  process.exit(1);
}
const suites = [
  ['core', ['test', '--workspace', '@chess-platform/core']],
  ['search', ['test', '--workspace', '@chess-platform/search']],
  ['social', ['test', '--workspace', '@chess-platform/social']],
  ['messaging', ['test', '--workspace', '@chess-platform/messaging']],
  ['community', ['test', '--workspace', '@chess-platform/community']],
  ['achievements', ['test', '--workspace', '@chess-platform/achievements']],
  ['anti-cheat', ['test', '--workspace', '@chess-platform/anti-cheat']],
  ['game', ['test', '--workspace', '@chess-platform/game']],
  ['tournament', ['test', '--workspace', '@chess-platform/tournament']],
  ['realtime-gateway', ['test', '--workspace', '@chess-platform/realtime-gateway']],
  ['persistence', ['test', '--workspace', '@chess-platform/persistence']],
  ['api', ['test', '--workspace', '@chess-platform/api']],
  ['engine', ['test', '--workspace', '@chess-platform/engine']],
  ['web', ['test', '--workspace', '@chess-platform/web']],
  ['e2e-harness', ['test', '--workspace', '@chess-platform/e2e-harness']],
  ['ai-orchestrator', ['test', '--workspace', '@chess-platform/ai-orchestrator']],
  ['ai-features', ['test', '--workspace', '@chess-platform/ai-features']],
  ['gateway-service', ['test', '--prefix', 'services/gateway']],
];

let total = 0;
let skippedTotal = 0;
let hadError = false;

for (const [name, args] of suites) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const tests = metric(output, 'tests');
  const skipped = metric(output, 'skipped') ?? 0;
  const failed = metric(output, 'fail') ?? 0;

  if (result.status !== 0 || tests === null || failed > 0) {
    console.error(`${name}: ERROR`);
    if (result.error) console.error(result.error.message);
    if (output.trim()) console.error(output.trim());
    hadError = true;
    continue;
  }
  console.log(`${name}: ${tests} tests (${skipped} skipped)`);
  total += tests;
  skippedTotal += skipped;
}

console.log(`Total: ${total} tests (${skippedTotal} skipped)`);
if (hadError) process.exitCode = 1;

function metric(output, name) {
  const patterns = [
    new RegExp(`^# ${name}\\s+(\\d+)`, 'm'),
    new RegExp(`^ℹ ${name}\\s+(\\d+)`, 'm'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match) return Number(match[1]);
  }
  return null;
}
