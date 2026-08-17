import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AnalysisProvider } from '@chess-platform/engine';
import { AnalysisService } from '../src/analysis/service';
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
      },
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
