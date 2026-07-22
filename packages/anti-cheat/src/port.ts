export interface PlyEvaluation {
  /**
   * Top moves, ranked by evaluation from best to worst.
   * `cp` (centipawns) is strictly side-to-move relative (positive is good for the
   * side to move). Mates are encoded as a large bounded magnitude
   * (e.g. 10000 for mate-in-1, 9999 for mate-in-2). Empty when the position could
   * not be evaluated (e.g. a terminal position) — the analyzer treats such plies
   * as unscorable rather than guessing a loss.
   */
  readonly topMoves: readonly { uci: string; cp: number }[];
  /**
   * The engine's evaluation (side-to-move relative cp) of the ACTUALLY played
   * move. Supplied by the evaluator so the analyzer never has to synthesize a
   * loss when the played move falls outside `topMoves`. Undefined only when the
   * position itself was unevaluable (`topMoves` empty).
   */
  readonly playedCp?: number;
}

export interface PositionEvaluator {
  /**
   * Evaluate a position and, crucially, the actually played move. Returns the
   * ranked top moves plus `playedCp` (the played move's own eval) at the given
   * depth. `fenOrPositionId` may be a FEN or an opaque identifier.
   */
  evaluate(
    fenOrPositionId: string,
    playedUci: string,
    depth: number,
  ): Promise<PlyEvaluation> | PlyEvaluation;
}
