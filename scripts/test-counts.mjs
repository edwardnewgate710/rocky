#!/usr/bin/env node
/**
 * Runs each package's test suite and prints a summary of test counts.
 *
 * Same behaviour as the previous inline `node -e` blob in package.json,
 * but as a reviewable script file.
 */
import { execSync } from 'node:child_process';

const pkgs = ['core', 'game', 'realtime-gateway', 'persistence', 'api', 'engine', 'web'];
let total = 0;

for (const p of pkgs) {
  try {
    const o = execSync(
      'npx tsc -p tsconfig.test.json 2>/dev/null && ' +
      'node --test $(find dist-test/test -name "*.test.js") 2>&1 | ' +
      'grep -E "^# (tests|pass|fail|skipped)"',
      { cwd: 'packages/' + p, encoding: 'utf8' },
    );
    const lines = o.trim().split('\n');
    const t = lines.find((l) => l.startsWith('# tests'))?.match(/\d+/)?.[0] || '?';
    const s = lines.find((l) => l.startsWith('# skipped'))?.match(/\d+/)?.[0] || '0';
    console.log(p + ': ' + t + ' tests (' + s + ' skipped)');
    if (t !== '?') total += parseInt(t);
  } catch {
    console.log(p + ': ERROR');
  }
}
console.log('Total: ' + total);
