#!/usr/bin/env node
/**
 * Fails when `scripts/ci-local.mjs` stops matching `.github/workflows/ci.yml`.
 *
 * A local runner that claims to be "what CI runs" is only useful while that is true. The failure
 * mode is not someone deleting a step on purpose — it is a new job landing in the workflow and
 * nobody thinking about the local copy, so the local run keeps printing green for a suite that is
 * quietly one job short. That is worse than having no local runner at all, because it is trusted.
 *
 * Checks:
 *   1. every command `ci-local.mjs` runs also appears in the workflow;
 *   2. every `run: npm ...` command in the workflow is either present in `ci-local.mjs` or listed
 *      in NOT_RUNNABLE_LOCALLY below, with a reason.
 *
 * Run: node scripts/check-ci-parity.mjs
 */
import { readFileSync } from 'node:fs';

const WORKFLOW = readFileSync('.github/workflows/ci.yml', 'utf8');
const LOCAL = readFileSync('scripts/ci-local.mjs', 'utf8');

/**
 * Workflow commands the local runner deliberately does not reproduce, each with the reason it
 * cannot be. An entry here is a decision, not an exemption to be handed out freely: it says a
 * developer running `ci-local.mjs` is genuinely not covered for this, which is why the runner
 * reports what it skipped rather than printing an unqualified pass.
 */
const NOT_RUNNABLE_LOCALLY = new Map([
  ['npx playwright install chromium', 'downloads a browser; the e2e job is opt-in locally'],
  ['npm run e2e', 'needs the Playwright browser above and a free port 4173'],
  ['npm ci', 'CI installs from a clean checkout; locally node_modules already exists'],
  ['npx vite preview --port 4173 --host 127.0.0.1 &', 'a background server for the Lighthouse job'],
  ['npm install -g lighthouse@11.4.0', 'a global install; the a11y audit stays a CI-only job'],
  [
    'npm run test:analysis-smoke --workspace @chess-platform/api',
    'needs a real Stockfish binary at STOCKFISH_PATH, which CI apt-installs; the test self-skips without one, so running it locally would report a pass having proven nothing',
  ],
]);

/** Every `run:` command in the workflow, flattened, one per line. */
function workflowCommands() {
  const out = new Set();
  const lines = WORKFLOW.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const single = /^\s*run:\s*(\S.*)$/.exec(lines[i]);
    if (single && single[1] !== '|' && single[1] !== '>') {
      for (const part of single[1].split('&&')) out.add(part.trim());
      continue;
    }
    // Block scalar: take the indented lines that follow.
    if (/^\s*run:\s*[|>]/.test(lines[i])) {
      const indent = (/^(\s*)/.exec(lines[i + 1] ?? '') ?? ['', ''])[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') continue;
        if ((/^(\s*)/.exec(line) ?? ['', ''])[1].length < indent) break;
        for (const part of line.trim().split('&&')) out.add(part.trim());
      }
    }
  }
  return [...out].filter((c) => c.startsWith('npm ') || c.startsWith('npx '));
}

const problems = [];
const commands = workflowCommands();

// 2. Workflow → local.
for (const command of commands) {
  if (NOT_RUNNABLE_LOCALLY.has(command)) continue;
  if (!LOCAL.includes(command)) {
    problems.push(`workflow runs \`${command}\` and scripts/ci-local.mjs does not.
    Add it there, or add it to NOT_RUNNABLE_LOCALLY with the reason it cannot run locally.`);
  }
}

// 1. Local → workflow. Extracted from the quoted command strings in the arrays.
const localCommands = [...LOCAL.matchAll(/'((?:npm|npx) [^']+)'/g)].map((m) => m[1]);
for (const command of localCommands) {
  if (!commands.includes(command)) {
    problems.push(`scripts/ci-local.mjs runs \`${command}\` and the workflow does not.
    A local runner that does MORE than CI is a different suite, not a preview of it.`);
  }
}

if (problems.length > 0) {
  console.error('  ✗ CI parity problems:');
  for (const problem of problems) console.error(`    - ${problem}`);
  console.error(`\n=== ${problems.length} problem(s) ===`);
  console.error('`npm run ci:local` claims to be what CI runs. That claim has to stay true.');
  process.exit(1);
}

console.log(`  ✓ scripts/ci-local.mjs matches .github/workflows/ci.yml (${commands.length} commands checked)`);
