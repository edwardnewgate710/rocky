#!/usr/bin/env node
/**
 * Fails when an ADR references a file, metric, npm script or sibling ADR that does not exist.
 *
 * ADRs are the durable record of why this system is shaped the way it is, and nothing checks them.
 * They rot in one direction that matters: they describe behaviour that was decided, and the code
 * quietly ends up somewhere else. M14 increment 11 found ADR-0010 §7 specifying six ownership
 * metrics that had **never been implemented** — game ownership was completely unobservable in
 * production, no test could assert failover because there was nothing to observe, and the gap
 * survived for months because prose is not executable. The same ADR's §6 promised behaviour the code
 * did not have either.
 *
 * This catches the mechanical half of that class: an identifier an ADR names that is not there. It
 * does NOT and cannot verify a behavioural claim like §6's — see docs/adr/0079 for why that
 * distinction matters and why this guard must not be read as proof that the ADRs are true.
 *
 * Checks, over `docs/adr/*.md`:
 *   1. Repo-relative paths in backticks (rooted at a real top-level directory) exist.
 *   2. Metric-shaped names in backticks are registered somewhere in the source.
 *   3. `npm run <script>` references resolve to a script in some package.json.
 *   4. `ADR-NNNN` cross-references resolve to an ADR file.
 *
 * Run: node scripts/check-adr-claims.mjs
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const ADR_DIR = 'docs/adr';
const SOURCE_GLOBS = ['packages', 'services'];

/**
 * A bare filename is prose, not a reference. ADRs legitimately write `Chart.yaml`, `bootstrap.ts` or
 * `ci.yml` as shorthand for "the one you already know about", and there is often more than one file
 * with that name. Requiring a path separator rooted at a real top-level directory is what keeps this
 * check's false-positive rate near zero — without it the output is noise nobody reads, and a guard
 * nobody reads is worse than no guard.
 */
const PATH_ROOTS = ['packages', 'services', 'scripts', 'deploy', 'docs', 'docker', '.github'];

/**
 * Identifiers an ADR names on purpose while describing something that is wrong.
 *
 * ADR-0064 documents the observability drift guard catching a misspelled metric, and quotes the
 * misspelling. Flagging a documented counter-example would be a guard complaining about the very
 * thing it is meant to encourage, and the fix people reach for is switching the guard off. Every
 * entry here needs a reason; an unexplained allowlist is how a guard dies quietly.
 */
const ALLOWED = new Map([
  [
    'gateway_auth_failure_total',
    'ADR-0064 quotes this misspelling (the real metric is gateway_auth_failures_total) to show the ' +
      'observability drift guard rejecting it. It is an illustration, not a claim.',
  ],
  [
    'http_req_duration',
    'A k6 built-in, emitted by the load generator rather than by this application. ADR-0065 names it ' +
      'because the load thresholds ARE the SLOs; it shares the http_ namespace with our own metrics ' +
      'by coincidence. Any other http_ name still has to exist in the source.',
  ],
  [
    'http_req_failed',
    'A k6 built-in, as above (ADR-0065).',
  ],
]);

const problems = [];

/**
 * Paths git is told to ignore are not expected to exist in a clean checkout.
 *
 * ADR-0065 references `deploy/load/results/` — and says in the same sentence that it is gitignored,
 * because the load test writes its output there. That reference is correct and useful; the directory
 * simply does not exist until someone runs the tool. This guard's first CI run failed on exactly
 * that, passing locally only because my machine had run the load test. Asking git rather than
 * guessing is what separates "the record points at nothing" from "this is generated".
 *
 * Consulted in one batch. If git cannot answer (not a work tree, git missing), nothing is treated as
 * ignored — reporting a path that turns out to be generated is a smaller failure than silently
 * skipping a reference that really is dead.
 */
function gitIgnored(paths) {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      input: paths.join('\n'),
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    return new Set(out.split('\n').map((line) => line.trim()).filter(Boolean));
  } catch (err) {
    // `git check-ignore` exits 1 when NOTHING matches, which is a normal answer, not a failure.
    if (err.status === 1 && typeof err.stdout === 'string') {
      return new Set(err.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    }
    return new Set();
  }
}

function adrFiles() {
  return readdirSync(join(REPO_ROOT, ADR_DIR))
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f, text: readFileSync(join(REPO_ROOT, ADR_DIR, f), 'utf8') }));
}

/** Every backticked span in a document, which is where this repo's ADRs put identifiers. */
function backticked(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(REPO_ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    // Tests register throwaway metrics (`reqs_total`, `active_games`, `lat_seconds`) against fake
    // registries. Letting those into the vocabulary invents namespaces the application never emits
    // into — `active` was one, which then made the workflow input `active_color` look like a metric
    // an ADR had promised. What the application registers is what counts.
    if (entry.name === 'test' || entry.name === '__tests__') continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** Source text of every package/service, concatenated once — the corpus metric names must appear in. */
function sourceText() {
  let combined = '';
  for (const root of SOURCE_GLOBS) {
    for (const file of walk(root)) combined += readFileSync(join(REPO_ROOT, file), 'utf8');
  }
  return combined;
}

/** Script names declared by any package.json in the workspace roots. */
function declaredScripts() {
  const names = new Set();
  const manifests = ['package.json'];
  for (const root of ['packages', 'services']) {
    let dirs;
    try {
      dirs = readdirSync(join(REPO_ROOT, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) if (d.isDirectory()) manifests.push(`${root}/${d.name}/package.json`);
  }
  for (const manifest of manifests) {
    if (!existsSync(join(REPO_ROOT, manifest))) continue;
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8'));
    for (const name of Object.keys(parsed.scripts ?? {})) names.add(name);
  }
  return names;
}

/** Collect (adr, path) candidates; existence is judged later, once git has been asked in one batch. */
function collectPaths(adr, candidates) {
  for (const span of backticked(adr.text)) {
    // A glob describes many files; `<placeholder>` describes a family of them. Neither is a
    // reference to one file, and demanding they exist is how this check earns a reputation for
    // crying wolf.
    if (span.includes('*') || span.includes(' ') || /[<>]/.test(span)) continue;
    // `docker/build-push-action@v5` is a GitHub Action, not a path — it only looks like one because
    // its publisher is called docker. A version suffix is the tell.
    if (span.includes('@')) continue;
    if (!span.includes('/')) continue;
    const root = span.split('/')[0];
    if (!PATH_ROOTS.includes(root)) continue;
    // `file.ts:120` points INTO a file. The line number is not part of the path, and pointing at a
    // line is exactly the kind of precise reference worth keeping honest.
    const path = span.replace(/:\d+(-\d+)?$/, '').replace(/[.,)]+$/, '');
    if (!existsSync(join(REPO_ROOT, path))) candidates.push({ adr: adr.name, path });
  }
}

/**
 * Names the source actually registers, and the namespaces they live in.
 *
 * The vocabulary is derived rather than guessed. An earlier version recognised a metric by suffix
 * (`_total`, `_seconds`, `_bytes`, `_count`), which silently skipped every gauge: of the eighteen
 * metrics this repo registers, exactly one — `gateway_owned_games` — fell outside that list, and it
 * is one of the six from ADR-0010 §7 that motivated this guard. A check that misses the very example
 * used to justify it is worse than no check, because it is quoted as protection.
 */
function registeredMetrics(source) {
  const names = new Set(
    [...source.matchAll(/\.(?:counter|gauge|histogram)\(\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]),
  );
  return { names, namespaces: new Set([...names].map((n) => n.split('_')[0])) };
}

function checkMetrics(adr, source, registered) {
  // Metric-shaped, and either carrying a Prometheus-conventional suffix or living in a namespace the
  // application actually emits into. The namespace rule is what catches gauges without inviting every
  // snake_case identifier in the prose — table names like `search_documents` share no namespace with
  // any registered metric.
  const metricShaped = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
  const conventionalSuffix = /(_total|_seconds|_bytes|_count)$/;
  for (const span of backticked(adr.text)) {
    if (!metricShaped.test(span)) continue;
    const namespace = span.split('_')[0];
    if (!conventionalSuffix.test(span) && !registered.namespaces.has(namespace)) continue;
    if (ALLOWED.has(span)) continue;
    if (!registered.names.has(span)) {
      problems.push(
        `${ADR_DIR}/${adr.name}: specifies metric \`${span}\`, which no source file registers — the ` +
          `ADR promises an operator a signal that does not exist (this is the ADR-0010 §7 failure).`,
      );
    }
  }
}

function checkNpmScripts(adr, scripts) {
  for (const match of adr.text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    const name = match[1];
    if (!scripts.has(name)) {
      problems.push(
        `${ADR_DIR}/${adr.name}: tells the reader to run \`npm run ${name}\`, which no package.json declares.`,
      );
    }
  }
}

function checkAdrReferences(adr, existing) {
  for (const match of adr.text.matchAll(/ADR-(\d{4})/g)) {
    if (!existing.has(match[1])) {
      problems.push(
        `${ADR_DIR}/${adr.name}: cross-references ADR-${match[1]}, which does not exist.`,
      );
    }
  }
}

function main() {
  const adrs = adrFiles();
  const source = sourceText();
  const registered = registeredMetrics(source);
  const scripts = declaredScripts();
  const numbers = new Set(adrs.map((a) => a.name.slice(0, 4)));

  const missingPaths = [];
  for (const adr of adrs) {
    collectPaths(adr, missingPaths);
    checkMetrics(adr, source, registered);
    checkNpmScripts(adr, scripts);
    checkAdrReferences(adr, numbers);
  }

  const ignored = gitIgnored([...new Set(missingPaths.map((c) => c.path))]);
  for (const { adr, path } of missingPaths) {
    if (ignored.has(path) || ignored.has(path.replace(/\/$/, ''))) continue;
    problems.push(
      `${ADR_DIR}/${adr}: references \`${path}\`, which does not exist — either the file moved and ` +
        `the record now points at nothing, or it was never created.`,
    );
  }

  console.log('');
  console.log('=== ADR claim check ===');
  console.log('');

  if (problems.length > 0) {
    console.log('  ✗ Problems:');
    for (const problem of problems) console.log(`    - ${problem}`);
    console.log('');
    console.log(`=== Results: ${problems.length} problem(s) across ${adrs.length} ADRs ===`);
    process.exit(1);
  }

  console.log(`  ✓ ${adrs.length} ADRs: every referenced path, metric, npm script and ADR resolves`);
  if (ALLOWED.size > 0) {
    console.log(`  ℹ ${ALLOWED.size} documented counter-example(s) allowlisted:`);
    for (const [name, why] of ALLOWED) console.log(`      ${name} — ${why}`);
  }
  console.log('');
  console.log('=== Results: no ADR claim drift ===');
}

main();
