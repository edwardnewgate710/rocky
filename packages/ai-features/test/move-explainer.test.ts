/**
 * Hermetic test suite for `MoveExplainer`.
 *
 * Drives the explainer end-to-end with `FakeEngineTransport` (via a
 * lightweight `AnalysisProvider` fake) + `FakeProvider` (M7's fake AI
 * provider).  No keys, no binary, no network.
 *
 * The tests assert that the explanation carries the correct grounded
 * eval and best-line citation for a known position — the citation is
 * a distinct, testable field, not prose the test has to parse.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance, JobPriority } from '@chess-platform/engine';
import { FakeProvider, engineResultsToGrounding } from '@chess-platform/ai-orchestrator';

import { MoveExplainer } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers: build a real AnalysisProvider backed by FakeEngineTransport
// ---------------------------------------------------------------------------

/**
 * Creates an `AnalysisProvider` backed by a `FakeEngineTransport` that
 * returns scripted `info` lines + `bestmove` for a given FEN.  This
 * exercises the real UCI parsing path (info lines → EngineResult) while
 * remaining fully deterministic — no binary, no network.
 */
function createFakeAnalysisProvider(
  goHandler: (goCommand: string, positionFen: string | null) => { info: readonly string[]; bestmove: string; ponder?: string } | 'hang',
): AnalysisProvider {
  const transport = new FakeEngineTransport({
    name: 'FakeStockfish 1.0',
    author: 'chess-platform',
    go: goHandler,
  });

  const instance = new UciEngineInstance(transport, { id: 'fake-1' });

  // We need to init the instance (uci handshake + isready) before it can analyze.
  // This happens asynchronously via the transport's microtask emission.

  const provider: AnalysisProvider = {
    async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
      // Ensure the instance is initialised.
      await instance.init();
      const results = await instance.analyze({
        fen: request.fen,
        limits: request.limits,
        multiPv: request.multiPv ?? 1,
        signal: request.signal,
      });
      return results;
    },
    async play(request: PlayRequest): Promise<PlayResult> {
      await instance.init();
      const result = await instance.play({
        fen: request.fen,
        limits: request.limits,
        multiPv: 1,
        strength: request.strength,
        signal: request.signal,
      });
      return result;
    },
    capabilitiesFor(variant: string): EngineCapabilities | undefined {
      // Return a minimal capability set for the 'chess' variant.
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

  return provider;
}

// ---------------------------------------------------------------------------
// Known position: starting position after 1.e4
// FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1
// Engine says: eval +35cp (from side to move = Black's perspective),
// best line: e7e5, g1f3, b8c6, f1b5
// ---------------------------------------------------------------------------

const STARTPOS_AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

/** Scripted info lines that the FakeEngineTransport will emit for a `go` command. */
const FAKE_INFO_LINES: readonly string[] = [
  'info depth 20 seldepth 25 multipv 1 score cp -35 nodes 1000000 nps 500000 time 2000 pv e7e5 g1f3 b8c6 f1b5',
];

function fakeGoHandler(
  goCommand: string,
  positionFen: string | null,
): { info: readonly string[]; bestmove: string } {
  // Return the scripted analysis regardless of the exact position,
  // since the FakeEngineTransport doesn't actually play chess.
  return {
    info: FAKE_INFO_LINES,
    bestmove: 'e7e5',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MoveExplainer (hermetic)', () => {

  test('produces a grounded explanation with correct engine citation', async () => {
    const engine = createFakeAnalysisProvider(fakeGoHandler);
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'After 1.e4, Black responds with 1...e5, fighting for the center. The engine evaluates the position as roughly equal at -0.35 from Black\'s perspective, confirming this is a solid response. The best line continues e7e5 g1f3 b8c6 f1b5, leading to a standard Ruy Lopez setup.',
    });

    const explainer = new MoveExplainer({ engine, ai });
    const result = await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
      side: 'black',
    });

    // The explanation is non-empty prose.
    assert.ok(result.explanation.length > 0);
    assert.ok(result.explanation.includes('e5'));

    // The citation is a distinct, testable field.
    assert.equal(result.citation.fen, STARTPOS_AFTER_E4);
    assert.equal(result.citation.move, 'e7e5');
    assert.equal(result.citation.evalKind, 'cp');
    assert.equal(result.citation.evalValue, -35);
    assert.equal(result.citation.evalLabel, '-0.35');
    assert.deepEqual([...result.citation.bestLine], ['e7e5', 'g1f3', 'b8c6', 'f1b5']);
    assert.equal(result.citation.depth, 20);

    // The provider and model are from the fake.
    assert.equal(result.providerId, 'fake-ai');
    assert.equal(result.model, 'fake-model');

    // Usage is populated.
    assert.ok(result.usage.totalTokens > 0);
  });

  test('citation eval is from the side-to-move perspective', async () => {
    // The FEN has Black to move, so eval is from Black's perspective.
    // A +35 eval would mean Black is better; -35 means White is better.
    // Our fake returns cp -35, meaning White is slightly better.
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 18 seldepth 22 multipv 1 score cp -35 nodes 500000 nps 300000 time 1500 pv e7e5 g1f3'],
      bestmove: 'e7e5',
    }));
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Explanation.' });

    const explainer = new MoveExplainer({ engine, ai });
    const result = await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
    });

    assert.equal(result.citation.evalKind, 'cp');
    assert.equal(result.citation.evalValue, -35);
    assert.equal(result.citation.evalLabel, '-0.35');
  });

  test('handles mate evaluation in citation', async () => {
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 15 seldepth 15 multipv 1 score mate 3 nodes 500000 nps 300000 time 1500 pv qh5xf7'],
      bestmove: 'e7e5',
    }));
    const ai = new FakeProvider({ id: 'fake-ai', content: 'This is a forced mate in 3.' });

    const explainer = new MoveExplainer({ engine, ai });
    const result = await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
    });

    assert.equal(result.citation.evalKind, 'mate');
    assert.equal(result.citation.evalValue, 3);
    assert.equal(result.citation.evalLabel, 'mate in 3');
  });

  test('accepts pre-computed analysis and skips engine call', async () => {
    // Use a fake engine that would throw if called.
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Engine should not be called when pre-computed analysis is supplied');
      },
      async play(): Promise<PlayResult> {
        throw new Error('play should not be called');
      },
      capabilitiesFor(): EngineCapabilities | undefined {
        return undefined;
      },
    };

    const ai = new FakeProvider({ id: 'fake-ai', content: 'Good move.' });

    const preComputed: EngineResult[] = [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 50 },
        principalVariation: ['e7e5', 'g1f3', 'b8c6'],
        depth: 22,
        selDepth: 28,
        nodes: 2_000_000,
        nps: 800_000,
        timeMs: 2500,
      },
    ];

    const explainer = new MoveExplainer({ engine, ai });
    const result = await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
      analysis: preComputed,
    });

    assert.equal(result.citation.evalValue, 50);
    assert.equal(result.citation.evalLabel, '+0.50');
    assert.deepEqual([...result.citation.bestLine], ['e7e5', 'g1f3', 'b8c6']);
    assert.equal(result.citation.depth, 22);
  });

  test('grounding is passed to the AI provider via the completion request', async () => {
    const engine = createFakeAnalysisProvider(fakeGoHandler);
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'Explanation citing engine eval.',
    });

    const explainer = new MoveExplainer({ engine, ai });
    await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
    });

    // The FakeProvider logs all calls; verify the grounding was passed.
    assert.equal(ai.calls.length, 1);
    const call = ai.calls[0];
    assert.equal(call.task, 'explanation');
    assert.ok(call.grounding);
    assert.equal(call.grounding!.fen, STARTPOS_AFTER_E4);
    assert.equal(call.grounding!.moveUci, 'e7e5');
    assert.equal(call.grounding!.evalCp, -35);
    assert.ok(call.grounding!.bestLine);
    assert.deepEqual([...call.grounding!.bestLine!], ['e7e5', 'g1f3', 'b8c6', 'f1b5']);
  });

  test('grounded messages include the engine evaluation and best line', async () => {
    const engine = createFakeAnalysisProvider(fakeGoHandler);
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Explanation.' });

    const explainer = new MoveExplainer({ engine, ai });
    await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
    });

    // The FakeProvider's call log has the messages that were sent.
    const call = ai.calls[0];
    const systemMessages = call.messages.filter(m => m.role === 'system');
    assert.ok(systemMessages.length >= 1);

    // The grounding system message should contain the eval and best line.
    const groundingMsg = systemMessages.find(m =>
      m.content.includes('Engine evaluation') && m.content.includes('Best line'),
    );
    assert.ok(groundingMsg, 'A grounding system message should be present');
    assert.ok(groundingMsg!.content.includes('-0.35'));
    assert.ok(groundingMsg!.content.includes('e7e5 g1f3 b8c6 f1b5'));
    assert.ok(groundingMsg!.content.includes(STARTPOS_AFTER_E4));
  });

  test('uses default variant and limits when not specified', async () => {
    const engine = createFakeAnalysisProvider(fakeGoHandler);
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Explanation.' });

    const explainer = new MoveExplainer({
      engine,
      ai,
      defaultVariant: 'chess',
      defaultLimits: { depth: 15 },
    });

    const result = await explainer.explain({
      fen: STARTPOS_AFTER_E4,
      move: 'e7e5',
    });

    // Should still work and produce a valid citation.
    assert.equal(result.citation.move, 'e7e5');
    assert.equal(result.citation.evalValue, -35);
  });

  test('propagates AbortSignal to engine and AI provider', async () => {
    const engine = createFakeAnalysisProvider(fakeGoHandler);
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Explanation.' });

    const explainer = new MoveExplainer({ engine, ai });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => explainer.explain({
        fen: STARTPOS_AFTER_E4,
        move: 'e7e5',
        signal: controller.signal,
      }),
    );
  });
});
