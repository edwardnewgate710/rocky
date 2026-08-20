/**
 * The production composition root actually builds the analysis subsystem.
 *
 * This is the test that was missing when the increment first landed, and its absence hid the whole
 * thing. Every unit test passed, the route was correct, the schema was correct, `Dockerfile.api`
 * installed Stockfish, ADR-0113 described a working endpoint — and `createPgDependencies` never
 * called `createAnalysisFromEnv`, so in production `deps.analysis` was permanently `undefined`,
 * `GET /v1/capabilities` reported `analysis: false`, and `POST /v1/analysis` answered
 * "analysis is not configured" to every request forever. Raised as a blocker in independent review
 * of PR #132.
 *
 * The failure mode is worth naming: nothing about it is visible from inside the subsystem. Only a
 * test that asks the real composition root what it produced can see it, which is why this asserts
 * on `createPgDependencies` rather than on anything under `src/analysis/`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPgDependencies } from '../src/bootstrap';

/** `createPgDependencies` needs a token secret; it never connects the pool in these tests. */
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  const applied = { ACCESS_TOKEN_SECRET: 'test-secret-at-least-32-chars-long-12345', ...overrides };
  for (const [key, value] of Object.entries(applied)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('createPgDependencies: wires deps.analysis when an engine binary is configured', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: '/usr/local/bin/stockfish' }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.ok(
      deps.analysis !== undefined,
      'STOCKFISH_PATH is set, so the production composition must build the analysis service',
    );
  });
});

test('createPgDependencies: leaves deps.analysis undefined when no engine binary is configured', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: undefined, FAIRY_STOCKFISH_PATH: undefined }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.equal(
      deps.analysis,
      undefined,
      'without a binary the capability must report off rather than failing at request time',
    );
  });
});

/**
 * The pool owns OS processes, so the composition root has to hand the caller a way to stop them.
 * `scripts/serve.ts` calls this on SIGTERM; without it the engines are killed rather than drained.
 * Resolves cleanly in the state it is most often called in — nothing analysed, so `minWorkers: 0`
 * means no worker was ever spawned.
 */
test('createPgDependencies: returns a shutdown handle that resolves with no engine configured', async () => {
  const pool = new Pool();
  const shutdown = withEnv({ STOCKFISH_PATH: undefined, FAIRY_STOCKFISH_PATH: undefined }, () => {
    return createPgDependencies({ pool }).shutdownAnalysis;
  });
  await shutdown();
});

test('createPgDependencies: the shutdown handle drains a configured but never-used pool', async () => {
  const pool = new Pool();
  const shutdown = withEnv({ STOCKFISH_PATH: '/nonexistent/stockfish' }, () => {
    return createPgDependencies({ pool }).shutdownAnalysis;
  });
  await shutdown();
});
