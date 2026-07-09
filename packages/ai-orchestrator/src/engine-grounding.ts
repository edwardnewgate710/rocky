/**
 * Engine grounding integration.  Converts engine analysis results from
 * `@chess-platform/engine` into the `EngineGrounding` type used by the
 * orchestrator's prompt builder.
 *
 * This is the bridge between the M5 engine bridge and the M7 AI
 * orchestrator: the engine produces structured analysis (eval, best
 * line, depth), and this function converts it into the grounding context
 * that the orchestrator passes to LLM providers.
 */

import type { EngineResult, Evaluation } from '@chess-platform/engine';
import type { EngineGrounding, EnginePvLine } from './types.js';

/**
 * Convert engine analysis results into grounding context for LLM prompts.
 *
 * @param fen - The FEN of the position being analyzed.
 * @param results - Engine analysis results (from `AnalysisProvider.analyze()`).
 * @param moveUci - Optional: the move being explained (if applicable).
 * @returns `EngineGrounding` suitable for `CompletionRequest.grounding`.
 */
export function engineResultsToGrounding(
  fen: string,
  results: readonly EngineResult[],
  moveUci?: string,
): EngineGrounding {
  if (results.length === 0) {
    return { fen, moveUci };
  }

  const best = results[0]; // multipv=1 is the best line
  const evalCp = best.evaluation.type === 'cp' ? best.evaluation.value : undefined;
  const evalMate = best.evaluation.type === 'mate' ? best.evaluation.value : undefined;
  const bestLine = best.principalVariation;

  const multiPv: EnginePvLine[] = results.slice(1).map(r => ({
    pv: r.principalVariation,
    evalCp: r.evaluation.type === 'cp' ? r.evaluation.value : undefined,
    evalMate: r.evaluation.type === 'mate' ? r.evaluation.value : undefined,
  }));

  return {
    fen,
    moveUci,
    evalCp,
    evalMate,
    bestLine,
    depth: best.depth,
    multiPv: multiPv.length > 0 ? multiPv : undefined,
  };
}

/**
 * Convert a single engine evaluation to a human-readable string.
 * Useful for inline citations in LLM responses.
 */
export function evalToString(eval_: Evaluation): string {
  if (eval_.type === 'mate') {
    return `mate ${eval_.value > 0 ? 'in ' : 'in -'}${Math.abs(eval_.value)}`;
  }
  const pawns = eval_.value / 100;
  return pawns >= 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
}
