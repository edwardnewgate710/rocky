/**
 * Hermetic test suite for `MistakePredictor`.
 *
 * No keys, no binary, no network. Most tests supply pre-computed analysis directly, which is not a
 * shortcut but the production path: since M15 increment 5 the API owns the one analysis subsystem
 * and hands its results in, and the predictor is composed with no engine at all so that a second
 * engine pool is unrepresentable rather than merely discouraged (ADR-0118). A separate group drives
 * the injected-engine path, which the library still supports for callers that own no subsystem.
 *
 * The M8 version of this file asserted several things that were defects rather than behaviour: the
 * `chess` variant vocabulary, `centipawnLoss: Infinity`, caller-supplied thresholds, and a
 * post-move engine search of a position the game had already ended in. Those assertions are gone,
 * and the cases that replaced them say so.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities, Evaluation } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';
import type { CompletionPort, CompletionRequest, CompletionResponse } from '@chess-platform/ai-orchestrator';
import { Position } from '@chess-platform/core';

import {
  MistakePredictor,
  negateEval,
  evalToCpLoss,
  classify,
  assessEvaluation,
  assessTerminal,
  moverResultOf,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One engine line, with the fields the predictor actually reads and plausible values for the rest. */
function line(evaluation: Evaluation, pv: readonly string[], depth = 20): EngineResult {
  return {
    multipv: 1,
    evaluation,
    principalVariation: pv,
    depth,
    nodes: 1_000_000,
    nps: 500_000,
    timeMs: 2000,
  };
}

const cp = (value: number): Evaluation => ({ type: 'cp', value });
const mate = (value: number): Evaluation => ({ type: 'mate', value });

/** An `AnalysisProvider` that records every request and answers with one scripted line. */
function countingProvider(evaluation: Evaluation, pv: readonly string[]): {
  readonly provider: AnalysisProvider;
  readonly requests: AnalysisRequest[];
} {
  const requests: AnalysisRequest[] = [];
  const provider: AnalysisProvider = {
    async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
      requests.push(request);
      return [line(evaluation, pv)];
    },
    async play(_request: PlayRequest): Promise<PlayResult> {
      throw new Error('not used');
    },
    capabilitiesFor(_variant: string): EngineCapabilities | undefined {
      return undefined;
    },
  };
  return { provider, requests };
}

// ---------------------------------------------------------------------------
// Classification from evaluations
// ---------------------------------------------------------------------------

describe('MistakePredictor — classification from evaluations', () => {
  test('a large eval swing is a blunder, and reports the loss and the engine move', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(200), ['g1f3'])],
      // The engine reports the post-move position from Black's side, who is now to move.
      analysisAfter: [line(cp(200), ['e7e5'])],
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, 400, '200 − (−200)');
    assert.equal(result.evalBefore.value, 200);
    assert.equal(result.evalBeforeLabel, '+2.00');
    assert.equal(result.moveOutcome.kind, 'evaluation');
    assert.deepEqual(
      result.moveOutcome.kind === 'evaluation' ? result.moveOutcome.evaluation : null,
      cp(-200),
      'the post-move eval is negated into the mover\'s frame',
    );
    assert.equal(result.betterMove, 'g1f3');
    assert.deepEqual([...result.bestLine], ['g1f3']);
    assert.equal(result.depth, 20);
    assert.equal(result.coaching, null, 'no provider was supplied, so there is no prose');
  });

  test('a near-zero loss is ok', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(20), ['e2e4'])],
      analysisAfter: [line(cp(-15), ['e7e5'])],
    });

    assert.equal(result.classification, 'ok');
    assert.equal(result.centipawnLoss, 5, '20 − 15');
  });

  test('the thresholds are inclusive lower bounds', async () => {
    const cases: readonly [number, string][] = [
      [49, 'ok'],
      [50, 'inaccuracy'],
      [99, 'inaccuracy'],
      [100, 'mistake'],
      [299, 'mistake'],
      [300, 'blunder'],
    ];
    for (const [loss, expected] of cases) {
      const predictor = new MistakePredictor();
      const result = await predictor.predict({
        fen: STARTPOS,
        move: 'a2a3',
        analysisBefore: [line(cp(loss), ['e2e4'])],
        // Post-move eval of 0 in the mover's frame, so the loss is exactly `evalBefore`.
        analysisAfter: [line(cp(0), ['e7e5'])],
      });
      assert.equal(result.classification, expected, `${loss} cp should be ${expected}`);
      assert.equal(result.centipawnLoss, loss);
    }
  });

  test('the post-move perspective flip is what decides the verdict', async () => {
    // Both numbers are +150. Without the flip the loss reads as 0 and the move looks fine; with it,
    // the mover went from +1.50 to −1.50 and threw away three pawns.
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(150), ['e2e4'])],
      analysisAfter: [line(cp(150), ['e7e5'])],
    });

    assert.equal(result.centipawnLoss, 300);
    assert.equal(result.classification, 'blunder');
  });

  test('a Black move is not inverted', async () => {
    // Black to move, and better: the engine reports +150 for Black before, and the reply position
    // reports +150 for White after. Both are `+1.50 for the side to move`, so in Black's frame the
    // move cost exactly 300 — the same arithmetic as the White case above, which is the point.
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: blackToMove,
      move: 'a7a6',
      analysisBefore: [line(cp(150), ['e7e5'])],
      analysisAfter: [line(cp(150), ['g1f3'])],
    });

    assert.equal(result.centipawnLoss, 300);
    assert.equal(result.classification, 'blunder');
  });
});

// ---------------------------------------------------------------------------
// Mate scores
// ---------------------------------------------------------------------------

describe('MistakePredictor — mate scores have no centipawn measure', () => {
  const table: readonly {
    readonly name: string;
    readonly before: Evaluation;
    /** As the engine reports it, i.e. from the opponent's side. */
    readonly afterRaw: Evaluation;
    readonly classification: string;
    readonly loss: number | null;
  }[] = [
    {
      name: 'cp → mate against the mover: walked into a forced mate',
      before: cp(50),
      afterRaw: mate(3),
      classification: 'blunder',
      loss: null,
    },
    {
      name: 'cp → mate for the mover: found a forced win',
      before: cp(50),
      afterRaw: mate(-3),
      classification: 'ok',
      loss: null,
    },
    {
      name: 'mate for the mover → cp: threw away a forced win',
      before: mate(4),
      afterRaw: cp(-500),
      classification: 'blunder',
      loss: null,
    },
    {
      name: 'mate → mate, both for the mover: still winning',
      before: mate(4),
      afterRaw: mate(-6),
      classification: 'ok',
      loss: null,
    },
    {
      name: 'mate for the mover → mate against them',
      before: mate(4),
      afterRaw: mate(2),
      classification: 'blunder',
      loss: null,
    },
    {
      name: 'already being mated: the move cost nothing, whatever follows',
      before: mate(-2),
      afterRaw: mate(1),
      classification: 'ok',
      loss: null,
    },
  ];

  for (const row of table) {
    test(row.name, async () => {
      const predictor = new MistakePredictor();
      const result = await predictor.predict({
        fen: STARTPOS,
        move: 'a2a3',
        analysisBefore: [line(row.before, ['e2e4'])],
        analysisAfter: [line(row.afterRaw, ['e7e5'])],
      });
      assert.equal(result.classification, row.classification);
      assert.equal(result.centipawnLoss, row.loss);
    });
  }

  test('the loss is never Infinity, which JSON would serialise as null anyway', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(50), ['e2e4'])],
      analysisAfter: [line(mate(3), ['e7e5'])],
    });
    assert.equal(result.centipawnLoss, null);
    assert.equal(JSON.parse(JSON.stringify(result)).centipawnLoss, null);
    assert.ok(Number.isFinite(result.centipawnLoss ?? 0));
  });
});

// ---------------------------------------------------------------------------
// Terminal outcomes
// ---------------------------------------------------------------------------

describe('MistakePredictor — a decided game is a result, not an evaluation', () => {
  test('delivering checkmate is ok, and no post-move evaluation is consulted', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(900), ['e2e4'])],
      // Deliberately supplied, and deliberately the engine's placeholder for a position it cannot
      // score. Reading it would compute a 900 cp loss and call delivering mate a blunder — which is
      // exactly what the M8 implementation did.
      analysisAfter: [line(cp(0), [], 0)],
      terminalAfterMove: { reason: 'checkmate', result: '1-0', describe: 'checkmate — White wins' },
    });

    assert.equal(result.classification, 'ok');
    assert.equal(result.centipawnLoss, null);
    assert.equal(result.moveOutcome.kind, 'terminal');
    if (result.moveOutcome.kind === 'terminal') {
      assert.equal(result.moveOutcome.reason, 'checkmate');
      assert.equal(result.moveOutcome.result, '1-0');
      assert.equal(result.moveOutcome.label, 'checkmate — White wins');
    }
  });

  test('stalemating from a winning position is a blunder measured against the draw', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(500), ['e2e4'])],
      terminalAfterMove: { reason: 'stalemate', result: '1/2-1/2', describe: 'stalemate — drawn' },
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, 500, 'a draw is exactly zero on the engine\'s own scale');
  });

  test('holding a draw from a lost position is ok, and the loss is negative', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(-800), ['e2e4'])],
      terminalAfterMove: { reason: 'stalemate', result: '1/2-1/2', describe: 'stalemate — drawn' },
    });

    assert.equal(result.classification, 'ok');
    assert.equal(result.centipawnLoss, -800);
  });

  test('drawing away a forced mate is a blunder with no centipawn measure', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(mate(3), ['e2e4'])],
      terminalAfterMove: { reason: 'fifty_move', result: '1/2-1/2', describe: 'fifty-move rule — drawn' },
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, null);
  });

  test('ending the game in the mover\'s own defeat is a blunder', async () => {
    // Reachable in Atomic, where a capture beside your own king explodes it.
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(100), ['e2e4'])],
      terminalAfterMove: { reason: 'variant_win', result: '0-1', describe: 'variant win — Black wins' },
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, null);
  });

  test('a variant win for the mover is ok even from a losing evaluation', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(-400), ['e2e4'])],
      terminalAfterMove: { reason: 'variant_win', result: '1-0', describe: 'variant win — White wins' },
    });

    assert.equal(result.classification, 'ok');
    assert.equal(result.centipawnLoss, null);
  });

  test('a Black mover wins with 0-1, not 1-0', async () => {
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const predictor = new MistakePredictor();
    const won = await predictor.predict({
      fen: blackToMove,
      move: 'a7a6',
      analysisBefore: [line(cp(-900), ['e7e5'])],
      terminalAfterMove: { reason: 'checkmate', result: '0-1', describe: 'checkmate — Black wins' },
    });
    assert.equal(won.classification, 'ok', 'Black delivering mate is Black winning');

    const lost = await predictor.predict({
      fen: blackToMove,
      move: 'a7a6',
      analysisBefore: [line(cp(900), ['e7e5'])],
      terminalAfterMove: { reason: 'checkmate', result: '1-0', describe: 'checkmate — White wins' },
    });
    assert.equal(lost.classification, 'blunder', 'the same result string is a loss for Black');
  });
});

// ---------------------------------------------------------------------------
// Variant correctness
// ---------------------------------------------------------------------------

describe('MistakePredictor — variant correctness', () => {
  test('the default variant is the platform vocabulary, not the M8 `chess`', async () => {
    const { provider, requests } = countingProvider(cp(10), ['e2e4']);
    const predictor = new MistakePredictor({ engine: provider });
    await predictor.predict({ fen: STARTPOS, move: 'e2e4' });

    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.variant, 'standard');
      assert.notEqual(request.variant, 'chess', '`chess` routes to no engine pool in this platform');
    }
  });

  test('the requested variant reaches the rules engine, not only the search', async () => {
    // A Racing Kings position. Under standard rules this FEN is illegal — Black is in check with
    // White to move — so `Position.fromFen` rejects it outright. The M8 implementation called
    // `Position.fromFen(fen)` with no variant while sending `variant` to the engine, so the two
    // halves of one request disagreed about which game was being played. If the variant stops
    // reaching `Position`, this throws.
    const racing = '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1';
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: racing,
      move: 'h2g3',
      variant: 'racingkings',
      analysisBefore: [line(cp(30), ['h2g3'])],
      analysisAfter: [line(cp(-25), ['a2b3'])],
    });

    assert.equal(result.classification, 'ok');
    assert.equal(
      result.fenAfter,
      Position.fromFen(racing, 'racingkings').play('h2g3').fen(),
      'the resulting FEN is produced under the requested variant',
    );
  });

  test('the variant is carried into the grounding, so it is part of cache identity', async () => {
    const seen: CompletionRequest[] = [];
    const ai = new FakeProvider({ id: 'fake-ai', content: 'coaching text' });
    const recording: CompletionPort = {
      complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
        seen.push(request);
        return ai.complete(request);
      },
    };
    const predictor = new MistakePredictor({ ai: recording });
    await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      variant: 'atomic',
      analysisBefore: [line(cp(10), ['e2e4'])],
      analysisAfter: [line(cp(-5), ['e7e5'])],
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.grounding?.variant, 'atomic');
  });
});

// ---------------------------------------------------------------------------
// Server-owned policy and engine ownership
// ---------------------------------------------------------------------------

describe('MistakePredictor — policy and composition', () => {
  test('thresholds are fixed at construction and have no request-level override', async () => {
    const lenient = new MistakePredictor({
      thresholds: { inaccuracy: 500, mistake: 1000, blunder: 2000 },
    });
    const request = {
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(400), ['e2e4'])],
      analysisAfter: [line(cp(0), ['e7e5'])],
      // Not fields of `PredictRequest`, and here to prove it: a caller that could set these could
      // declare its own blunder to be fine. The type rejects them and so does the runtime, which
      // simply never reads them.
      ...({ blunderThreshold: 1, inaccuracyThreshold: 1 } as Record<string, unknown>),
    };
    const result = await lenient.predict(request);

    assert.equal(result.centipawnLoss, 400);
    assert.equal(result.classification, 'ok', 'the constructed ladder decided, not the request');
  });

  test('composed without an engine, it requires pre-computed analysis and says so', async () => {
    const predictor = new MistakePredictor();
    await assert.rejects(
      () => predictor.predict({ fen: STARTPOS, move: 'e2e4' }),
      /composed without an engine/,
      'a composition error, not a silent second engine',
    );
  });

  test('an empty analysis is refused rather than indexed into', async () => {
    const predictor = new MistakePredictor();
    await assert.rejects(
      () =>
        predictor.predict({
          fen: STARTPOS,
          move: 'e2e4',
          analysisBefore: [line(cp(10), ['e2e4'])],
          // A search that produced no scored line. `analysisAfter: []` reads as "none supplied", so
          // this exercises the engine-less path refusing rather than the empty array being indexed.
          analysisAfter: [],
        }),
      /composed without an engine/,
    );
  });

  test('supplied analysis is used and the injected engine is left alone', async () => {
    const { provider, requests } = countingProvider(cp(999), ['h2h3']);
    const predictor = new MistakePredictor({ engine: provider });
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(20), ['e2e4'])],
      analysisAfter: [line(cp(-15), ['e7e5'])],
    });

    assert.equal(requests.length, 0, 'no search was run');
    assert.equal(result.evalBefore.value, 20);
  });

  test('a terminal move runs no post-move search even when an engine is available', async () => {
    const { provider, requests } = countingProvider(cp(0), []);
    const predictor = new MistakePredictor({ engine: provider });
    await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(900), ['e2e4'])],
      terminalAfterMove: { reason: 'checkmate', result: '1-0', describe: 'checkmate — White wins' },
    });

    assert.equal(requests.length, 0, 'the decided position was never handed to a search');
  });
});

// ---------------------------------------------------------------------------
// Grounding ownership
// ---------------------------------------------------------------------------

describe('MistakePredictor — grounding has one owner', () => {
  /** Capture what reaches the completion port. */
  function recorder(): { readonly port: CompletionPort; readonly seen: CompletionRequest[] } {
    const seen: CompletionRequest[] = [];
    const ai = new FakeProvider({ id: 'fake-ai', content: 'coaching text' });
    return {
      seen,
      port: {
        complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
          seen.push(request);
          return ai.complete(request);
        },
      },
    };
  }

  test('structured facts are passed once, and no pre-built grounded message is sent', async () => {
    const { port, seen } = recorder();
    const predictor = new MistakePredictor({ ai: port });
    await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(150), ['e2e4', 'e7e5'])],
      analysisAfter: [line(cp(-120), ['g1f3'])],
    });

    assert.equal(seen.length, 1);
    const request = seen[0]!;
    assert.ok(request.grounding, 'the port receives the facts to render');
    assert.equal(request.grounding?.evalCp, 150);
    assert.equal(request.grounding?.moveUci, 'e2e4');

    // The port owns the rendering. `buildGroundedMessages` inserts a system message carrying the
    // engine block, so a feature that called it *and* set `grounding` put the same facts in the
    // prompt twice — one copy from the feature, one from `AiOrchestrator.complete`. Exactly one
    // message goes out, and it is the user's question.
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0]!.role, 'user');
    const content = request.messages[0]!.content;
    assert.ok(
      !/FEN:\s*rnbqkbnr\/pppppppp[\s\S]*FEN:\s*rnbqkbnr\/pppppppp/.test(content),
      'the position is not stated twice in one message',
    );
  });

  test('a terminal outcome reaches the grounding as a result, not as a score', async () => {
    const { port, seen } = recorder();
    const predictor = new MistakePredictor({ ai: port });
    await predictor.predict({
      fen: STARTPOS,
      move: 'a2a3',
      analysisBefore: [line(cp(900), ['e2e4'])],
      terminalAfterMove: { reason: 'checkmate', result: '1-0', describe: 'checkmate — White wins' },
    });

    const grounding = seen[0]!.grounding;
    assert.equal(grounding?.moveOutcome, 'checkmate — White wins');
    assert.equal(grounding?.moveEvalCp, undefined, 'no fabricated score for a finished game');
    assert.equal(grounding?.moveEvalMate, undefined);
  });

  test('the verdict is complete with no provider at all', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(150), ['e2e4'])],
      // Reported from the opponent's side, so `+120` for them is `−120` for the mover.
      analysisAfter: [line(cp(120), ['g1f3'])],
    });

    assert.equal(result.classification, 'mistake');
    assert.equal(result.centipawnLoss, 270, '150 − (−120)');
    assert.equal(result.coaching, null);
    assert.equal(result.providerId, null);
    assert.equal(result.model, null);
    assert.equal(result.usage, null);
    assert.equal(result.latencyMs, null);
  });
});

// ---------------------------------------------------------------------------
// Better move
// ---------------------------------------------------------------------------

describe('MistakePredictor — the better move', () => {
  test('an empty principal variation reports null, not a placeholder string', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(10), [])],
      analysisAfter: [line(cp(-10), ['e7e5'])],
    });

    assert.equal(result.betterMove, null);
    assert.notEqual(result.betterMove, '(none)', 'a client can render and compare a string');
  });

  test('playing the engine\'s own move reports that move, and equality is the answer', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(30), ['e2e4', 'e7e5'])],
      analysisAfter: [line(cp(-30), ['e7e5'])],
    });

    assert.equal(result.betterMove, 'e2e4');
    assert.equal(result.betterMove, result.move, 'no separate boolean that could disagree');
    assert.equal(result.classification, 'ok');
  });

  test('a promotion move keeps its suffix through the verdict', async () => {
    const promotion = '8/4P3/8/8/8/8/8/4K1k1 w - - 0 1';
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: promotion,
      move: 'e7e8q',
      analysisBefore: [line(cp(800), ['e7e8q'])],
      analysisAfter: [line(cp(-800), ['g1h2'])],
    });

    assert.equal(result.move, 'e7e8q');
    assert.equal(result.betterMove, 'e7e8q');
    assert.equal(result.fenAfter, Position.fromFen(promotion, 'standard').play('e7e8q').fen());
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('MistakePredictor pure functions', () => {
  test('negateEval flips both kinds of evaluation', () => {
    assert.deepEqual(negateEval(cp(150)), cp(-150));
    assert.deepEqual(negateEval(mate(3)), mate(-3));
  });

  test('evalToCpLoss subtracts two centipawn scores and refuses anything else', () => {
    assert.equal(evalToCpLoss(cp(200), cp(-200)), 400);
    assert.equal(evalToCpLoss(cp(50), mate(-1)), null, 'walked into mate');
    assert.equal(evalToCpLoss(mate(3), cp(100)), null, 'threw away a forced mate');
    assert.equal(evalToCpLoss(mate(3), mate(5)), null, 'still winning');
  });

  test('classify walks the ladder', () => {
    assert.equal(classify(0), 'ok');
    assert.equal(classify(-100), 'ok', 'a negative loss is an improvement');
    assert.equal(classify(50), 'inaccuracy');
    assert.equal(classify(100), 'mistake');
    assert.equal(classify(300), 'blunder');
    assert.equal(classify(100, { inaccuracy: 500, mistake: 1000, blunder: 2000 }), 'ok');
  });

  test('assessEvaluation puts "already lost" ahead of "walked into mate"', () => {
    // The mover was being mated before the move and still is. The move cost nothing; blaming it for
    // the position would make the classification a statement about the game rather than the move.
    assert.deepEqual(assessEvaluation(mate(-2), mate(-1)), {
      classification: 'ok',
      centipawnLoss: null,
    });
    // The same post-move evaluation from a playable position is the blunder it looks like.
    assert.deepEqual(assessEvaluation(cp(0), mate(-1)), {
      classification: 'blunder',
      centipawnLoss: null,
    });
  });

  test('assessTerminal measures a draw and refuses to measure a win or a loss', () => {
    assert.deepEqual(assessTerminal(cp(500), 'draw'), { classification: 'blunder', centipawnLoss: 500 });
    assert.deepEqual(assessTerminal(cp(60), 'draw'), { classification: 'inaccuracy', centipawnLoss: 60 });
    assert.deepEqual(assessTerminal(cp(500), 'win'), { classification: 'ok', centipawnLoss: null });
    assert.deepEqual(assessTerminal(cp(500), 'loss'), { classification: 'blunder', centipawnLoss: null });
    assert.deepEqual(assessTerminal(mate(3), 'draw'), { classification: 'blunder', centipawnLoss: null });
    assert.deepEqual(assessTerminal(mate(-3), 'loss'), { classification: 'ok', centipawnLoss: null });
  });

  test('moverResultOf reads a result string from the mover\'s side', () => {
    assert.equal(moverResultOf('1-0', true), 'win');
    assert.equal(moverResultOf('1-0', false), 'loss');
    assert.equal(moverResultOf('0-1', true), 'loss');
    assert.equal(moverResultOf('0-1', false), 'win');
    assert.equal(moverResultOf('1/2-1/2', true), 'draw');
    assert.equal(moverResultOf('1/2-1/2', false), 'draw');
  });
});

/**
 * The class adjudicates terminality itself when the caller did not.
 *
 * The API pre-adjudicates and passes `terminalAfterMove`, so its behaviour is unaffected by this —
 * but `Coach` calls `predict` with no terminal field, and so does any other direct library caller.
 * Trusting the caller alone left those on the original M8 defect: the post-move search ran against a
 * decided position, the engine answered with the `{ cp: 0, depth: 0 }` placeholder of ADR-0116, and
 * delivering checkmate from a winning position scored as a several-hundred-centipawn blunder. Found
 * in the independent review of PR #136, which noted the ADR claimed the defect gone from the class
 * when it was gone only from one caller of it.
 */
describe('MistakePredictor — terminality without a pre-adjudicating caller', () => {
  /** White to move; Ra1-a8 is mate. Verified against `Position.status()`. */
  const MATE_IN_ONE = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';

  test('delivering checkmate is ok, and costs no post-move search, with no terminal field supplied', async () => {
    // The engine is scripted to answer the way a real one does for a decided position: the
    // placeholder. If the class consults it, the verdict is a blunder.
    const { provider, requests } = countingProvider(cp(0), []);
    const predictor = new MistakePredictor({ engine: provider });

    const result = await predictor.predict({
      fen: MATE_IN_ONE,
      move: 'a1a8',
      analysisBefore: [line(cp(900), ['a1a8'])],
      // Deliberately absent — this is the whole point of the test.
    });

    assert.equal(result.classification, 'ok', 'delivering mate is not a blunder');
    assert.equal(result.centipawnLoss, null);
    assert.equal(result.moveOutcome.kind, 'terminal');
    if (result.moveOutcome.kind === 'terminal') {
      assert.equal(result.moveOutcome.reason, 'checkmate');
      assert.equal(result.moveOutcome.result, '1-0');
    }
    assert.equal(requests.length, 0, 'the decided position was never handed to a search');
  });

  test('a caller-supplied outcome still wins, because it may know what a position cannot', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: MATE_IN_ONE,
      move: 'a1a8',
      analysisBefore: [line(cp(900), ['a1a8'])],
      // A position cannot see repetition, so a caller that tracked the history overrides.
      terminalAfterMove: { reason: 'threefold', result: '1/2-1/2', describe: 'threefold repetition — drawn' },
    });

    assert.equal(result.moveOutcome.kind, 'terminal');
    if (result.moveOutcome.kind === 'terminal') {
      assert.equal(result.moveOutcome.reason, 'threefold', 'the caller is the authority when it speaks');
      assert.equal(result.moveOutcome.label, 'threefold repetition — drawn');
    }
  });

  test('an ongoing position is still evaluated, so the guard has not swallowed the normal path', async () => {
    const predictor = new MistakePredictor();
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore: [line(cp(20), ['e2e4'])],
      analysisAfter: [line(cp(-15), ['e7e5'])],
    });

    assert.equal(result.moveOutcome.kind, 'evaluation');
    assert.equal(result.centipawnLoss, 5);
  });
});
