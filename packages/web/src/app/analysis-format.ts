/**
 * Turning an engine evaluation into the number a chess player expects to read.
 *
 * One conversion here is not cosmetic. `POST /v1/analysis` returns an evaluation **from the side to
 * move** — `+0.4` means "whoever is on move is better by 0.4" — while every chess interface a
 * competitive player has used shows the score **from White's perspective**, where `+0.4` means
 * White is better regardless of whose turn it is. Rendering the API value unchanged would show the
 * correct number with the wrong sign on every Black-to-move position: the eval would appear to
 * swing by twice its value on each half-move, and a player reading it would draw the opposite
 * conclusion about who stands better. So the side to move is read from the FEN and the score is
 * negated for Black.
 *
 * Mate scores carry the same convention and the same fix: a positive mate count means the side to
 * move delivers mate, so for Black to move it becomes White getting mated.
 */
import type { AnalysisEvaluation } from '../api/models.js';

/**
 * The side to move, from a FEN's second field.
 *
 * Defaults to White for anything unparseable. That is the safe direction: the alternative is
 * throwing inside a render path over a string the server already validated, and a wrong-signed
 * evaluation is still less harmful than a panel that cannot draw at all.
 */
export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/**
 * Format an evaluation for display, always from White's perspective.
 *
 * - centipawns render as pawns to two decimals with an explicit sign: `+0.25`, `-1.40`, `0.00`
 * - mate renders as `M5` (White mates in 5) or `-M3` (White is mated in 3)
 *
 * The sign is the only cue, deliberately: colouring an advantage would need a second and third
 * accent in a system that has exactly one, and would encode the meaning in hue alone.
 */
export function formatEvaluation(evaluation: AnalysisEvaluation, fen: string): string {
  const whiteRelative = sideToMove(fen) === 'b' ? -evaluation.value : evaluation.value;

  if (evaluation.type === 'mate') {
    // `M0` would be meaningless, and `-M0` worse. A mate score of 0 means the side to move is
    // already mated, which reads as the opponent having mated.
    if (whiteRelative === 0) return 'M0';
    return whiteRelative > 0 ? `M${whiteRelative}` : `-M${Math.abs(whiteRelative)}`;
  }

  const pawns = whiteRelative / 100;
  // `toFixed` on -0.001 gives "-0.00", which reads as a negative zero advantage.
  const rounded = Object.is(Math.round(pawns * 100) / 100, -0) ? 0 : pawns;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
}

/**
 * Render a principal variation as move text.
 *
 * The moves arrive in UCI long algebraic (`e2e4`), which is what the engine speaks and what the API
 * returns. Converting to SAN would need a rules engine in the client, and this package deliberately
 * has none — the board's legal moves are server-authoritative (ADR-0003). Showing UCI is honest
 * about what we know rather than guessing at notation we cannot derive.
 */
export function formatPrincipalVariation(moves: readonly string[], limit = 8): string {
  return moves.slice(0, limit).join(' ');
}

/** `1234` → `1.2 s`; small values keep a decimal so a fast search does not read as `0 s`. */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0 s';
  return `${(ms / 1000).toFixed(1)} s`;
}
