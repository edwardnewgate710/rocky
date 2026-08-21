/**
 * The production composition root actually builds Move Explanation — and refuses to when it cannot
 * ground it.
 *
 * The sibling file `bootstrap-analysis.test.ts` exists because ADR-0113 shipped an endpoint that was
 * correct in every unit test and permanently `undefined` in production: `createPgDependencies` never
 * called `createAnalysisFromEnv`. Nothing inside the subsystem could see that, and nothing did, until
 * independent review of PR #132 found it. This increment adds a second optional dependency composed
 * from two independent halves, so it has strictly more ways to be silently absent — or, worse,
 * silently present without an engine behind it.
 *
 * Everything here asks the real `createPgDependencies` what it produced. Nothing under `src/ai/` is
 * consulted, because the bug this guards against is invisible from there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPgDependencies } from '../src/bootstrap';
import { capabilitiesView } from '../src/presenters';

const ENGINE = '/usr/games/stockfish';

/** `createPgDependencies` needs a token secret; it never connects the pool in these tests. */
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  const applied = {
    ACCESS_TOKEN_SECRET: 'test-secret-at-least-32-chars-long-12345',
    NODE_ENV: 'test',
    EMAIL_PROVIDER: 'console',
    // Cleared by default so a developer's own key in the ambient environment cannot make a test
    // that asserts "absent" pass or fail for reasons the test never stated.
    AI_OPENAI_API_KEY: undefined,
    AI_OPENAI_BASE_URL: undefined,
    AI_ANTHROPIC_API_KEY: undefined,
    STOCKFISH_PATH: undefined,
    FAIRY_STOCKFISH_PATH: undefined,
    ANALYSIS_MAX_DEPTH: undefined,
    ANALYSIS_MAX_TIME_MS: undefined,
    ANALYSIS_MAX_MULTIPV: undefined,
    ...overrides,
  };
  const saveKeys = new Set([...Object.keys(applied)]);
  for (const key of saveKeys) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(applied)) {
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

test('createPgDependencies: wires deps.moveExplanation when an AI provider and an engine are both configured', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: ENGINE, AI_OPENAI_API_KEY: 'test-key-not-a-real-credential' }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.ok(
      deps.moveExplanation !== undefined,
      'both halves are configured, so the production composition must build the feature',
    );
  });
});

/**
 * The half that matters most. An AI provider with no engine must compose *nothing*, because the
 * degraded form of this feature — a language model asked whether a move is good, with no engine
 * output to defer to — is precisely the unfounded verdict the grounding requirement exists to
 * prevent. Failing closed is the only safe direction.
 */
test('createPgDependencies: leaves deps.moveExplanation undefined when no engine is configured', () => {
  const pool = new Pool();
  withEnv({ AI_OPENAI_API_KEY: 'test-key-not-a-real-credential' }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.equal(deps.analysis, undefined, 'precondition: no engine');
    assert.equal(
      deps.moveExplanation,
      undefined,
      'an explanation with no engine to ground it must not be composed at all',
    );
  });
});

test('createPgDependencies: leaves deps.moveExplanation undefined when no AI provider is configured', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: ENGINE }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.ok(deps.analysis !== undefined, 'precondition: analysis is configured on its own');
    assert.equal(
      deps.moveExplanation,
      undefined,
      'no provider means the capability reports off, never a default vendor chosen on our behalf',
    );
  });
});

test('createPgDependencies composes puzzle generation exactly when analysis is configured', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: ENGINE }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.ok(deps.analysis !== undefined);
    assert.ok(deps.puzzleGeneration !== undefined);
    assert.equal(capabilitiesView(deps).capabilities.puzzleGeneration, true);
  });
  withEnv({}, () => {
    const { deps } = createPgDependencies({ pool });
    assert.equal(deps.analysis, undefined);
    assert.equal(deps.puzzleGeneration, undefined);
    assert.deepEqual(capabilitiesView(deps).puzzleVariants, []);
  });
});

test('createPgDependencies does not advertise puzzle generation below its fixed analysis policy', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: ENGINE, ANALYSIS_MAX_MULTIPV: '2' }, () => {
    const { deps } = createPgDependencies({ pool });
    assert.ok(deps.analysis !== undefined, 'generic analysis remains available at MultiPV 2');
    assert.equal(deps.puzzleGeneration, undefined);
    assert.equal(capabilitiesView(deps).capabilities.puzzleGeneration, false);
    assert.deepEqual(capabilitiesView(deps).puzzleVariants, []);
  });
});

/**
 * Capability discovery has to agree with what was actually built, in both directions.
 *
 * Advertising a feature that is not composed is how the browser gets a control whose every request
 * answers 503 — the failure ADR-0114 Decision 7 was written about. Reading the flag off the same
 * dependencies the routes use is what keeps the two from drifting.
 */
test('GET /v1/capabilities reports moveExplanation exactly as the composition root built it', () => {
  const pool = new Pool();

  const configured = withEnv(
    { STOCKFISH_PATH: ENGINE, AI_OPENAI_API_KEY: 'test-key-not-a-real-credential' },
    () => capabilitiesView(createPgDependencies({ pool }).deps),
  );
  assert.equal(configured.capabilities.moveExplanation, true);
  assert.equal(configured.capabilities.analysis, true, 'move explanation implies analysis');

  const unconfigured = withEnv({ STOCKFISH_PATH: ENGINE }, () =>
    capabilitiesView(createPgDependencies({ pool }).deps),
  );
  assert.equal(unconfigured.capabilities.moveExplanation, false);
  assert.equal(unconfigured.capabilities.analysis, true, 'analysis stands on its own');
});

/**
 * Move Explanation serves exactly the variants analysis serves, so no second list is published.
 *
 * The property is what makes reusing `analysisVariants` in the client honest. If the two ever
 * diverge, this fails and whoever caused it has to publish the second list deliberately rather than
 * discovering the mismatch as a 422 in the browser.
 */
test('the variants Move Explanation can serve are exactly the advertised analysis variants', () => {
  const pool = new Pool();
  withEnv({ STOCKFISH_PATH: ENGINE, AI_OPENAI_API_KEY: 'test-key-not-a-real-credential' }, () => {
    const view = capabilitiesView(createPgDependencies({ pool }).deps);
    const explanation = createPgDependencies({ pool }).deps.moveExplanation;
    assert.ok(explanation !== undefined);
    for (const variant of view.analysisVariants) {
      assert.equal(
        explanation.supportsVariant(variant),
        true,
        `${variant} is advertised as analysable, so it must be explainable`,
      );
    }
    assert.ok(view.analysisVariants.length > 0, 'the fixture engine serves at least one variant');
  });
});

/**
 * Composition is a pure function of the environment: no sockets, no DNS, no vendor round-trip.
 *
 * `AiOrchestrator.registerProvider` discovers capabilities by calling the provider, and the
 * OpenAI-compatible adapter implements that by listing models over HTTP. Composing that way would
 * make process start-up depend on a third party being reachable — a slow or unreachable vendor would
 * become a slow or failed boot. `ai/composition.ts` registers static capabilities instead, and this
 * is what holds it there.
 */
test('building the AI subsystem performs no network I/O', () => {
  const pool = new Pool();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
    calls += 1;
    return realFetch(...args);
  }) as typeof realFetch;
  try {
    withEnv({ STOCKFISH_PATH: ENGINE, AI_OPENAI_API_KEY: 'test-key-not-a-real-credential' }, () => {
      const { deps } = createPgDependencies({ pool });
      assert.ok(deps.moveExplanation !== undefined);
    });
    assert.equal(calls, 0, 'composition must not call a provider API');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The AI subsystem adds no shutdown handle because it owns nothing that outlives a request — no
 * interval, no pool, no persistent connection. This asserts the composition root still returns
 * exactly the one handle it did before, so a future adapter that *does* acquire a resource cannot
 * quietly arrive without someone updating the lifecycle contract. See `ai/composition.ts`.
 */
test('composing Move Explanation adds no lifecycle handle beyond the analysis one', async () => {
  const pool = new Pool();
  const result = withEnv(
    { STOCKFISH_PATH: ENGINE, AI_OPENAI_API_KEY: 'test-key-not-a-real-credential' },
    () => createPgDependencies({ pool }),
  );
  assert.deepEqual(
    Object.keys(result).filter((key) => key.startsWith('shutdown')),
    ['shutdownAnalysis'],
  );
  await result.shutdownAnalysis();
});
