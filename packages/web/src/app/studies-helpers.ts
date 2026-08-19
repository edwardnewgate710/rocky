/**
 * Studies pure helpers — NAG mapping, tree building from flat list, and move numbering formatting.
 */
import type { TreeNodeView, Variant } from '../api/models.js';

/**
 * Map PGN NAG code (1-6) to traditional chess annotation symbol.
 * Codes outside 1-6 return empty string.
 */
export function formatNag(nag: number): string {
  switch (nag) {
    case 1:
      return '!';
    case 2:
      return '?';
    case 3:
      return '!!';
    case 4:
      return '??';
    case 5:
      return '!?';
    case 6:
      return '?!';
    default:
      return '';
  }
}

/**
 * Format a list of NAG numbers into a concatenated symbol suffix.
 */
export function formatNags(nags: readonly number[]): string {
  if (nags.length === 0) return '';
  return nags.map(formatNag).join('');
}

/**
 * Parse active turn ('w' | 'b') and fullmove number from starting FEN string.
 */
export function parseStartingFen(
  startingFen: string,
  variant: Variant = 'standard',
): { turn: 'w' | 'b'; fullmove: number } {
  const parts = startingFen.trim().split(/\s+/);
  const turn = parts[1] === 'b' ? 'b' : 'w';
  // Three-Check accepts canonical counters in field five, plus legacy six-field and trailing
  // delivered-counter forms. Only the canonical spelling shifts the clock fields.
  const hasCanonicalCounter = variant === 'threecheck' && /^\d+\+\d+$/.test(parts[4] ?? '');
  const fullmoveIndex = hasCanonicalCounter ? 6 : 5;
  const fullmove = parts[fullmoveIndex] ? parseInt(parts[fullmoveIndex], 10) : 1;
  return { turn, fullmove: isNaN(fullmove) || fullmove < 1 ? 1 : fullmove };
}

export interface TreeBranchNode {
  readonly node: TreeNodeView;
  readonly turn: 'w' | 'b';
  readonly fullmove: number;
  readonly mainline: TreeBranchNode | null;
  readonly variations: readonly TreeBranchNode[];
}

/**
 * Build a structured hierarchical tree from a flat list of TreeNodeViews and starting FEN.
 * Orders siblings by `orderIndex`. The first child (smallest orderIndex) is mainline;
 * higher siblings open variations.
 */
export function buildMoveTree(
  flatTree: readonly TreeNodeView[],
  startingFen: string,
  variant: Variant = 'standard',
): readonly TreeBranchNode[] {
  if (!flatTree || flatTree.length === 0) return [];

  const byParent = new Map<string | null, TreeNodeView[]>();
  for (const node of flatTree) {
    const list = byParent.get(node.parentId);
    if (list) {
      list.push(node);
    } else {
      byParent.set(node.parentId, [node]);
    }
  }

  for (const [, list] of byParent.entries()) {
    list.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  const { turn: startTurn, fullmove: startFullmove } = parseStartingFen(startingFen, variant);

  function buildBranch(
    parentId: string | null,
    currentTurn: 'w' | 'b',
    currentFullmove: number,
  ): readonly TreeBranchNode[] {
    const siblings = byParent.get(parentId);
    if (!siblings || siblings.length === 0) return [];

    return siblings.map((node) => {
      const nextTurn = currentTurn === 'w' ? 'b' : 'w';
      const nextFullmove = currentTurn === 'b' ? currentFullmove + 1 : currentFullmove;
      const children = buildBranch(node.id, nextTurn, nextFullmove);
      const mainline = children.length > 0 ? children[0]! : null;
      const variations = children.slice(1);
      return {
        node,
        turn: currentTurn,
        fullmove: currentFullmove,
        mainline,
        variations,
      };
    });
  }

  return buildBranch(null, startTurn, startFullmove);
}

/**
 * Computes move number prefix (e.g. "1. ", "3... ", or "") based on turn, fullmove, and inline context.
 */
export function formatMovePrefix(
  turn: 'w' | 'b',
  fullmove: number,
  context: { isStartOfBranch: boolean; afterCommentOrVariation: boolean },
): string {
  if (turn === 'w') {
    return `${fullmove}. `;
  }
  if (context.isStartOfBranch || context.afterCommentOrVariation) {
    return `${fullmove}... `;
  }
  return '';
}
