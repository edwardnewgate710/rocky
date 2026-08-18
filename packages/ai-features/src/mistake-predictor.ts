/**
 * `MistakePredictor` — M8 increment 3, productionised in M15 increment 5.
 *
 * Given a position (FEN) and a **candidate move the player is considering**, determines whether that
 * move is a mistake and how severe.
 *
 * The severity of a move is what it costs against best play:
 *
 * 1. Analyse the original position → `evalBefore` (best play for the side to move).
 * 2. Apply the candidate move with `@chess-platform/core`'s `Position.play()` **under the requested
 *    variant**, giving the resulting FEN.
 * 3. Either the caller adjudicated the resulting position as terminal, or analyse it → `evalAfter`
 *    (from the **opponent's** perspective, since it is now their turn).
 * 4. Normalise: `evalAfterMoverPerspective = negate(evalAfter)`.
 * 5. Assess: a centipawn loss where one exists, an authoritative result where one does not.
 * 6. Classify: inaccuracy ≥ 50 cp, mistake ≥ 100 cp, blunder ≥ 300 cp.
 *
 * This makes mistake classification an objective, testable engine-and-rules fact — **the LLM never
 * decides whether a move is a mistake**, and the verdict is complete without one.
 *
 * The AI provider's role is only optional human-facing coaching text. The API composition of M15
 * increment 5 supplies no provider at all (ADR-0118): "Explain last move" already produces prose
 * about the same move from the same panel, and a second paid completion beside it would be duplicate
 * spend with no distinct role. The path is kept because the library capability predates the product
 * and remains part of M8.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { CompletionPort, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString } from '@chess-platform/ai-orchestrator';
import { Position } from '@chess-platform/core';
import type { GameStatus, Variant } from '@chess-platform/core';

import type {
  PredictRequest,
  MistakeVerdict,
  MistakeClassification,
  MoveOutcome,
} from './mistake-types.js';

// ---------------------------------------------------------------------------
// Classification policy
// ---------------------------------------------------------------------------

/** Default inaccuracy threshold: 50 cp = 0.50 pawns. */
export const DEFAULT_INACCURACY_THRESHOLD = 50;

/** Default mistake threshold: 100 cp = 1.00 pawn. */
export const DEFAULT_MISTAKE_THRESHOLD = 100;

/** Default blunder threshold: 300 cp = 3.00 pawns. */
export const DEFAULT_BLUNDER_THRESHOLD = 300;

/**
 * The variants this package will adjudicate under, as a runtime value.
 *
 * `Variant` in `@chess-platform/core` is a type, so it vanishes at compile time and a cast through
 * it checks nothing. That matters more here than it looks: `Position.fromFen(fen, 'nonsense')` does
 * **not** throw — it parses, stores the unrecognised name, and then adjudicates under whatever rules
 * fall out, which is neither the requested variant nor standard. `chess`, the M8 default this
 * increment removed, is exactly such a value: it produces a *different* answer from `standard` on the
 * same position. Silently adjudicating under rules nobody asked for is the defect this increment
 * exists to fix, so the cast is guarded rather than trusted. Raised in the CodeRabbit review of
 * PR #136.
 */
const SUPPORTED_VARIANTS: ReadonlySet<string> = new Set<Variant>([
  'standard',
  'chess960',
  'kingofthehill',
  'atomic',
  'crazyhouse',
  'threecheck',
  'horde',
  'racingkings',
]);

/** The centipawn ladder that turns a loss into a classification. */
export interface MistakeThresholds {
  readonly inaccuracy: number;
  readonly mistake: number;
  readonly blunder: number;
}

export const DEFAULT_MISTAKE_THRESHOLDS: MistakeThresholds = {
  inaccuracy: DEFAULT_INACCURACY_THRESHOLD,
  mistake: DEFAULT_MISTAKE_THRESHOLD,
  blunder: DEFAULT_BLUNDER_THRESHOLD,
};

/** A classification and the centipawn loss behind it, where one exists. */
export interface MistakeAssessment {
  readonly classification: MistakeClassification;
  readonly centipawnLoss: number | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing a `MistakePredictor`. */
export interface MistakePredictorOptions {
  /**
   * The chess engine analysis provider (M5 port), for callers that want the predictor to obtain its
   * own analysis.
   *
   * Optional, and deliberately so — the same technique `MoveExplainer` uses since ADR-0115. A caller
   * that already owns an analysis subsystem supplies `analysisBefore` on every call and must not
   * hand a second engine to a second component; that is how one deployment silently acquires two
   * pools and twice the CPU ceiling it published. Composing without an engine makes the second pool
   * *unrepresentable* rather than merely discouraged: `predict` then requires pre-computed analysis
   * and throws if it is missing, which is a composition error, not a runtime condition.
   */
  readonly engine?: AnalysisProvider;
  /**
   * The AI completion port (M7). Optional — the coaching text is additive, never load-bearing.
   *
   * **The port owns grounding.** Callers pass structured facts on `CompletionRequest.grounding`;
   * whatever is behind this port renders them into messages. See {@link MistakePredictor.predict}.
   */
  readonly ai?: CompletionPort;
  /** Default variant (defaults to `standard`). */
  readonly defaultVariant?: string;
  /** Default analysis limits (used when the request doesn't supply them). */
  readonly defaultLimits?: AnalysisLimits;
  /**
   * The classification ladder, fixed for the lifetime of the predictor.
   *
   * Here rather than on the request, and that is the whole point: a request that can raise the
   * blunder threshold can declare that its blunder was fine, which makes the verdict an opinion the
   * caller supplied rather than a fact about the move. Server-owned policy has to live somewhere a
   * request body cannot reach, and this is it.
   */
  readonly thresholds?: MistakeThresholds;
  /** Default temperature for the LLM call (defaults to 0.3 for factual coaching). */
  readonly temperature?: number;
  /** Default max output tokens (defaults to 512). */
  readonly maxTokens?: number;
}

// ---------------------------------------------------------------------------
// MistakePredictor
// ---------------------------------------------------------------------------

/**
 * Predicts whether a candidate move is a mistake and how severe.
 *
 * The verdict's correctness fields (evalBefore, move outcome, cp loss, better move) come entirely
 * from the engine and the rules. The LLM only provides optional human-facing coaching text.
 */
export class MistakePredictor {
  private readonly engine: AnalysisProvider | undefined;
  private readonly ai: CompletionPort | undefined;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly thresholds: MistakeThresholds;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: MistakePredictorOptions = {}) {
    this.engine = options.engine;
    this.ai = options.ai;
    // `standard`, not `chess`. `chess` is not a value in the platform's variant vocabulary
    // (`VARIANTS` in the API, ADR-0102 in the engine): it fails `parseVariant` at the API boundary
    // and matches no engine pool below it, so the old default named a variant that could not be
    // served anywhere in this system. Corrected in `MoveExplainer` in M15 increment 3 and here in
    // increment 5; the M8 tests that asserted `chess` were asserting the defect.
    this.defaultVariant = options.defaultVariant ?? 'standard';
    this.defaultLimits = options.defaultLimits ?? { depth: 20 };
    this.thresholds = options.thresholds ?? DEFAULT_MISTAKE_THRESHOLDS;
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 512;
  }

  /**
   * Predict whether a candidate move is a mistake.
   *
   * @param request - The position, candidate move, and optional pre-computed analysis.
   * @returns A `MistakeVerdict` with the classification and engine-derived fields.
   */
  async predict(request: PredictRequest): Promise<MistakeVerdict> {
    const variant = request.variant ?? this.defaultVariant;
    if (!SUPPORTED_VARIANTS.has(variant)) {
      throw new Error(`MistakePredictor: unsupported variant '${variant}'.`);
    }
    const limits = request.limits ?? this.defaultLimits;

    // 1. Analyse the original position.
    const resultsBefore = await this.obtain(request.analysisBefore, {
      fen: request.fen,
      variant,
      limits,
      multiPv: 1,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const bestBefore = resultsBefore[0];
    if (bestBefore === undefined) {
      // Reachable: a search can end without a single scored `info` line. The old code indexed
      // straight into the array — and this package's tsconfig has no `noUncheckedIndexedAccess`, so
      // it compiled and threw a `TypeError` at runtime instead. Refusing names the actual condition.
      throw new Error('MistakePredictor: the analysis of the original position produced no lines.');
    }
    const evalBefore = bestBefore.evaluation;
    const betterMove = bestBefore.principalVariation[0] ?? null;

    // 2. Apply the candidate move to get the resulting position.
    //
    // **Under the requested variant.** The M8 implementation called `Position.fromFen(fen)` with no
    // variant while carrying `variant` separately into the engine request, so legality, the resulting
    // FEN and any adjudication were decided by *standard* rules on an Atomic, Horde or Racing Kings
    // position — while the engine analysed it as the variant it actually was. The two halves of the
    // same request disagreed about what game was being played.
    const position = Position.fromFen(request.fen, variant as Variant);
    const positionAfter = position.play(request.move);
    const fenAfter = positionAfter.fen();
    const moverIsWhite = position.turn === 'w';

    // 3. Establish what the move achieved.
    //
    // A move that ends the game has a result, not an evaluation. No post-move score is consulted
    // when it does, even if one was supplied: a search of a decided position returns a placeholder
    // that reads as `+0.00`, which is how delivering checkmate came to be classified as a blunder.
    //
    // Adjudicated **here** when the caller did not, from the position this method just built. An
    // earlier version of this increment trusted `request.terminalAfterMove` alone, which fixed the
    // defect for the API — which pre-adjudicates — and left it live for every direct library caller.
    // `Coach` is one: it calls `predict` with no terminal field, so a checkmating move was searched,
    // scored `+0.00`, and classified a blunder. The ADR claimed the defect was gone from this class;
    // it was gone from one caller of it. Found in the independent review of PR #136.
    //
    // This is not a second implementation of the rules: `status()` is core's own variant-aware
    // adjudicator, the same one the API reaches through. The caller's value still wins when present,
    // because it may know things a single position cannot — repetition needs move history — and it
    // owns the wording.
    const terminal = request.terminalAfterMove ?? terminalFromStatus(positionAfter.status());
    let moveOutcome: MoveOutcome;
    let assessment: MistakeAssessment;

    if (terminal) {
      moveOutcome = {
        kind: 'terminal',
        reason: terminal.reason,
        result: terminal.result,
        label: terminal.describe,
      };
      assessment = assessTerminal(evalBefore, moverResultOf(terminal.result, moverIsWhite), this.thresholds);
    } else {
      const resultsAfter = await this.obtain(request.analysisAfter, {
        fen: fenAfter,
        variant,
        limits,
        multiPv: 1,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const bestAfter = resultsAfter[0];
      if (bestAfter === undefined) {
        throw new Error('MistakePredictor: the analysis of the resulting position produced no lines.');
      }
      // 4. Normalise to the mover's perspective. The engine reports from the side to move, and after
      //    the candidate move that is the opponent, so their number is the negation of the mover's.
      const moverRelative = negateEval(bestAfter.evaluation);
      moveOutcome = {
        kind: 'evaluation',
        evaluation: moverRelative,
        label: evalToString(moverRelative),
      };
      assessment = assessEvaluation(evalBefore, moverRelative, this.thresholds);
    }

    // 5. Optionally generate LLM coaching text.
    let coaching: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      const grounding: EngineGrounding = {
        ...engineResultsToGrounding(request.fen, resultsBefore, request.move, variant),
        ...(moveOutcome.kind === 'terminal' ? { moveOutcome: moveOutcome.label } : {}),
        ...(moveOutcome.kind === 'evaluation' && moveOutcome.evaluation.type === 'cp'
          ? { moveEvalCp: moveOutcome.evaluation.value }
          : {}),
        ...(moveOutcome.kind === 'evaluation' && moveOutcome.evaluation.type === 'mate'
          ? { moveEvalMate: moveOutcome.evaluation.value }
          : {}),
      };

      const lossText = assessment.centipawnLoss === null
        ? 'The centipawn scale does not apply to this transition.'
        : `The centipawn loss is ${assessment.centipawnLoss}.`;
      const userContent =
        `The player is considering the move ${request.move} in the position with FEN: ${request.fen}. ` +
        `The engine and the rules classify this as a ${assessment.classification}. ${lossText} ` +
        `The engine's best move is ${betterMove ?? 'not reported'}. ` +
        `Provide a brief, encouraging coaching explanation of why the move is good or bad, ` +
        `and what the player should consider instead. Cite the engine evaluation. ` +
        `Do not contradict the classification: it is a fact, not a suggestion.`;

      // Hand the facts to the completion port, which renders them.
      //
      // This deliberately does *not* call `buildGroundedMessages` and then also set `grounding`.
      // `AiOrchestrator.complete` builds grounded messages whenever `grounding` is present, and
      // `buildGroundedMessages` inserts after a leading system message — so pre-building here put the
      // same block of engine facts into the prompt twice, wasting a slice of the context window on a
      // verbatim repeat and giving the model two copies to reconcile. Grounding has one owner: the
      // port. Features supply structured facts and never prompt text built from them. The same defect
      // was removed from `MoveExplainer` in M15 increment 3.
      const completionRequest: CompletionRequest = {
        task: 'mistake_prediction',
        messages: [{ role: 'user', content: userContent }],
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        ...(request.signal ? { signal: request.signal } : {}),
        grounding,
      };

      const response = await this.ai.complete(completionRequest);
      coaching = response.content;
      providerId = response.providerId;
      model = response.model;
      usage = response.usage;
      latencyMs = response.latencyMs;
    }

    return {
      fen: request.fen,
      move: request.move,
      fenAfter,
      classification: assessment.classification,
      centipawnLoss: assessment.centipawnLoss,
      evalBefore,
      evalBeforeLabel: evalToString(evalBefore),
      moveOutcome,
      betterMove,
      bestLine: bestBefore.principalVariation,
      depth: bestBefore.depth,
      coaching,
      providerId,
      model,
      usage,
      latencyMs,
    };
  }

  /** Pre-computed analysis if the caller supplied any, otherwise the injected engine — if there is one. */
  private async obtain(
    supplied: readonly EngineResult[] | undefined,
    request: AnalysisRequest,
  ): Promise<readonly EngineResult[]> {
    if (supplied && supplied.length > 0) return supplied;
    if (this.engine === undefined) {
      throw new Error(
        'MistakePredictor was composed without an engine, so pre-computed analysis is required.',
      );
    }
    return this.engine.analyze(request);
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * The terminal outcome of a position that has just been played into, or `undefined` if play goes on.
 *
 * Delegates entirely to core's `status()`, which resolves King of the Hill centre occupation,
 * Three-check counts, Atomic king explosion, Racing Kings promotion and Horde annihilation before the
 * generic no-legal-moves check — so this needs no per-variant knowledge and cannot drift from the
 * rules the rest of the platform plays by.
 *
 * `threefold` is deliberately absent: repetition needs the move history, which a `Position` does not
 * carry. A caller that does know the history supplies it through `PredictRequest.terminalAfterMove`,
 * which takes precedence over this.
 *
 * The phrasing here is plain and unlocalised on purpose. A caller with its own result vocabulary —
 * the API has one — overrides it by supplying `describe`.
 */
export function terminalFromStatus(status: GameStatus):
  { readonly reason: string; readonly result: '1-0' | '0-1' | '1/2-1/2'; readonly describe: string } | undefined {
  if (!status.over) return undefined;

  const phrase = status.reason.replace(/_/g, ' ');

  if (status.reason === 'checkmate' || status.reason === 'variant_win') {
    const white = status.winner === 'w';
    return {
      reason: status.reason,
      result: white ? '1-0' : '0-1',
      describe: `${phrase} — ${white ? 'White' : 'Black'} wins`,
    };
  }

  // Every other `over` reason in `GameStatus` is a draw. Handled as a fall-through rather than
  // enumerated so a new draw reason in core is reported honestly instead of dropping to `undefined`,
  // which would call a decided game still in play — the class of defect this increment removes.
  return { reason: status.reason, result: '1/2-1/2', describe: `${phrase} — drawn` };
}

/**
 * Negate an evaluation, flipping the perspective between the side to move and the opponent.
 *
 * For cp: negate the value (e.g. +50 → -50).
 * For mate: negate the value — mate in 3 for the opponent is mate in -3 for the mover, i.e. the
 * mover is the one being mated.
 */
export function negateEval(eval_: Evaluation): Evaluation {
  return { type: eval_.type, value: -eval_.value };
}

/** Which side the mover is, given the result string and their colour. */
export function moverResultOf(
  result: '1-0' | '0-1' | '1/2-1/2',
  moverIsWhite: boolean,
): 'win' | 'draw' | 'loss' {
  if (result === '1/2-1/2') return 'draw';
  const whiteWon = result === '1-0';
  return whiteWon === moverIsWhite ? 'win' : 'loss';
}

/**
 * Assess a move whose resulting position is still being played.
 *
 * Both evaluations must already be in the mover's frame (positive = good for the mover).
 *
 * A centipawn count only measures a transition that stays on the centipawn scale. Mate scores are
 * not large centipawn values — they are a different kind of claim — so any transition touching one
 * returns `null` and is classified on what actually happened. The order of the checks is the
 * substance:
 *
 * 1. **Already lost** wins over everything. If the mover was being forcibly mated before the move,
 *    the move cost them nothing; every move loses. Calling that a blunder blames the player for the
 *    position rather than the move, and this function only ever measures the move.
 * 2. **Walked into mate** is a blunder whatever the numbers said.
 * 3. **Threw away a forced mate** is a blunder even when the resulting evaluation is winning: a
 *    forced win converted into a mere advantage is a real loss with no centipawn expression.
 */
export function assessEvaluation(
  evalBefore: Evaluation,
  evalAfterMoverPerspective: Evaluation,
  thresholds: MistakeThresholds = DEFAULT_MISTAKE_THRESHOLDS,
): MistakeAssessment {
  const beforeLosingMate = evalBefore.type === 'mate' && evalBefore.value <= 0;
  if (beforeLosingMate) return { classification: 'ok', centipawnLoss: null };

  const afterLosingMate =
    evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value <= 0;
  if (afterLosingMate) return { classification: 'blunder', centipawnLoss: null };

  const beforeWinningMate = evalBefore.type === 'mate' && evalBefore.value > 0;
  const afterWinningMate =
    evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0;
  if (beforeWinningMate && !afterWinningMate) {
    return { classification: 'blunder', centipawnLoss: null };
  }

  if (evalBefore.type === 'cp' && evalAfterMoverPerspective.type === 'cp') {
    const loss = evalBefore.value - evalAfterMoverPerspective.value;
    return { classification: classify(loss, thresholds), centipawnLoss: loss };
  }

  // What is left: the mover found a forced mate, from a cp position or from another mate. Nothing
  // was lost, and nothing on the centipawn scale describes it.
  return { classification: 'ok', centipawnLoss: null };
}

/**
 * Assess a move that ends the game.
 *
 * The result is authoritative — it comes from the rules, not from a search — so it overrides any
 * evaluation of the resulting position, which does not have one.
 *
 * A **draw is the one terminal result with a centipawn measure**, and this is not a fabrication: zero
 * is exactly where the engine's own scale puts an equal game, so `evalBefore − 0` is the real cost of
 * agreeing to split the point. Throwing away +5.00 into stalemate is a 500 cp blunder; holding a
 * draw from −8.00 is a negative loss and reads as `ok`. A win and a loss have no such point on the
 * scale, so they are classified directly and report no loss.
 */
export function assessTerminal(
  evalBefore: Evaluation,
  moverResult: 'win' | 'draw' | 'loss',
  thresholds: MistakeThresholds = DEFAULT_MISTAKE_THRESHOLDS,
): MistakeAssessment {
  // Winning the game is the best available outcome by definition. There is nothing above it to have
  // missed, whatever the position was worth a move earlier.
  if (moverResult === 'win') return { classification: 'ok', centipawnLoss: null };

  // Already being forcibly mated: the move did not cause the result. Same precedence, same reason as
  // in `assessEvaluation`.
  if (evalBefore.type === 'mate' && evalBefore.value <= 0) {
    return { classification: 'ok', centipawnLoss: null };
  }

  if (moverResult === 'loss') return { classification: 'blunder', centipawnLoss: null };

  // A draw, from a position that was not already lost.
  if (evalBefore.type === 'mate') {
    // A forced win, converted into half a point.
    return { classification: 'blunder', centipawnLoss: null };
  }
  const loss = evalBefore.value;
  return { classification: classify(loss, thresholds), centipawnLoss: loss };
}

/**
 * The centipawn loss of a move, or `null` when the transition has no centipawn measure.
 *
 * Kept as a named export because it is the number the product talks about. It no longer returns
 * `Infinity`: `JSON.stringify(Infinity)` is `null`, so every serialising caller already received an
 * absence — with none of the intent, and no way to distinguish it from a field that was never set.
 */
export function evalToCpLoss(
  evalBefore: Evaluation,
  evalAfterMoverPerspective: Evaluation,
): number | null {
  return assessEvaluation(evalBefore, evalAfterMoverPerspective).centipawnLoss;
}

/**
 * Classify a centipawn loss against the threshold ladder.
 *
 * @param centipawnLoss - The measured cp loss. Negative means the move improved on best play's
 *   evaluation, which happens at shallow depth and correctly reads as `ok`.
 */
export function classify(
  centipawnLoss: number,
  thresholds: MistakeThresholds = DEFAULT_MISTAKE_THRESHOLDS,
): MistakeClassification {
  if (centipawnLoss >= thresholds.blunder) return 'blunder';
  if (centipawnLoss >= thresholds.mistake) return 'mistake';
  if (centipawnLoss >= thresholds.inaccuracy) return 'inaccuracy';
  return 'ok';
}
