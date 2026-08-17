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
import { AiError } from '@chess-platform/ai-orchestrator';
import { HttpError } from '../http/errors.js';
import type { AnalysisService } from '../analysis/service.js';
import { coreFenValidator } from '../analysis/fen-validator.js';

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
    /** Evaluation of the position after the requested move. */
    readonly moveEvalKind: 'cp' | 'mate';
    readonly moveEvalValue: number;
    readonly moveEvalLabel: string;
    /** Evaluation the engine's own best move achieves from the same position. */
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
  readonly analysis: AnalysisService;
  readonly explainer: MoveExplainer;
}

/**
 * A cheap shape filter, and *not* the legality check.
 *
 * It exists to reject obvious junk before building a `Position`, and to bound what reaches the
 * matcher. The authority is {@link Position.play}, which resolves the move against generated legal
 * moves and throws when there is no match; this regex could not tell a legal move from an illegal
 * one and is never asked to.
 */
const UCI_SHAPE = /^(?:[a-h][1-8][a-h][1-8][qrbn]?|[PNBRQ]@[a-h][1-8])$/;

export class MoveExplanationService {
  private readonly analysis: AnalysisService;
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

    if (!UCI_SHAPE.test(input.move)) {
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

    // Two searches, and both are needed.
    //
    // The first describes the position as the player found it, so its evaluation and best line are
    // what the *engine* would have done. The second describes the position they actually created.
    // Analysing only the first — as this did until the Qodo review of PR #134 — answers "explain
    // e2e4" with the evaluation of whatever move the engine preferred, so any move that is not the
    // engine's choice gets facts about a different move, and a blunder is cited with the numbers of
    // the best reply. The gap between the two is the entire judgement.
    //
    // Both run through `AnalysisService`: the server's limits policy, FEN validation, deterministic
    // timeout and the one dedicated pool of ADR-0113 apply to each. The cost is two searches per
    // request, stated plainly in ADR-0115 rather than left implied by "one".
    const [outcome, afterOutcome] = await Promise.all([
      this.analysis.analyze({ fen: input.fen, variant: input.variant, multiPv: 1 }),
      this.analysis.analyze({ fen: afterMove.fen(), variant: input.variant, multiPv: 1 }),
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
    if (outcome.lines.length === 0 || afterOutcome.lines.length === 0) {
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
        analysisAfterMove: afterOutcome.lines,
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
        // Non-null by construction: both searches returned at least one line, so the explainer
        // populated the post-move fields. The fallbacks keep the wire shape total rather than
        // letting a future change quietly emit a response missing its central number.
        moveEvalKind: explanation.citation.moveEvalKind ?? explanation.citation.evalKind,
        moveEvalValue: explanation.citation.moveEvalValue ?? explanation.citation.evalValue,
        moveEvalLabel: explanation.citation.moveEvalLabel ?? explanation.citation.evalLabel,
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
 * Every branch returns a fixed string. `AiError.message` is built from the provider's own response
 * body — `openai-adapter.ts` reads `error.message` straight out of it — so interpolating it here
 * would forward a third party's error text, and with it whatever that vendor chose to say about our
 * account, our key prefix, our organisation or our quota. The client learns that the feature is
 * unavailable and nothing about who was supposed to serve it.
 *
 * Everything is a 503 rather than a 500 because none of these is the caller's fault and all of them
 * are worth retrying later; `auth_failed` in particular is a deployment misconfiguration, and
 * telling the caller "unauthorized" would be a lie about *their* credentials.
 *
 * Anything that is not an `AiError` is rethrown untouched so a genuine bug surfaces as a 500 instead
 * of being disguised as a temporary provider problem — the same rule `analysis/service.ts` follows.
 */
export function toHttpError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  if (!(err instanceof AiError)) return err;

  switch (err.code) {
    case 'provider_timeout':
      return new HttpError(503, 'service_unavailable', 'move explanation timed out', undefined, {
        'Retry-After': '5',
      });
    case 'rate_limited':
      // The *provider* rate-limited us, not the user. A 429 here would tell the caller to slow down
      // about a ceiling they have no way to see and did not exceed.
      return new HttpError(503, 'service_unavailable', 'move explanation is temporarily unavailable', undefined, {
        'Retry-After': '30',
      });
    case 'no_provider':
    case 'provider_unavailable':
    case 'circuit_open':
      return new HttpError(503, 'service_unavailable', 'move explanation is temporarily unavailable', undefined, {
        'Retry-After': '30',
      });
    case 'cancelled':
      return HttpError.unavailable('move explanation was cancelled');
    default:
      // Including `auth_failed`, `provider_error`, `invalid_response`, `context_too_long`,
      // `content_filtered`, `budget_exceeded` and `config_error` — all deployment- or vendor-side,
      // none of them the caller's business, and every one of them carrying a message worth not
      // forwarding.
      return HttpError.unavailable('move explanation is unavailable');
  }
}
