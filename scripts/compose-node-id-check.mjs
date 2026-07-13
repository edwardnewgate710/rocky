#!/usr/bin/env node
/**
 * Regression check: docker compose config must NOT emit a fixed NODE_ID
 * for the gateway service when HOSTNAME is absent.
 *
 * Previously, docker-compose.yml set `NODE_ID: gateway-${HOSTNAME}`, which
 * Docker Compose expanded on the host (where HOSTNAME is often unset),
 * producing `NODE_ID=gateway-`. The fix removes NODE_ID from Compose so
 * services/gateway/src/serve.ts uses its `gw-${randomUUID()}` fallback.
 *
 * This script verifies the fix by:
 * 1. Running `docker compose config` with HOSTNAME unset.
 * 2. Checking that no NODE_ID env var appears in the rendered output.
 *
 * If Docker Compose is not installed, falls back to a grep of docker-compose.yml.
 *
 * Usage: node scripts/compose-node-id-check.mjs
 * Exit: 0 = pass, 1 = fail
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const composeFile = join(repoRoot, 'docker-compose.yml');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`✓ ${msg}`);
  process.exit(0);
}

// Try `docker compose config` first (renders env interpolation).
try {
  const env = { ...process.env, HOSTNAME: '' };
  const output = execSync('docker compose -f docker-compose.yml config', {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (output.includes('NODE_ID')) {
    fail('docker compose config still emits NODE_ID — the regression is present');
  }
  pass('docker compose config does not emit NODE_ID for the gateway service');
} catch (err) {
  // Docker Compose not available — fall back to grep.
  const content = readFileSync(composeFile, 'utf-8');
  if (content.includes('NODE_ID')) {
    fail('docker-compose.yml still contains NODE_ID — the regression is present');
  }
  pass('docker-compose.yml does not contain NODE_ID (Docker Compose CLI unavailable, used file grep)');
}
