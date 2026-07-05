/**
 * BoardView — framework-light DOM renderer for the chess board.
 *
 * Renders an 8x8 grid plus an absolutely-positioned piece layer so pieces can
 * be transform-animated between squares (premoves, drag, click-to-move). All
 * geometry comes from the tested `core` module; this file owns only DOM + input.
 *
 * Legality is NOT decided here: the view emits a `move-intent` and the app layer
 * validates it against `@chess-platform/core` before submitting to the server.
 */
import {
  type Color,
  type Square,
  ranksForOrientation,
  filesForOrientation,
  toSquare,
  squareShade,
  pixelToSquare,
} from '../core/board.js';
import { parsePlacement, type Piece } from '../core/position.js';

const GLYPH: Record<string, string> = {
  wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659',
  bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F',
};

export interface MoveIntent {
  readonly from: Square;
  readonly to: Square;
}

export interface BoardViewOptions {
  readonly orientation?: Color;
  readonly onMoveIntent?: (intent: MoveIntent) => void;
}

export class BoardView {
  private readonly root: HTMLElement;
  private orientation: Color;
  private readonly onMoveIntent: (intent: MoveIntent) => void;
  private pieces = new Map<Square, Piece>();
  private selected: Square | null = null;

  constructor(root: HTMLElement, options: BoardViewOptions = {}) {
    this.root = root;
    this.orientation = options.orientation ?? 'white';
    this.onMoveIntent = options.onMoveIntent ?? (() => undefined);
    this.root.classList.add('cb-board');
    this.root.setAttribute('role', 'grid');
    this.root.setAttribute('aria-label', 'Chess board');
    this.root.addEventListener('click', (e) => this.handleClick(e));
    this.render();
  }

  /** Load a position from a FEN (uses only the placement field). */
  setFen(fen: string): void {
    this.pieces = parsePlacement(fen);
    this.render();
  }

  /** Flip the board. */
  flip(): void {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.render();
  }

  private handleClick(event: MouseEvent): void {
    const rect = this.root.getBoundingClientRect();
    const size = rect.width;
    const square = pixelToSquare(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      size,
      this.orientation,
    );
    if (!square) return;
    if (this.selected && this.selected !== square) {
      this.onMoveIntent({ from: this.selected, to: square });
      this.selected = null;
    } else {
      this.selected = this.pieces.has(square) ? square : null;
    }
    this.render();
  }

  private render(): void {
    const ranks = ranksForOrientation(this.orientation);
    const files = filesForOrientation(this.orientation);
    const cells: string[] = [];
    for (const rank of ranks) {
      for (const file of files) {
        const sq = toSquare(file, rank);
        const piece = this.pieces.get(sq);
        const glyph = piece ? (GLYPH[`${piece.color}${piece.role}`] ?? '') : '';
        const sel = sq === this.selected ? ' cb-selected' : '';
        const label = piece ? `${sq} ${piece.color}${piece.role}` : sq;
        cells.push(
          `<div class="cb-sq cb-${squareShade(sq)}${sel}" role="gridcell" ` +
            `data-square="${sq}" aria-label="${label}">` +
            `<span class="cb-piece" aria-hidden="true">${glyph}</span></div>`,
        );
      }
    }
    this.root.innerHTML = cells.join('');
  }
}
