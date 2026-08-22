import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AnalysisProvider } from '@chess-platform/engine';
import { AnalysisService } from '../src/analysis/service';
import { VARIANTS } from '../src/domain';
import { startHarness } from './helpers';

const stubProvider: AnalysisProvider = {
  analyze: async () => [],
  play: async () => {
    throw new Error('not implemented in stub');
  },
  capabilitiesFor: () => undefined,
};

test('GET /v1/capabilities returns capability flags for all subsystems when present', async () => {
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: stubProvider }) });
  try {
    const res = await h.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      capabilities: {
        learning: true,
        studies: true,
        achievements: true,
        search: true,
        social: true,
        messaging: true,
        community: true,
        analysis: true,
        moveExplanation: false,
        mistakePrediction: false,
        puzzleGeneration: false,
        // True with no engine configured at all — the only feature flag of which that is so,
        // because the answer is a bundled table lookup rather than a search (ADR-0127).
        openingExplorer: true,
        endgameTrainer: true,
        coach: true,
      },
      // The stub provider has no opinion about engine binaries, so the service permits every
      // variant — the documented default for a double. A real deployment narrows this to whatever
      // it has a configured engine for.
      analysisVariants: [...VARIANTS],
      puzzleVariants: [],
    });
  } finally {
    await h.close();
  }
});

test('GET /v1/capabilities reports false for absent repositories driven by dependency injection', async () => {
  const h = await startHarness(
    {},
    {
      withoutLearning: true,
      withoutStudies: true,
      withoutAchievements: true,
    },
  );
  try {
    const res = await h.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.body.capabilities.learning, false);
    assert.equal(res.body.capabilities.studies, false);
    assert.equal(res.body.capabilities.achievements, false);
    assert.equal(res.body.capabilities.search, true);
    assert.equal(res.body.capabilities.social, true);
    assert.equal(res.body.capabilities.messaging, true);
    assert.equal(res.body.capabilities.community, true);
    assert.equal(res.body.capabilities.analysis, false);
  } finally {
    await h.close();
  }
});

/**
 * The variant list is what a client uses to decide whether to offer analysis on a given game, so it
 * has to narrow when the deployment does.
 *
 * ADR-0113 registers only engines whose binary is configured and the production image carries
 * Stockfish alone, so `analysis: true` coexists with a 422 for the six Fairy-only variants. A client
 * reading the flag alone offered a control that could never work on most variants — raised in the
 * Qodo review of PR #133.
 */
test('GET /v1/capabilities narrows analysisVariants to what the deployment can serve', async () => {
  const stockfishOnly = new AnalysisService({
    provider: stubProvider,
    supportsVariant: (variant) => variant === 'standard' || variant === 'chess960',
  });
  const h = await startHarness({}, { analysis: stockfishOnly });
  try {
    const res = await h.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.body.capabilities.analysis, true, 'the feature is on');
    assert.deepEqual(
      res.body.analysisVariants,
      ['standard', 'chess960'],
      'but only the variants with a configured engine are advertised',
    );
  } finally {
    await h.close();
  }
});

/** Analysis off means nothing is analysable, so a client never has to read both fields. */
test('GET /v1/capabilities reports an empty analysisVariants when analysis is absent', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('GET', '/v1/capabilities');
    assert.equal(res.body.capabilities.analysis, false);
    assert.deepEqual(res.body.analysisVariants, []);
  } finally {
    await h.close();
  }
});
