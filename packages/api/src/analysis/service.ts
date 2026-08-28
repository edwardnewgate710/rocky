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
import { parseFen, toFen } from '@chess-platform/core';
import { HttpError } from '../http/errors.js';
import { coreFenValidator } from './fen-validator.js';
import type { TerminalOutcome } from './terminal.js';
import { terminalOutcome } from './terminal.js';
import type {
  AnalysisLimitsPolicy,
  AppliedAnalysisLimits,
  RequestedAnalysisLimits,
} from './limits.js';
import {
  applyAnalysisLimits,
  DEFAULT_ANALYSIS_LIMITS,
} from './limits.js';

/**
 * The FEN the engine is actually asked about.
 *
 * A caller may send a Three-Check position in any accepted spelling, including the legacy
 * six-field one that carries no counters at all. Fairy-Stockfish does not read a missing counter
 * field as "nothing delivered yet" — it defaults to **one check remaining for each side**, so a
 * fresh position was analysed as though either player could win with a single check. Measured
 * against Fairy-Stockfish 14: the Italian Game under `3check` came back `mate 1` with the
 * six-field FEN and a real six-ply line with the canonical one.
 *
 * Re-serialising through the codec puts the counters in the canonical field. That is also what
 * makes the analysis cache key carry them, so two boards differing only in checks delivered can
 * no longer share an entry — and anything cached under the old wrong reading becomes unreachable
 * rather than being served again.
 *
 * Only Three-Check is rewritten. Every other variant reaches the engine exactly as the caller
 * wrote it, so no other cache identity moves. See ADR-0120.
 */
function engineFenFor(fen: string, variant: Variant): string {
  if (variant !== 'threecheck') return fen;
  return toFen(parseFen(fen, variant));
}

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
  /** Whether the routed engine can honor an exact MultiPV count without clamping. */
  readonly supportsMultiPv?: (variant: string, count: number) => boolean;
}

/**
 * What a feature service needs from analysis, as an interface rather than the concrete class.
 *
 * The feature services (mistake prediction, move explanation, puzzle generation, endgame training,
 * Game Review, and the Coach orchestrator that composes them) reach the engine only through these
 * four methods. Naming them is what lets `RequestScopedAnalysis` — which de-duplicates
 * identical searches and threads a cancellation signal through them — be passed to a service that
 * previously named `AnalysisService` directly. `AnalysisService` implements this as written; the
 * change is types only, and no runtime behaviour moves.
 */
export interface AnalysisPort {
  /** @returns whether this deployment has an engine that would serve `variant`. Advisory. */
  supportsVariant(variant: string): boolean;
  /** @returns whether the routed engine can honor `count` lines without clamping. */
  supportsMultiPv(variant: string, count: number): boolean;
  /** @returns whether this deployment's ceilings can honor every requested limit unchanged. */
  canSatisfyLimits(requested: RequestedAnalysisLimits): boolean;
  /** @returns the search result, after the server's own limits policy has been applied. */
  analyze(input: AnalyzeInput): Promise<AnalysisOutcome>;
}

/**
 * One analysis request as a feature service issues it.
 *
 * `signal` is deliberately absent from every route's request body and present here: cancellation is
 * something the server learns from the socket, never something a client asks for in JSON.
 */
export interface AnalyzeInput {
  readonly fen: string;
  readonly variant: string;
  readonly depth?: number | undefined;
  readonly nodes?: number | undefined;
  readonly movetimeMs?: number | undefined;
  readonly multiPv?: number | undefined;
  /**
   * Cancels this search when the caller no longer needs it.
   *
   * Combined with — never replacing — the internal timeout controller below. The engine's own
   * `AnalysisRequest.signal` already removes a queued job or stops an in-flight one, so this is the
   * last missing link between a client disconnecting and a worker giving up its search.
   */
  readonly signal?: AbortSignal | undefined;
}

export class AnalysisService implements AnalysisPort {
  private readonly provider: AnalysisProvider;
  private readonly policy: AnalysisLimitsPolicy;
  private readonly timeoutGraceMs: number;
  private readonly fenValidator: FenValidator;
  private readonly variantSupported: (variant: string) => boolean;
  private readonly multiPvSupported: (variant: string, count: number) => boolean;

  constructor(options: AnalysisServiceOptions) {
    this.provider = options.provider;
    this.policy = options.policy ?? DEFAULT_ANALYSIS_LIMITS;
    this.timeoutGraceMs = options.timeoutGraceMs ?? 2000;
    this.fenValidator = options.fenValidator ?? coreFenValidator;
    this.variantSupported = options.supportsVariant ?? (() => true);
    this.multiPvSupported = options.supportsMultiPv ?? (() => true);
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

  supportsMultiPv(variant: string, count: number): boolean {
    return this.variantSupported(variant) && this.multiPvSupported(variant, count);
  }

  /**
   * Whether this deployment's ceilings can honor every explicitly requested limit unchanged.
   *
   * Feature composition uses this before advertising a capability with a stricter fixed policy.
   * The ordinary analysis endpoint may safely clamp a request; a feature that promises one exact
   * evidence policy must instead stay unavailable when an operator has deliberately tightened a
   * ceiling below it.
   */
  canSatisfyLimits(requested: RequestedAnalysisLimits): boolean {
    const applied = applyAnalysisLimits(requested, this.policy);
    return (
      (requested.depth === undefined || applied.depth === requested.depth) &&
      (requested.nodes === undefined || applied.nodes === requested.nodes) &&
      (requested.movetimeMs === undefined || applied.movetimeMs === requested.movetimeMs) &&
      (requested.multiPv === undefined || applied.multiPv === requested.multiPv)
    );
  }

  /**
   * Search a position under this deployment's limits policy.
   *
   * @param input - the position, variant, requested limits, and an optional caller signal.
   * @returns the lines the engine produced, or a terminal outcome for a decided position — which
   * costs no search at all, because there is no move to find.
   */
  async analyze(input: AnalyzeInput): Promise<AnalysisOutcome> {
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

    // The caller's signal is combined with the timeout, never substituted for it. A caller that
    // cancels early should shorten this search; a caller that never cancels must not be able to
    // lengthen it past the deterministic ceiling, which is what passing `input.signal` straight
    // through would do. `AbortSignal.any` follows whichever fires first and is available
    // unconditionally on the supported runtimes (`engines.node: >=22`, CI matrix 22.x and 24.x).
    const signal = input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal;

    try {
      const limits: AnalysisLimits = {
        depth: applied.depth,
        timeMs: applied.movetimeMs,
        ...(applied.nodes !== undefined ? { nodes: applied.nodes } : {}),
      };

      const request: AnalysisRequest = {
        fen: engineFenFor(input.fen, input.variant as Variant),
        variant: input.variant,
        limits,
        multiPv: applied.multiPv,
        priority: JobPriority.LiveAnalysis,
        signal,
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
