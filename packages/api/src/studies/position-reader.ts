import { Position } from '@chess-platform/core';
import type { PositionReader } from '@chess-platform/studies';

export class CorePositionReader implements PositionReader {
  legalSans(fen: string): readonly string[] {
    const pos = Position.fromFen(fen);
    return pos.legalMoves().map((m) => pos.toSan(m));
  }

  play(fen: string, san: string): string {
    const pos = Position.fromFen(fen);
    const legalMoves = pos.legalMoves();
    let move = legalMoves.find((m) => pos.toSan(m) === san);
    if (!move) {
      const bareSan = (s: string) =>
        s
          .replace(/[+#]+$/, '')
          .replace(/[!?]+$/, '')
          .replace(/^0-0-0$/, 'O-O-O')
          .replace(/^0-0$/, 'O-O');
      const target = bareSan(san);
      move = legalMoves.find((m) => bareSan(pos.toSan(m)) === target);
    }
    if (!move) {
      throw new Error(`Move '${san}' is not legal from position '${fen}'`);
    }
    return pos.play(move).fen();
  }
}
