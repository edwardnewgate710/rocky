/**
 * @packageDocumentation
 * The API-owned Mistake Prediction service (ADR-0118).
 *
 * Sits between the route and the dedicated analysis subsystem of ADR-0113, which it borrows and does
 * not own. Everything that decides how much CPU a request may consume lives here, and nothing on
 * this path is reachable from a request body — in particular the thresholds that decide what counts
 * as a blunder, which are compiled policy rather than a parameter.
 *
 * Deliberately in `analysis/` rather than `ai/`: this feature calls no AI provider. Its verdict is a
 * rules-and-engine fact, so it is available on any deployment with an engine, with or without an
 * external provider configured.
 */

import { Position } from '@chess-platform/core';
import type { Variant } from '@chess-platform/core';
import type { MistakePredictor, MistakeClassification } from '@chess-platform/ai-features';
import { HttpError } from '../http/errors.js';
import type { AnalysisPort } from './service.js';
import type { EngineResult } from '@chess-platform/engine';
import { coreFenValidator } from './fen-validator.js';
import { isUciShape } from './uci.js';
import type { TerminalReason } from './terminal.js';
import { describeTerminal, fromStatus } from './terminal.js';

export interface MistakePredictionInput {
  readonly fen: string;
  readonly variant: Variant;
  readonly move: string;
  /**
   * Server-computed pre-move lines a higher-level fixed-policy feature already obtained.
   *
   * This is deliberately absent from the HTTP body. It lets completed-game review reuse its
   * MultiPV evidence instead of paying for the same pre-move engine search twice.
   */
  readonly analysisBefore?: readonly EngineResult[];
}

/**
 * What the requested move achieved, from the mover's perspective.
 *
 * Tagged, per ADR-0116, so a client never has to infer which it got. The alternative — an evaluation
 * carrying a sentinel — is what made delivering checkmate read as `+0.00`, and here it did worse
 * than mislead: it classified the winning move as a blunder.
 */
export type MistakeMoveOutcomeView =
  | {
      readonly kind: 'evaluation';
      readonly evalKind: 'cp' | 'mate';
      readonly evalValue: number;
      readonly evalLabel: string;
    }
  | {
      readonly kind: 'terminal';
      readonly reason: TerminalReason;
      readonly result: '1-0' | '0-1' | '1/2-1/2';
      readonly label: string;
    };

/**
 * What the caller gets back.
 *
 * Deliberately absent: the thresholds themselves, the engine limits applied, prompts, provider
 * identity, and anything about the account serving the request. A client renders the verdict; it does
 * not get the machinery that produced it, and none of it is a knob it could turn next time.
 */
export interface MistakePredictionOutcome {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly classification: MistakeClassification;
  /** The evaluation best play achieves from the position before the move, mover-relative. */
  readonly before: {
    readonly evalKind: 'cp' | 'mate';
    readonly evalValue: number;
    readonly evalLabel: string;
  };
  /** What the move actually achieved, mover-relative. */
  readonly after: MistakeMoveOutcomeView;
  /**
   * The cost of the move in centipawns, or `null` when the transition has no centipawn measure.
   *
   * `null` is the honest answer for a transition into or out of a mate score, and for a game decided
   * in a win or a loss — none of those sit on a shared scale with a pawn count. It is never
   * `Infinity`, which JSON serialises to `null` anyway, and never a stand-in number.
   *
   * A draw *does* have one: zero is where the engine's own scale puts an equal game, so the loss
   * against a drawn result is real arithmetic. Which case applies is readable from `before` and
   * `after`, so there is no second field restating it — and no second field to disagree.
   */
  readonly centipawnLoss: number | null;
  /**
   * The engine's preferred move from the position before the move, or `null` if it reported none.
   *
   * When this equals `move`, the player found the engine's own choice. That is expressed by the
   * equality, not by a boolean beside it: two fields that must agree are two fields that can
   * disagree. Never the string `(none)`, which a client can render and compare as though it were a
   * move.
   */
  readonly bestMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
}

export interface MistakePredictionServiceOptions {
  readonly analysis: AnalysisPort;
  readonly predictor: MistakePredictor;
}



export class MistakePredictionService {
  private readonly analysis: AnalysisPort;
  private readonly predictor: MistakePredictor;
  private readonly fenValidator = coreFenValidator;

  constructor(options: MistakePredictionServiceOptions) {
    this.analysis = options.analysis;
    this.predictor = options.predictor;
  }

  /**
   * Whether this deployment can assess a move in `variant`. Exactly the analysis answer, because the
   * verdict is derived from an engine search and there is nothing to derive it from otherwise.
   */
  supportsVariant(variant: string): boolean {
    return this.analysis.supportsVariant(variant);
  }

  /**
   * @param onAccepted - Invoked once the request is known to be well-formed and legal, and before any
   *   engine work begins. The route spends its rate-limit quota here rather than at the top of the
   *   handler, so a malformed FEN or an illegal move costs the caller nothing.
   *
   *   The seam exists because validation and execution have to stay in one method — split them and
   *   they drift, and the checks that stop an unroutable variant reaching the engine are exactly the
   *   ones that must not be skippable. Throwing from it aborts the request.
   */
  async predict(
    input: MistakePredictionInput,
    onAccepted?: () => Promise<void>,
  ): Promise<MistakePredictionOutcome> {
    if (!this.analysis.supportsVariant(input.variant)) {
      throw HttpError.validation('unsupported variant', { variant: 'unsupported variant' });
    }

    if (!isUciShape(input.move)) {
      throw HttpError.validation('invalid move', { move: 'invalid move' });
    }

    // Validate the FEN here, before anything is derived from it.
    //
    // UCI is a newline-delimited protocol and the engine bridge interpolates the FEN into a
    // `position fen ...` line, so an unvalidated FEN carrying a terminator is an injected engine
    // command. `parseFen` alone does not catch it — it splits on whitespace, so a trailing `\nquit`
    // parses as an extra field and is ignored. The character allowlist is what sees it. The second
    // search below is handed a FEN this service *re-serialises*, so it is clean by construction and
    // this is the only check that covers the one the caller sent.
    try {
      this.fenValidator.validate(input.fen, input.variant);
    } catch {
      throw HttpError.validation('invalid FEN', { fen: 'invalid FEN' });
    }

    let position: Position;
    try {
      position = Position.fromFen(input.fen, input.variant);
    } catch {
      throw HttpError.validation('invalid FEN', { fen: 'invalid FEN' });
    }

    // A game that is already over has no move to assess.
    //
    // Checkmate and stalemate cannot reach here — `play` would reject the move — but a draw by the
    // fifty-move rule, by insufficient material, or by a variant rule leaves legal moves on the board
    // while the game is decided. Rejecting before anything is charged or searched.
    //
    // Adjudicated from the position just constructed rather than through `terminalOutcome`, which
    // would parse the same FEN under the same variant a second time. Identical answer — that helper
    // is `fromStatus(Position.fromFen(...).status())` with a try/catch this method has already
    // passed — one fewer parse, and, more to the point, one `Position` construction in this method
    // instead of two, so there is no second one whose variant handling could drift from the first.
    // Raised in the Qodo review of PR #136.
    if (fromStatus(position.status())) {
      throw HttpError.validation('the game is already over in this position', {
        fen: 'position is terminal',
      });
    }

    // Authoritative legality, at the boundary the API owns, and **under the requested variant**.
    //
    // `Position.play` resolves the UCI against `generateLegalMoves`, so this rejects a move that is
    // not in the position, one that leaves its own king in check, a promotion that is not on the back
    // rank, and a Crazyhouse drop with nothing in the pocket. A real adjudication, not a pattern
    // match — which is why the regex above is described as a filter and this is not.
    let afterMove: Position;
    try {
      afterMove = position.play(input.move);
    } catch {
      throw HttpError.validation('illegal move for this position', { move: 'illegal move' });
    }

    // Everything above is pure and cheap. Only now is the request worth charging for.
    if (onAccepted) await onAccepted();

    // Does the move end the game? Then there is nothing to search after it.
    //
    // Adjudicated from the position just constructed, by the same authoritative variant-aware rules
    // that accepted the move — not inferred from what an engine says about it.
    const moveTerminal = fromStatus(afterMove.status());

    // The pre-move search always runs: it is what the engine would have played instead, and the gap
    // between that and what the move achieved is the whole verdict. The post-move search runs only
    // when there is something left to evaluate — so an accepted move costs two searches normally and
    // one when it ends the game. Both go through `AnalysisService`, so the server's limits policy,
    // FEN validation, deterministic timeout and the one dedicated pool of ADR-0113 apply to each.
    const [before, afterAnalysis] = await Promise.all([
      input.analysisBefore === undefined
        ? this.analysis.analyze({ fen: input.fen, variant: input.variant, multiPv: 1 })
        : Promise.resolve({ lines: input.analysisBefore }),
      moveTerminal
        ? Promise.resolve(undefined)
        : this.analysis.analyze({ fen: afterMove.fen(), variant: input.variant, multiPv: 1 }),
    ]);

    // No lines means no evidence, and no evidence means no verdict.
    //
    // A search can end without producing a scored `info` line — a position with a single legal reply,
    // a budget consumed before the first iteration completes, an engine stopped early. Without this
    // the predictor would either throw (a 500) or, in the version of the fallback that succeeds,
    // classify against a number no engine produced. Refusing is the only answer consistent with the
    // feature's premise.
    if (before.lines.length === 0 || (afterAnalysis !== undefined && afterAnalysis.lines.length === 0)) {
      throw new HttpError(503, 'service_unavailable', 'the engine returned no evaluation to assess', undefined, {
        'Retry-After': '1',
      });
    }

    // The phrase is built here, where the vocabulary lives. `ai-features` sits below the API and
    // should not be deciding how a chess result reads in English. Computed once and used for both the
    // predictor's grounding and the response, so there is one wording rather than two.
    const terminalLabel = moveTerminal ? describeTerminal(moveTerminal) : '';

    const verdict = await this.predictor.predict({
      fen: input.fen,
      move: input.move,
      variant: input.variant,
      // Always supplied, so the predictor never reaches for an engine — it is composed without one,
      // so there is none to reach for.
      analysisBefore: before.lines,
      ...(afterAnalysis ? { analysisAfter: afterAnalysis.lines } : {}),
      ...(moveTerminal
        ? {
            terminalAfterMove: {
              reason: moveTerminal.reason,
              result: moveTerminal.result,
              describe: terminalLabel,
            },
          }
        : {}),
    });

    const outcome = verdict.moveOutcome;
    // Built from `moveTerminal` rather than read back off the verdict. The library types `reason` as
    // a plain string because it has no authority over the vocabulary, and this is where the value
    // came from — so reconstructing it here recovers the API's own closed `TerminalReason` union with
    // no cast and no assertion, and there is no second copy of the phrase to drift.
    //
    // The `else` refuses rather than substituting an evaluation, because the only substitute
    // available would be `+0.00` at depth 0: the exact fabrication this feature was built to remove.
    // Unreachable — the predictor returns a terminal outcome exactly when it was given one — and
    // stated as an invariant rather than left to a fallback that quietly lies if it ever breaks.
    let after: MistakeMoveOutcomeView;
    if (moveTerminal) {
      after = {
        kind: 'terminal',
        reason: moveTerminal.reason,
        result: moveTerminal.result,
        label: terminalLabel,
      };
    } else if (outcome.kind === 'evaluation') {
      after = {
        kind: 'evaluation',
        evalKind: outcome.evaluation.type,
        evalValue: outcome.evaluation.value,
        evalLabel: outcome.label,
      };
    } else {
      throw new Error('MistakePredictionService: terminal verdict for a non-terminal position.');
    }

    return {
      fen: input.fen,
      variant: input.variant,
      move: input.move,
      classification: verdict.classification,
      before: {
        evalKind: verdict.evalBefore.type,
        evalValue: verdict.evalBefore.value,
        evalLabel: verdict.evalBeforeLabel,
      },
      after,
      centipawnLoss: verdict.centipawnLoss,
      bestMove: verdict.betterMove,
      bestLine: verdict.bestLine,
      depth: verdict.depth,
    };
  }
}
