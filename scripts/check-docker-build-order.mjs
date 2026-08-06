#!/usr/bin/env node
/**
 * Fails when container build chains cannot actually build images.
 *
 * Build chains in root `package.json` are hand-maintained and ordered, because packages resolve one
 * another's types from built `dist/` output. Add a cross-package dependency without reordering it
 * and the build breaks — which is what happened for server images (M11 inc 5) and the web image (M14 inc 37).
 *
 * Checks, without needing Docker:
 *   1. All Dockerfiles delegate to their root build script (`build:server`, `build:web`) instead of repeating chains.
 *   2. The chain scripts include every transitive internal dependency of their entrypoint package.
 *   3. Each package appears AFTER everything it depends on.
 *   4. Server runtime stages copy all required dependency output.
 *
 * Run: node scripts/check-docker-build-order.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const SCOPE = '@chess-platform/';
const ROOT_PKG = 'package.json';

const TARGETS = [
  {
    scriptName: 'build:server',
    entrypoint: '@chess-platform/api',
    dockerfiles: ['Dockerfile.api', 'Dockerfile.gateway'],
    checkRuntimeCopies: true,
  },
  {
    scriptName: 'build:web',
    entrypoint: '@chess-platform/web',
    dockerfiles: ['Dockerfile.web'],
    checkRuntimeCopies: false,
  },
];

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

/** Everything `entrypoint` needs, transitively. */
function requiredPackages(entrypoint) {
  const seen = new Set();
  const stack = [entrypoint];
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
  const totalSummary = [];

  for (const target of TARGETS) {
    const { scriptName, entrypoint, dockerfiles, checkRuntimeCopies } = target;
    const chainScript = root.scripts?.[scriptName];

    if (!chainScript) {
      problems.push(`root package.json has no "${scriptName}" script`);
      continue;
    }

    const chain = [...chainScript.matchAll(/--workspace\s+(@chess-platform\/[a-z-]+)/g)].map((m) => m[1]);
    const position = new Map(chain.map((name, i) => [name, i]));

    // 1. Dockerfiles must delegate rather than duplicate.
    for (const file of dockerfiles) {
      if (!existsSync(file)) {
        problems.push(`${file}: missing`);
        continue;
      }
      const text = readFileSync(file, 'utf8');
      const delegateRegex = new RegExp(`RUN\\s+npm\\s+run\\s+${scriptName}`);
      if (!delegateRegex.test(text)) {
        problems.push(
          `${file}: does not run "npm run ${scriptName}" — a duplicated chain here is what drifted before`,
        );
      }
      if (/--workspace\s+@chess-platform\//.test(text)) {
        problems.push(
          `${file}: still names individual workspaces; the order must live only in ${scriptName}`,
        );
      }
    }

    // 2 + 3. The chain must cover every transitive dependency, in a valid order.
    const required = requiredPackages(entrypoint);

    // 4. The RUNTIME stage must ship every required dependency (for server images).
    if (checkRuntimeCopies) {
      for (const file of dockerfiles) {
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
              `${file}: runtime stage never copies packages/${dir} (${name}), which ${entrypoint} requires — ` +
                'the image will build and then fail at startup with MODULE_NOT_FOUND',
            );
          }
        }
      }
    }

    for (const name of required) {
      if (!position.has(name)) {
        problems.push(`${scriptName} is missing ${name}, which ${entrypoint} needs (directly or transitively)`);
      }
    }
    for (const name of chain) {
      for (const dep of internalDeps(name)) {
        if (!position.has(dep)) continue;
        if (position.get(dep) > position.get(name)) {
          problems.push(`${scriptName} builds ${name} before its dependency ${dep}`);
        }
      }
    }

    totalSummary.push(`${scriptName} builds ${chain.length} packages for ${entrypoint} (${required.size} required)`);
  }

  console.log('');
  console.log('=== Docker build-order check ===');
  console.log('');
  for (const line of totalSummary) {
    console.log(`  ${line}`);
  }
  console.log('');

  if (problems.length > 0) {
    console.log('  ✗ Problems:');
    for (const p of problems) console.log(`    - ${p}`);
    console.log('');
    console.log(`=== Results: ${problems.length} problem(s) ===`);
    console.log('The container image build would fail, and no other gate would notice.');
    process.exit(1);
  }

  console.log('=== Results: all container build chains are complete and correctly ordered ===');
}

main();
