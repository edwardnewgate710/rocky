#!/usr/bin/env node
/**
 * Runs each package's test suite and prints a summary of test counts.
 *
 * Prerequisite: `npm run build` must have been executed at the repo root
 * so that each package's `dist/` and `dist-test/` directories exist.
 * The script checks for `dist-test/` before running tests and exits
 * with an error if it is missing, rather than silently reporting 0.
 *
 * Same behaviour as the previous inline `node -e` blob in package.json,
 * but as a reviewable script file.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const pkgs = ['core', 'game', 'realtime-gateway', 'persistence', 'api', 'engine', 'web', 'ai-orchestrator', 'ai-features'];
let total = 0;
let hadError = false;

for (const p of pkgs) {
  const pkgDir = 'packages/' + p;
  const distTestDir = pkgDir + '/dist-test';

  // Guard: if dist-test/ doesn't exist, the package hasn't been built.
  // Report clearly and skip — never silently count 0.
  if (!existsSync(distTestDir)) {
    console.log(p + ': NOT BUILT (run "npm run build" first)');
    hadError = true;
    continue;
  }

  try {
    const o = execSync(
      'npx tsc -p tsconfig.test.json 2>/dev/null && ' +
      'node --test $(find dist-test/test -name "*.test.js") 2>&1 | ' +
      'grep -E "^# (tests|pass|fail|skipped)"',
      { cwd: pkgDir, encoding: 'utf8' },
    );
    const lines = o.trim().split('\n');
    const t = lines.find((l) => l.startsWith('# tests'))?.match(/\d+/)?.[0] || '?';
    const s = lines.find((l) => l.startsWith('# skipped'))?.match(/\d+/)?.[0] || '0';
    console.log(p + ': ' + t + ' tests (' + s + ' skipped)');
    if (t !== '?') total += parseInt(t);
  } catch {
    console.log(p + ': ERROR');
    hadError = true;
  }
}
console.log('Total: ' + total);
if (hadError) {
  console.error('ERROR: one or more packages could not be counted. Run "npm run build" first.');
  process.exit(1);
}
