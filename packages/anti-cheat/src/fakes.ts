import type { PlyEvaluation, PositionEvaluator } from './port';

export class InMemoryEvaluator implements PositionEvaluator {
  private readonly evaluations = new Map<string, PlyEvaluation>();

  set(fenOrId: string, evalResult: PlyEvaluation): void {
    this.evaluations.set(fenOrId, evalResult);
  }

  evaluate(fenOrPositionId: string, playedUci: string, _depth: number): PlyEvaluation {
    const res = this.evaluations.get(fenOrPositionId);
    if (!res) {
      return { topMoves: [] };
    }
    // A real engine always returns the played move's own eval. Honour an
    // explicitly-set `playedCp` (used to model a played move that falls outside
    // the stored top moves); otherwise derive it from the top moves. If the
    // played move is absent and no `playedCp` was set, it stays undefined and
    // the analyzer treats the ply as unscored rather than synthesizing a loss.
    const played = res.topMoves.find((m) => m.uci === playedUci);
    return { topMoves: res.topMoves, playedCp: res.playedCp ?? played?.cp };
  }
}
