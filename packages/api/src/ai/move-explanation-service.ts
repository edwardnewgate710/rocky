/**
 * @packageDocumentation
 * The API-owned Move Explanation service (ADR-0115).
 *
 * Sits between the route and two subsystems it does not own: the dedicated analysis engine from
 * ADR-0113, and the provider-agnostic AI orchestrator. Everything that decides how much CPU and how
 * much money a request may consume lives here, not in either of them, and nothing on this path is
 * reachable from a request body.
 */

import { Position } from '@chess-platform/core';
import type { Variant } from '@chess-platform/core';
import type { MoveExplainer } from '@chess-platform/ai-features';
import { aiErrorToHttp } from './provider-errors.js';
import { HttpError } from '../http/errors.js';
import type { AnalysisPort } from '../analysis/service.js';
import { coreFenValidator } from '../analysis/fen-validator.js';
import { isUciShape } from '../analysis/uci.js';
import type { TerminalReason } from '../analysis/terminal.js';
import { describeTerminal, fromStatus, terminalOutcome } from '../analysis/terminal.js';

export interface MoveExplanationInput {
  readonly fen: string;
  readonly variant: Variant;
  readonly move: string;
}

/**
 * What the caller gets back.
 *
 * `explanation` is model prose and `citation` is engine fact, kept apart so a caller — the Inc 4 UI,
 * or a test — can render, verify or reject one without parsing the other. Nothing here is recovered
 * by reading the prose.
 *
 * Deliberately absent: token usage, cost, provider latency, finish reason, the prompt, and any
 * provider error text. `providerId` and `model` are the only provider-facing values, both already
 * part of the domain contract, and neither reveals anything about the account serving the request.
 */
export interface MoveExplanationOutcome {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
  readonly explanation: string;
  /**
   * The engine facts, in one frame of reference.
   *
   * Every evaluation here is **from the perspective of the player who made the move** — positive is
   * good for them — including `evalValue`, which the engine reports side-to-move-relative and which
   * is already the mover in the position before their move. Without a single stated convention the
   * two numbers below would silently be in opposite frames and their difference would be noise.
   */
  readonly citation: {
    /**
     * What the requested move achieved — either an evaluation or a finished game.
     *
     * A discriminated union rather than an evaluation with sentinel values, because a decided
     * position has no evaluation to report and saying `+0.00` about checkmate is not a rounding
     * error, it is the opposite of the truth (ADR-0116). Clients switch on `kind`; there is no
     * magic score, no magic depth, and no empty string to interpret.
     */
    readonly moveOutcome:
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
        };
    /** Evaluation the engine's own best move achieves from the position before the move. */
    readonly evalKind: 'cp' | 'mate';
    readonly evalValue: number;
    readonly evalLabel: string;
    /** The engine's preferred move, and the line it leads to. */
    readonly bestMove: string | null;
    readonly bestLine: readonly string[];
    readonly depth: number;
  };
  readonly providerId: string;
  readonly model: string;
}

export interface MoveExplanationServiceOptions {
  readonly analysis: AnalysisPort;
  readonly explainer: MoveExplainer;
}



export class MoveExplanationService {
  private readonly analysis: AnalysisPort;
  private readonly explainer: MoveExplainer;
  private readonly fenValidator = coreFenValidator;

  constructor(options: MoveExplanationServiceOptions) {
    this.analysis = options.analysis;
    this.explainer = options.explainer;
  }

  /** Whether this deployment can explain a move in `variant`. Exactly the analysis answer, because
   * an explanation with no engine behind it is the thing this feature exists to prevent. */
  supportsVariant(variant: string): boolean {
    return this.analysis.supportsVariant(variant);
  }

  /**
   * @param onAccepted - Invoked once the request is known to be well-formed and legal, and before
   *   any engine or provider work begins. The route spends its rate-limit quota here rather than at
   *   the top of the handler, so a malformed FEN or an illegal move costs the caller nothing.
   *
   *   The seam exists because validation and execution have to stay in one method — split them and
   *   they drift, and the checks that stop an unroutable variant reaching the engine are exactly the
   *   ones that must not be skippable. Passing the charge inward keeps the order correct without
   *   handing the route a second copy of the rules. Throwing from it aborts the request.
   */
  async explain(
    input: MoveExplanationInput,
    onAccepted?: () => Promise<void>,
  ): Promise<MoveExplanationOutcome> {
    if (!this.analysis.supportsVariant(input.variant)) {
      throw HttpError.validation('unsupported variant', { variant: 'unsupported variant' });
    }

    if (!isUciShape(input.move)) {
      throw HttpError.validation('invalid move', { move: 'invalid move' });
    }

    // Validate the FEN here, before anything is derived from it.
    //
    // `AnalysisService` validates too, but only what it is handed — and the second search below is
    // handed a FEN this service *re-serialises* from a parsed position, which is structurally clean
    // by construction. So a FEN carrying a line terminator was rejected on the first search and
    // silently accepted on the second, and a request that answered 422 had still spent an engine
    // search. `parseFen` alone does not catch it: it splits on whitespace, so a trailing `\nquit`
    // parses as an extra field and is ignored. The character allowlist is what sees it.
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

    // A game that is already over has no move to explain.
    //
    // Checkmate and stalemate cannot reach here — `play` would have rejected the move — but a draw
    // by the fifty-move rule, by insufficient material, or by a variant rule leaves legal moves on
    // the board while the game is decided. Those moves used to be accepted: the request was charged,
    // the pre-move search then returned a terminal outcome with no lines, and the caller got a
    // retryable 503 for a permanent condition. Rejecting here says what is actually wrong, and says
    // it before anything is spent. Raised in the Qodo review of PR #135.
    if (terminalOutcome(input.fen, input.variant)) {
      throw HttpError.validation('the game is already over in this position', {
        fen: 'position is terminal',
      });
    }

    // Authoritative legality, at the boundary the API owns.
    //
    // `Position.play` resolves the UCI against `generateLegalMoves`, so this rejects a move that is
    // not in the position, one that leaves its own king in check, a promotion that is not on the
    // back rank, and a Crazyhouse drop with nothing in the pocket. It is a real adjudication, not a
    // pattern match — which is why the regex above is described as a filter and this is not.
    //
    // The resulting position is kept, not discarded: it is what the second search below analyses,
    // and the only way to evaluate the move the caller actually asked about.
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
    // Adjudicated from the position we just constructed, by the same authoritative rules that
    // accepted the move — not inferred from what an engine says about it. A decided position gives a
    // search nothing to score, and the engine's placeholder for that case reads as `+0.00`, so
    // checkmate was being explained as dead level (ADR-0116). Deciding it here is both the correct
    // answer and one search cheaper.
    const moveTerminal = fromStatus(afterMove.status());

    // The pre-move search always runs: it is what the *engine* would have played instead, and the
    // gap between that and what the move achieved is the whole judgement. The post-move search runs
    // only when there is something left to evaluate — so an accepted move costs two searches
    // normally and one when it ends the game.
    //
    // Both go through `AnalysisService`: the server's limits policy, FEN validation, deterministic
    // timeout and the one dedicated pool of ADR-0113 apply to each.
    const [outcome, afterOutcome] = await Promise.all([
      this.analysis.analyze({ fen: input.fen, variant: input.variant, multiPv: 1 }),
      moveTerminal
        ? Promise.resolve(undefined)
        : this.analysis.analyze({ fen: afterMove.fen(), variant: input.variant, multiPv: 1 }),
    ]);

    // No lines means no evidence, and no evidence means no explanation.
    //
    // A search can end without producing any `info` line — a position with a single legal reply, a
    // budget consumed before the first iteration completes, an engine stopped early. `MoveExplainer`
    // treats empty pre-computed analysis as "none supplied" and would fall through to its own
    // engine, which this composition deliberately does not have; the resulting composition error
    // would surface as a 500. Worse would be the version of that fallback which succeeds: its
    // zero-value citation reports `+0.00` at depth 0, a number no engine produced, attached to prose
    // the model wrote with nothing to defer to. Refusing is the only answer consistent with the
    // feature's premise.
    if (outcome.lines.length === 0 || (afterOutcome !== undefined && afterOutcome.lines.length === 0)) {
      throw new HttpError(503, 'service_unavailable', 'the engine returned no evaluation to explain', undefined, {
        'Retry-After': '1',
      });
    }

    let explanation;
    try {
      explanation = await this.explainer.explain({
        fen: input.fen,
        move: input.move,
        variant: input.variant,
        // Always supplied, so the explainer never reaches for an engine — it is composed without
        // one, so there is none to reach for.
        analysis: outcome.lines,
        ...(afterOutcome ? { analysisAfterMove: afterOutcome.lines } : {}),
        ...(moveTerminal
          ? {
              terminalAfterMove: {
                reason: moveTerminal.reason,
                result: moveTerminal.result,
                // The phrase is built here, where the vocabulary lives. `ai-features` sits below the
                // API and should not be deciding how a chess result reads in English.
                describe: describeTerminal(moveTerminal),
              },
            }
          : {}),
        // Derived from the position, never accepted from the caller: the FEN already determines who
        // is to move, and taking a second opinion on it would let a request tell the model that the
        // other side played the move.
        side: position.turn === 'w' ? 'white' : 'black',
      });
    } catch (err: unknown) {
      throw toHttpError(err);
    }

    return {
      fen: input.fen,
      variant: input.variant,
      move: input.move,
      explanation: explanation.explanation,
      citation: {
        moveOutcome: moveTerminal
          ? { kind: 'terminal', reason: moveTerminal.reason, result: moveTerminal.result }
          : {
              kind: 'evaluation',
              // Non-null by construction: with no terminal outcome the post-move search ran and
              // returned a line, so the explainer populated these. The fallbacks keep the wire shape
              // total rather than letting a future change emit a response missing its central fact.
              evalKind: explanation.citation.moveEvalKind ?? explanation.citation.evalKind,
              evalValue: explanation.citation.moveEvalValue ?? explanation.citation.evalValue,
              evalLabel: explanation.citation.moveEvalLabel ?? explanation.citation.evalLabel,
            },
        evalKind: explanation.citation.evalKind,
        evalValue: explanation.citation.evalValue,
        evalLabel: explanation.citation.evalLabel,
        bestMove: explanation.citation.bestMove ?? null,
        bestLine: explanation.citation.bestLine,
        depth: explanation.citation.depth,
      },
      providerId: explanation.providerId,
      model: explanation.model,
    };
  }
}

/**
 * Translate an AI failure into the API's error vocabulary.
 *
 * Delegates to the shared {@link aiErrorToHttp}, which this function was until tournament commentary
 * needed the same mapping under a different name (ADR-0130). Kept as a named export because it is
 * this service's contract and its tests name it.
 *
 * @param err - the thrown value.
 * @returns an `HttpError` for a provider failure, or `err` unchanged for anything else.
 */
export function toHttpError(err: unknown): unknown {
  return aiErrorToHttp(err, 'move explanation');
}
