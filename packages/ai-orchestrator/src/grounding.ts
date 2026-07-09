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

/** Format engine grounding as a human-readable system message. */
export function formatGrounding(grounding: EngineGrounding): string {
  const lines: string[] = [
    'You are a chess assistant. Your analysis must be grounded in the following engine facts. Do not invent moves, evaluations, or lines.',
    '',
    `Position FEN: ${grounding.fen}`,
  ];

  if (grounding.moveUci) {
    lines.push(`Move to explain: ${grounding.moveUci}`);
  }

  if (grounding.evalMate !== undefined) {
    lines.push(`Engine evaluation: mate in ${Math.abs(grounding.evalMate)} (${grounding.evalMate > 0 ? 'side to move wins' : 'side to move loses'})`);
  } else if (grounding.evalCp !== undefined) {
    const evalStr = grounding.evalCp >= 0
      ? `+${(grounding.evalCp / 100).toFixed(2)}`
      : `${(grounding.evalCp / 100).toFixed(2)}`;
    lines.push(`Engine evaluation: ${evalStr} (from side to move's perspective)`);
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
  const base = `${grounding.fen}|${grounding.moveUci ?? ''}`;
  return hashString(base);
}
