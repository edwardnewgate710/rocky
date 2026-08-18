/**
 * @packageDocumentation
 * Domain analysis service orchestrating limits enforcement, engine invocation,
 * deterministic timeouts, and HTTP error mapping.
 */

import type {
  AnalysisLimits,
  AnalysisProvider,
  AnalysisRequest,
  EngineResult,
} from '@chess-platform/engine';
import { EngineError, JobPriority } from '@chess-platform/engine';
import type { FenValidator } from '@chess-platform/engine';
import type { Variant } from '@chess-platform/core';
import { HttpError } from '../http/errors.js';
import { coreFenValidator } from './fen-validator.js';
import type { TerminalOutcome } from './terminal.js';
import { terminalOutcome } from './terminal.js';
import type {
  AnalysisLimitsPolicy,
  AppliedAnalysisLimits,
} from './limits.js';
import {
  applyAnalysisLimits,
  DEFAULT_ANALYSIS_LIMITS,
} from './limits.js';

export interface AnalysisOutcome {
  readonly fen: string;
  readonly variant: string;
  readonly applied: AppliedAnalysisLimits;
  readonly lines: readonly EngineResult[];
  /**
   * Set when the position is already decided, in which case `lines` is empty and no engine ran.
   *
   * A finished game has an outcome, not an evaluation, and the two are different kinds of fact —
   * hence a separate field rather than a sentinel score. See `terminal.ts` for why the engine's own
   * placeholder must not be presented as one.
   */
  readonly terminal?: TerminalOutcome;
}

export interface AnalysisServiceOptions {
  readonly provider: AnalysisProvider;
  readonly policy?: AnalysisLimitsPolicy;
  /**
   * Slack between the search's own `movetime` budget and the abort that backstops it.
   *
   * `movetimeMs` bounds how long the engine may *search*; it says nothing about how long the job
   * waited in the queue or for a worker to spawn. Aborting exactly at `movetimeMs` would therefore
   * cancel healthy requests for being busy. This abort exists for the case the budget cannot
   * cover — an engine that has stopped honouring its own limit.
   */
  readonly timeoutGraceMs?: number;
  /**
   * Validates the position before it is handed to the provider. Defaults to
   * {@link coreFenValidator}; injectable so tests can drive the failure path.
   */
  readonly fenValidator?: FenValidator;
  /**
   * Whether this deployment can analyse a given variant, answered without spawning an engine.
   *
   * Supplied by the composition root, which knows which engine binaries are configured — not read
   * off `AnalysisProvider`, because that interface is implemented by a couple of dozen test doubles
   * across `ai-features`, `anti-cheat` and this package, and none of them has an opinion about a
   * deployment's binaries. Putting it here keeps the knowledge where it actually lives.
   *
   * Defaults to permitting everything, which is what a provider double should do: it preserves the
   * behaviour every existing test expects, and the route still rejects an unroutable variant at
   * request time regardless.
   */
  readonly supportsVariant?: (variant: string) => boolean;
}

export class AnalysisService {
  private readonly provider: AnalysisProvider;
  private readonly policy: AnalysisLimitsPolicy;
  private readonly timeoutGraceMs: number;
  private readonly fenValidator: FenValidator;
  private readonly variantSupported: (variant: string) => boolean;

  constructor(options: AnalysisServiceOptions) {
    this.provider = options.provider;
    this.policy = options.policy ?? DEFAULT_ANALYSIS_LIMITS;
    this.timeoutGraceMs = options.timeoutGraceMs ?? 2000;
    this.fenValidator = options.fenValidator ?? coreFenValidator;
    this.variantSupported = options.supportsVariant ?? (() => true);
  }

  /**
   * Whether this deployment has an engine that would serve `variant`.
   *
   * Advisory: it lets a caller avoid offering a control that cannot work. It is not the enforcement
   * point — `analyze` still routes, and an unroutable variant is still rejected there.
   */
  supportsVariant(variant: string): boolean {
    return this.variantSupported(variant);
  }

  async analyze(input: {
    fen: string;
    variant: string;
    depth?: number;
    nodes?: number;
    movetimeMs?: number;
    multiPv?: number;
  }): Promise<AnalysisOutcome> {
    const applied = applyAnalysisLimits(input, this.policy);

    // Validate here, not only inside the provider. `EngineManager` runs a `FenValidator` of its own,
    // so today this is the second of two checks — but it is the only one the *API* owns. UCI is a
    // newline-delimited protocol and `buildPositionCommand` interpolates the FEN into a `position
    // fen ...` line, so an unvalidated FEN carrying a terminator is an injected engine command, and
    // `setoption name Threads value 128` defeats every limit in this file at once. ADR-0113 plans to
    // move analysis to a remote worker behind this same `AnalysisProvider` interface; on the day
    // that lands the in-process manager — and its validator — is gone, and this boundary is what
    // stops the hole opening silently. Cheap enough to run twice: a regex and a parse.
    try {
      this.fenValidator.validate(input.fen, input.variant);
    } catch (err: unknown) {
      throw toHttpError(err);
    }

    // Decide the position before asking anything to search it.
    //
    // A position with no legal moves gives the engine nothing to score, and it answers with a
    // placeholder `{ cp: 0, depth: 0 }` that reads as "dead level" — so checkmate was served to
    // clients as `+0.00`. Resolving it here fixes the answer and removes the search: there is no
    // move to find, so the cheapest correct request is the one that never reaches a worker.
    //
    // Deliberately *after* validation above: by here the FEN has passed the character allowlist,
    // `parseFen` and the king-count check, so adjudication is reading a position rather than a
    // guess. `input.variant` has already passed `parseVariant` at the route, so the cast names the
    // type the value already has.
    const terminal = terminalOutcome(input.fen, input.variant as Variant);
    if (terminal) {
      return { fen: input.fen, variant: input.variant, applied, lines: [], terminal };
    }

    const controller = new AbortController();
    const timeoutMs = applied.movetimeMs + this.timeoutGraceMs;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const limits: AnalysisLimits = {
        depth: applied.depth,
        timeMs: applied.movetimeMs,
        ...(applied.nodes !== undefined ? { nodes: applied.nodes } : {}),
      };

      const request: AnalysisRequest = {
        fen: input.fen,
        variant: input.variant,
        limits,
        multiPv: applied.multiPv,
        priority: JobPriority.LiveAnalysis,
        signal: controller.signal,
      };

      const lines = await this.provider.analyze(request);

      return {
        fen: input.fen,
        variant: input.variant,
        applied,
        lines,
      };
    } catch (err: unknown) {
      throw toHttpError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Translate an engine failure into the API's error vocabulary.
 *
 * `ErrorCode` is a closed union and widening it would change the error contract of every route, so
 * transient engine failures all land on `service_unavailable` and are told apart by message.
 *
 * Engine-internal failures get a fixed, generic message on purpose: `HttpError` messages are
 * surfaced to clients, and these errors can carry binary paths, argv and engine version strings.
 * Nothing here interpolates `err.message`.
 *
 * Anything that is not an `EngineError` is rethrown untouched so a genuine bug surfaces as a 500
 * rather than being disguised as a temporary engine problem.
 */
function toHttpError(err: unknown): unknown {
  if (!(err instanceof EngineError)) return err;

  switch (err.code) {
    case 'invalid_fen':
      return HttpError.validation('invalid FEN', { fen: 'invalid FEN' });
    case 'no_engine_for_variant':
      return HttpError.validation('unsupported variant', { variant: 'unsupported variant' });
    case 'queue_full':
      return new HttpError(503, 'service_unavailable', 'analysis engine is saturated', undefined, {
        'Retry-After': '1',
      });
    case 'circuit_open':
      return new HttpError(503, 'service_unavailable', 'analysis engine circuit breaker is open', undefined, {
        'Retry-After': '5',
      });
    case 'shutting_down':
      return new HttpError(503, 'service_unavailable', 'analysis engine is shutting down');
    case 'engine_timeout':
      return new HttpError(503, 'service_unavailable', 'analysis engine timed out');
    case 'cancelled':
      return new HttpError(503, 'service_unavailable', 'analysis request timed out or was cancelled');
    case 'engine_crashed':
    case 'protocol':
    case 'engine_version':
    case 'not_initialized':
      return new HttpError(503, 'service_unavailable', 'analysis engine failed');
    default:
      return err;
  }
}
