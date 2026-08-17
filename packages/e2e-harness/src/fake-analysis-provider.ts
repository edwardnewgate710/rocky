/**
 * @packageDocumentation
 * A deterministic {@link AnalysisProvider} for the e2e harness.
 *
 * The harness serves the analysis panel's real product path — request, contract, render, lifecycle —
 * and none of that needs a chess engine's opinion. A real Stockfish would make the whole Playwright
 * suite depend on a binary CI does not install and would return a different evaluation on every run,
 * so a browser spec could not assert what it rendered. Engine reality is covered separately by
 * `packages/api/test/analysis-stockfish-smoke.test.ts`, against a real binary.
 *
 * The lines it returns are shaped to be *distinguishable* rather than realistic: a descending
 * evaluation and a different first move per line, so a spec asserting MultiPV ordering fails if the
 * rows are rendered in the wrong order or collapsed into one.
 */
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';

const FIRST_MOVES = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'] as const;

export class FakeAnalysisProvider implements AnalysisProvider {
  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    const count = Math.max(1, Math.min(request.multiPv ?? 1, FIRST_MOVES.length));
    const depth = request.limits.depth ?? 12;

    return Array.from({ length: count }, (_unused, index) => ({
      multipv: index + 1,
      // Descending, so the best line is first and a mis-ordered render is visible.
      evaluation: { type: 'cp' as const, value: 30 - index * 12 },
      principalVariation: [FIRST_MOVES[index] ?? 'e2e4', 'e7e5', 'g1f3'],
      // One below the requested depth, so a spec can tell "reached" apart from "limit" — the
      // distinction the panel must never blur.
      depth: Math.max(1, depth - 1),
      nodes: 100_000 + index,
      nps: 500_000,
      timeMs: 800,
    }));
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('FakeAnalysisProvider does not play moves.');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}
