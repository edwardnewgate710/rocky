import { Position, type Variant } from '@chess-platform/core';
import type { AnalysisProvider, Evaluation } from '@chess-platform/engine';
import type { PositionEvaluator, PlyEvaluation } from './port';
import type { AnalyzedPly, Player } from './analyzer';
import { MATE_ENCODING } from './analyzer';

export class EngineBackedEvaluator implements PositionEvaluator {
  constructor(
    private readonly provider: AnalysisProvider,
    private readonly variant: Variant = 'standard',
  ) {}

  async evaluate(fen: string, playedUci: string, depth: number): Promise<PlyEvaluation> {
    const lines = await this.provider.analyze({
      fen,
      variant: this.variant,
      limits: { depth },
      multiPv: 3,
    });

    const topMoves: { uci: string; cp: number }[] = [];
    let playedCp: number | undefined;

    for (const line of lines) {
      if (line.principalVariation.length === 0) continue;
      const uci = line.principalVariation[0];
      const cp = this.toCp(line.evaluation);
      topMoves.push({ uci, cp });
      
      if (uci === playedUci) {
        playedCp = cp;
      }
    }

    if (topMoves.length === 0) {
      // Unscorable
      return { topMoves: [] };
    }

    if (playedCp === undefined) {
      // The played move was outside the top N.
      // We must evaluate the resulting position and negate it.
      let pos: Position;
      try {
        pos = Position.fromFen(fen, this.variant);
      } catch {
        return { topMoves: [] }; // Invalid fen
      }

      if (pos.status().over) {
        return { topMoves: [] }; // Terminal original position
      }

      try {
        pos = pos.play(playedUci);
      } catch {
        // Illegal move played, should not happen in valid game data but handle gracefully
        return { topMoves: [] };
      }

      const status = pos.status();
      if (status.over) {
        if (status.reason === 'checkmate') {
          // The mover delivered checkmate. It's +MATE_ENCODING.
          playedCp = MATE_ENCODING;
        } else {
          // Draw/Stalemate
          playedCp = 0;
        }
      } else {
        const resultingLines = await this.provider.analyze({
          fen: pos.fen(),
          variant: this.variant,
          limits: { depth },
          multiPv: 1,
        });

        if (resultingLines.length > 0) {
          const resultingEval = resultingLines[0].evaluation;
          // Negate the evaluation because the side to move flipped.
          playedCp = -this.toCp(resultingEval);
        } else {
          // Engine returned no lines for the resulting position
          return { topMoves: [] };
        }
      }
    }

    return { topMoves, playedCp };
  }

  private toCp(evaluation: Evaluation): number {
    if (evaluation.type === 'cp') {
      return evaluation.value;
    }
    // mate value is signed moves-to-mate
    const sign = Math.sign(evaluation.value);
    const movesToMate = Math.abs(evaluation.value);
    // magnitude shrinks as movesToMate grows. +1 for mate-in-1.
    const magnitude = Math.max(0, MATE_ENCODING - (movesToMate > 0 ? movesToMate - 1 : 0));
    return sign * magnitude;
  }
}

export function extractPlies(
  moves: readonly string[],
  variant: Variant,
  isBook: (plyIndex: number) => boolean = () => false,
): AnalyzedPly[] {
  let pos = Position.initial(variant);
  const plies: AnalyzedPly[] = [];

  for (let i = 0; i < moves.length; i++) {
    const fen = pos.fen();
    const player: Player = pos.turn === 'w' ? 'white' : 'black';
    const playedUci = moves[i];
    const book = isBook(i);

    plies.push({
      fen,
      playedUci,
      player,
      ...(book ? { isBook: true } : {}),
    });

    try {
      pos = pos.play(playedUci);
    } catch {
      throw new Error(`extractPlies: illegal move '${playedUci}' at ply ${i} in variant ${variant}`);
    }
  }

  return plies;
}
