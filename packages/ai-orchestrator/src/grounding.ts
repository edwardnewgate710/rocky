/**
 * Engine-grounded prompt builder.  Converts structured {@link EngineGrounding}
 * into provider-agnostic system/user messages.  No provider-specific prompt
 * templates — every provider receives the same grounded context.
 */

import type { EngineGrounding, Message } from './types.js';
import { hashString } from './cache.js';

/**
 * Build provider-agnostic messages from a base conversation + engine
 * grounding.  The grounding is appended as a system message with
 * structured facts, so the LLM can reason about the position without
 * inventing details.
 */
export function buildGroundedMessages(
  messages: readonly Message[],
  grounding: EngineGrounding,
): readonly Message[] {
  const groundingText = formatGrounding(grounding);
  const groundingMessage: Message = {
    role: 'system',
    content: groundingText,
  };
  // Insert grounding after the first system message (if any), or prepend.
  if (messages.length > 0 && messages[0].role === 'system') {
    return [messages[0], groundingMessage, ...messages.slice(1)];
  }
  return [groundingMessage, ...messages];
}

/** Centipawns as pawns, always signed, so `+0.35` and `-0.35` read as a pair. */
function formatCp(centipawns: number): string {
  const pawns = centipawns / 100;
  return pawns >= 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
}

/** Format engine grounding as a human-readable system message. */
export function formatGrounding(grounding: EngineGrounding): string {
  const lines: string[] = [
    'You are a chess assistant. Your analysis must be grounded in the following engine facts. Do not invent moves, evaluations, or lines.',
    '',
    `Position FEN: ${grounding.fen}`,
  ];

  // Before the move and the evaluation, because it changes what both of them mean: a FEN carries no
  // rules of its own, and "winning" under Atomic or Racing Kings is not the same claim as under
  // standard chess.
  if (grounding.variant) {
    lines.push(`Variant: ${grounding.variant}`);
  }

  if (grounding.moveUci) {
    lines.push(`Move to explain: ${grounding.moveUci}`);
  }

  // The move's own evaluation, before the engine's — because when a move is being explained, what
  // it achieves is the subject and what the engine would have preferred is the comparison. Stated
  // first so the two are not read as one number.
  if (grounding.moveEvalMate !== undefined) {
    lines.push(
      `Evaluation after ${grounding.moveUci ?? 'the move'}: mate in ${Math.abs(grounding.moveEvalMate)} ` +
        `(${grounding.moveEvalMate > 0 ? 'the player who moved mates' : 'the player who moved gets mated'})`,
    );
  } else if (grounding.moveEvalCp !== undefined) {
    lines.push(
      `Evaluation after ${grounding.moveUci ?? 'the move'}: ${formatCp(grounding.moveEvalCp)} ` +
        `(from the perspective of the player who moved)`,
    );
  }

  if (grounding.evalMate !== undefined) {
    lines.push(`Engine evaluation: mate in ${Math.abs(grounding.evalMate)} (${grounding.evalMate > 0 ? 'side to move wins' : 'side to move loses'})`);
  } else if (grounding.evalCp !== undefined) {
    lines.push(`Engine evaluation: ${formatCp(grounding.evalCp)} (from side to move's perspective)`);
  }

  if (grounding.depth !== undefined) {
    lines.push(`Search depth: ${grounding.depth}`);
  }

  if (grounding.bestLine && grounding.bestLine.length > 0) {
    lines.push(`Best line (UCI): ${grounding.bestLine.join(' ')}`);
  }

  if (grounding.multiPv && grounding.multiPv.length > 0) {
    lines.push('');
    lines.push('Alternative lines:');
    for (let i = 0; i < grounding.multiPv.length; i++) {
      const pv = grounding.multiPv[i];
      const evalStr = pv.evalMate !== undefined
        ? `mate ${pv.evalMate}`
        : pv.evalCp !== undefined
          ? `${pv.evalCp >= 0 ? '+' : ''}${(pv.evalCp / 100).toFixed(2)}`
          : 'unknown';
      lines.push(`  ${i + 1}. ${evalStr}: ${pv.pv.join(' ')}`);
    }
  }

  if (grounding.legalMoves && grounding.legalMoves.size > 0) {
    lines.push('');
    lines.push('Legal moves:');
    const entries = [...grounding.legalMoves.entries()];
    for (const [from, tos] of entries) {
      lines.push(`  ${from} → ${tos.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Cite these facts when explaining. If the engine evaluation contradicts your reasoning, defer to the engine.');

  return lines.join('\n');
}

/**
 * Extract a position hash from grounding for cache keys.
 * This is a stable hash of the FEN + move, not of the full grounding
 * (which includes engine output that may vary by depth).
 */
export function positionHash(grounding: EngineGrounding): string {
  // Variant is part of the identity, not decoration: the same FEN and move under Atomic and under
  // standard chess are different positions with different best play, and a hash documented as
  // usable for cache keys must not conflate them.
  const base = `${grounding.fen}|${grounding.variant ?? ''}|${grounding.moveUci ?? ''}`;
  return hashString(base);
}
