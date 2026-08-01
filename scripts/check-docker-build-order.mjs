#!/usr/bin/env node
/**
 * Fails when the server build chain cannot actually build the server.
 *
 * The chain in root `package.json` is hand-maintained and ordered, because the packages resolve one
 * another's types from built `dist/` output. Add a cross-package dependency without reordering it
 * and the build breaks — which is exactly what happened: `search`, `engine` and `anti-cheat` were
 * never added to the copies of this chain inside Dockerfile.api and Dockerfile.gateway when
 * persistence and api started depending on them, so `docker compose up --build` failed from M11
 * inc 5 while CI stayed green. CI builds from the root chain and never builds those images.
 *
 * Checks, without needing Docker:
 *   1. Both Dockerfiles delegate to `npm run build:server` instead of repeating the chain.
 *   2. `build:server` includes every transitive internal dependency of @chess-platform/api.
 *   3. Each package appears AFTER everything it depends on.
 *
 * Run: node scripts/check-docker-build-order.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const SCOPE = '@chess-platform/';
const ROOT_PKG = 'package.json';
const DOCKERFILES = ['Dockerfile.api', 'Dockerfile.gateway'];
/** The package each image ultimately needs built; everything else follows from its dependencies. */
const ENTRYPOINT = '@chess-platform/api';

const problems = [];

/**
 * Package name -> manifest path, read from the manifests themselves.
 *
 * A directory name is NOT the package name here: `@chess-platform/core` lives in
 * `packages/chess-core/`. Deriving the path from the name looks obvious and is wrong.
 */
const manifestByName = (() => {
  const map = new Map();
  for (const entry of readdirSync('packages', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = `packages/${entry.name}/package.json`;
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof pkg.name === 'string') map.set(pkg.name, manifest);
  }
  return map;
})();

function internalDeps(pkgName) {
  const manifest = manifestByName.get(pkgName);
  if (!manifest) {
    problems.push(`${pkgName}: no workspace package declares this name`);
    return [];
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  return Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith(SCOPE));
}

/** Everything `ENTRYPOINT` needs, transitively. */
function requiredPackages() {
  const seen = new Set();
  const stack = [ENTRYPOINT];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    stack.push(...internalDeps(name));
  }
  return seen;
}

function main() {
  const root = JSON.parse(readFileSync(ROOT_PKG, 'utf8'));
  const chainScript = root.scripts?.['build:server'];

  if (!chainScript) {
    console.error('✗ root package.json has no "build:server" script');
    process.exit(1);
  }

  const chain = [...chainScript.matchAll(/--workspace\s+(@chess-platform\/[a-z-]+)/g)].map((m) => m[1]);
  const position = new Map(chain.map((name, i) => [name, i]));

  // 1. Dockerfiles must delegate rather than duplicate.
  for (const file of DOCKERFILES) {
    if (!existsSync(file)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    if (!/RUN\s+npm\s+run\s+build:server/.test(text)) {
      problems.push(
        `${file}: does not run "npm run build:server" — a duplicated chain here is what drifted before`,
      );
    }
    if (/--workspace\s+@chess-platform\//.test(text)) {
      problems.push(
        `${file}: still names individual workspaces; the order must live only in build:server`,
      );
    }
  }

  // 2 + 3. The chain must cover every transitive dependency, in a valid order.
  const required = requiredPackages();

  // 4. The RUNTIME stage must ship every one of them too.
  //
  // This is a second hand-maintained list, and it went stale in exactly the same way: with the
  // build order fixed, the image built cleanly and then died at startup with
  // "Cannot find module '@chess-platform/search'", because the runtime stage never copied it.
  // A guard that checked only the build order would have called that image good.
  for (const file of DOCKERFILES) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const copied = new Set(
      [...text.matchAll(/COPY --from=builder[^\n]*?\/app\/packages\/([a-z-]+)\//g)].map((m) => m[1]),
    );
    for (const name of required) {
      const manifest = manifestByName.get(name);
      if (!manifest) continue;
      const dir = manifest.split('/')[1];
      if (!copied.has(dir)) {
        problems.push(
          `${file}: runtime stage never copies packages/${dir} (${name}), which ${ENTRYPOINT} requires — ` +
            'the image will build and then fail at startup with MODULE_NOT_FOUND',
        );
      }
    }
  }
  for (const name of required) {
    if (!position.has(name)) {
      problems.push(`build:server is missing ${name}, which ${ENTRYPOINT} needs (directly or transitively)`);
    }
  }
  for (const name of chain) {
    for (const dep of internalDeps(name)) {
      if (!position.has(dep)) continue; // already reported above
      if (position.get(dep) > position.get(name)) {
        problems.push(`build:server builds ${name} before its dependency ${dep}`);
      }
    }
  }

  console.log('');
  console.log('=== Docker build-order check ===');
  console.log('');
  console.log(`  build:server builds:   ${chain.length} packages`);
  console.log(`  ${ENTRYPOINT} requires: ${required.size} (transitively)`);
  console.log('');

  if (problems.length > 0) {
    console.log('  ✗ Problems:');
    for (const p of problems) console.log(`    - ${p}`);
    console.log('');
    console.log(`=== Results: ${problems.length} problem(s) ===`);
    console.log('The container image build would fail, and no other gate would notice.');
    process.exit(1);
  }

  console.log('=== Results: the server build chain is complete and correctly ordered ===');
}

main();
