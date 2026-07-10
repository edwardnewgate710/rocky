/**
 * Env-gated integration test for `VoiceCoach`.
 *
 * Skips without an API key, same pattern as the other seven features.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { OpenAiCompatibleAdapter, AnthropicAdapter } from '@chess-platform/ai-orchestrator';

import { VoiceCoach } from '../src/index.js';
import { Coach } from '../src/coach.js';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const fakeEngine: AnalysisProvider = {
  async analyze(_req: AnalysisRequest): Promise<readonly EngineResult[]> {
    return [{ multipv: 1, evaluation: { type: 'cp', value: 200 }, principalVariation: ['g1f3'], depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000 }];
  },
  async play(_req: PlayRequest): Promise<PlayResult> { return { move: 'g1f3' }; },
  capabilitiesFor(_v: string): EngineCapabilities | undefined { return undefined; },
};

const openaiKey = process.env['OPENAI_API_KEY'];

describe('VoiceCoach integration (OpenAI)', () => {
  test('real narrative smoothing with spoken segments', { skip: !openaiKey }, async () => {
    const ai = new OpenAiCompatibleAdapter({ id: 'openai', apiKey: openaiKey, defaultModel: 'gpt-4o-mini' });
    const coach = new Coach({ engine: fakeEngine });
    const voiceCoach = new VoiceCoach({ coach, ai });

    const spoken = await voiceCoach.coachAloud({ fen: STARTPOS, move: 'a2a3' });

    assert.ok(spoken.segments.length > 0);
    // Should have a narrative segment from the LLM smoothing.
    const narrativeSeg = spoken.segments.find((s) => s.kind === 'narrative');
    assert.ok(narrativeSeg, 'Should have narrative from LLM smoothing');
    assert.ok(narrativeSeg!.text.length > 0);
  });
});

const anthropicKey = process.env['ANTHROPIC_API_KEY'];

describe('VoiceCoach integration (Anthropic)', () => {
  test('real narrative smoothing with spoken segments', { skip: !anthropicKey }, async () => {
    const ai = new AnthropicAdapter({ apiKey: anthropicKey, defaultModel: 'claude-3-5-sonnet-20241022' });
    const coach = new Coach({ engine: fakeEngine });
    const voiceCoach = new VoiceCoach({ coach, ai });

    const spoken = await voiceCoach.coachAloud({ fen: STARTPOS, move: 'a2a3' });

    assert.ok(spoken.segments.length > 0);
    const narrativeSeg = spoken.segments.find((s) => s.kind === 'narrative');
    assert.ok(narrativeSeg, 'Should have narrative from LLM smoothing');
    assert.ok(narrativeSeg!.text.length > 0);
  });
});
