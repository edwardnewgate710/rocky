/**
 * Hermetic test suite for `TournamentCommentator`.
 *
 * Uses `FakeEngineTransport` and `FakeProvider` to ensure the commentator
 * behaves correctly without network or keys.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { TournamentCommentator } from '../src/index.js';
import type { MomentCommentaryRequest, RoundRecapRequest } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createFakeAnalysisProvider(
  goHandler: (goCommand: string, positionFen: string | null) => { info: readonly string[]; bestmove: string; ponder?: string } | 'hang',
): AnalysisProvider {
  const transport = new FakeEngineTransport({
    name: 'FakeStockfish 1.0',
    author: 'chess-platform',
    go: goHandler,
  });

  const instance = new UciEngineInstance(transport, { id: 'fake-1' });

  return {
    async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
      await instance.init();
      return await instance.analyze({
        fen: request.fen,
        limits: request.limits,
        multiPv: request.multiPv ?? 1,
        signal: request.signal,
      });
    },
    async play(request: PlayRequest): Promise<PlayResult> {
      await instance.init();
      return await instance.play({
        fen: request.fen,
        limits: request.limits,
        multiPv: 1,
        strength: request.strength,
        signal: request.signal,
      });
    },
    capabilitiesFor(variant: string): EngineCapabilities | undefined {
      if (variant === 'chess' || variant === undefined) {
        return {
          engineName: 'FakeStockfish',
          engineAuthor: 'chess-platform',
          version: '1.0',
          fingerprint: 'fake-fingerprint',
          variants: new Set(['chess']),
          options: new Map(),
          supportsMultiPv: true,
          supportsLimitStrength: true,
          supportsSkillLevel: true,
          supportsPonder: true,
        };
      }
      return undefined;
    },
  };
}

const STARTPOS_AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

function fakeGoHandler(): { info: readonly string[]; bestmove: string } {
  return {
    info: ['info depth 20 seldepth 25 multipv 1 score cp -35 nodes 1000000 nps 500000 time 2000 pv e7e5 g1f3 b8c6 f1b5'],
    bestmove: 'e7e5',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TournamentCommentator (hermetic)', () => {
  describe('commentateMoment', () => {
    test('produces engine-grounded commentary with tournament context', async () => {
      const engine = createFakeAnalysisProvider(fakeGoHandler);
      const ai = new FakeProvider({
        id: 'fake-ai',
        content: 'Magnus Carlsen plays a bold 1...e5 against Hikaru in the finals!',
      });

      const commentator = new TournamentCommentator({ engine, ai });
      
      const request: MomentCommentaryRequest = {
        fen: STARTPOS_AFTER_E4,
        lastMove: 'e7e5',
        context: {
          whitePlayer: 'Hikaru Nakamura',
          blackPlayer: 'Magnus Carlsen',
          round: 'Finals',
          event: 'World Championship',
          stakes: 'The title is on the line.',
        },
      };

      const result = await commentator.commentateMoment(request);

      assert.ok(result.commentary.includes('Magnus Carlsen'));
      assert.equal(result.citation.evalKind, 'cp');
      assert.equal(result.citation.evalValue, -35);
      
      // Verify that the prompt included the tournament context
      assert.equal(ai.calls.length, 1);
      const call = ai.calls[0];
      const userMessage = call.messages.find(m => m.role === 'user');
      assert.ok(userMessage);
      assert.ok(userMessage.content.includes('White: Hikaru Nakamura'));
      assert.ok(userMessage.content.includes('Black: Magnus Carlsen'));
      assert.ok(userMessage.content.includes('Round: Finals'));
      assert.ok(userMessage.content.includes('Event: World Championship'));
      assert.ok(userMessage.content.includes('Stakes: The title is on the line.'));
    });

    test('accepts pre-computed analysis and skips engine call', async () => {
      const engine: AnalysisProvider = {
        async analyze(): Promise<readonly EngineResult[]> {
          throw new Error('Engine should not be called');
        },
        async play(): Promise<PlayResult> {
          throw new Error('Engine should not be called');
        },
        capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
      };

      const ai = new FakeProvider({ id: 'fake-ai', content: 'What a move.' });
      const commentator = new TournamentCommentator({ engine, ai });

      const analysis: EngineResult[] = [
        {
          multipv: 1,
          evaluation: { type: 'mate', value: 3 },
          principalVariation: ['qf7'],
          depth: 25,
          selDepth: 30,
          nodes: 1000,
          nps: 1000,
          timeMs: 1000,
        },
      ];

      const result = await commentator.commentateMoment({
        fen: STARTPOS_AFTER_E4,
        context: { whitePlayer: 'W', blackPlayer: 'B' },
        analysis,
      });

      assert.equal(result.citation.evalKind, 'mate');
      assert.equal(result.citation.evalValue, 3);
    });
  });

  describe('recapRound', () => {
    test('produces data-grounded narrative recap', async () => {
      const engine = createFakeAnalysisProvider(fakeGoHandler);
      const ai = new FakeProvider({
        id: 'fake-ai',
        content: 'Round 1 of the Titled Tuesday saw Hikaru defeat Magnus, putting him at the top of the standings.',
      });

      const commentator = new TournamentCommentator({ engine, ai });
      
      const request: RoundRecapRequest = {
        event: 'Titled Tuesday',
        round: 1,
        results: [
          { white: 'Hikaru', black: 'Magnus', result: '1-0' },
          { white: 'Fabiano', black: 'Ian', result: '1/2-1/2' },
        ],
        standings: [
          { rank: 1, player: 'Hikaru', points: 1 },
          { rank: 2, player: 'Fabiano', points: 0.5 },
          { rank: 3, player: 'Ian', points: 0.5 },
          { rank: 4, player: 'Magnus', points: 0 },
        ],
      };

      const result = await commentator.recapRound(request);

      assert.ok(result.recap.includes('Hikaru'));
      
      assert.equal(ai.calls.length, 1);
      const call = ai.calls[0];
      const systemMessage = call.messages.find(m => m.role === 'system');
      const userMessage = call.messages.find(m => m.role === 'user');
      
      assert.ok(systemMessage);
      assert.ok(systemMessage.content.includes('never hallucinate unprovided details'));
      
      assert.ok(userMessage);
      assert.ok(userMessage.content.includes('Titled Tuesday'));
      assert.ok(userMessage.content.includes('Round 1'));
      assert.ok(userMessage.content.includes('Hikaru vs Magnus: 1-0'));
      assert.ok(userMessage.content.includes('2. Fabiano (0.5 pts)'));
    });
  });
});
