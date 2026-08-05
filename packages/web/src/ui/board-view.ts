/**
 * BoardView — DOM rendering + pointer input for the chess board.
 *
 * All decisions (selection, legality-driven highlights, promotion, premoves)
 * live in the injected {@link BoardInteraction}; this class only turns state into
 * pixels and turns pointer/click gestures into interaction calls. It emits
 * resolved moves/premoves via `onResult` so the app can submit them to the
 * server (authoritative) and optimistically update the position.
 */
import {
  type Color,
  type Square,
  ranksForOrientation,
  filesForOrientation,
  toSquare,
  squareShade,
  rankIndex,
  pixelToSquare,
} from '../core/board.js';
import { parsePlacement, type Piece } from '../core/position.js';
import type { BoardInteraction, GestureResult, PromotionRole } from '../core/interaction.js';
import type { Premove } from '../core/premove.js';

const PROMO_ROLES: readonly PromotionRole[] = ['q', 'r', 'b', 'n'];

/**
 * CSS class carrying a piece's image, e.g. `cb-p-wk`. The artwork itself (the
 * Cburnett SVG set) is bound to these classes in `style.css`; the renderer only
 * names the piece, keeping image paths out of the DOM layer.
 */
function pieceClass(color: string, role: string): string {
  return `cb-p-${color}${role}`;
}
const DRAG_THRESHOLD = 6;

export type ResolvedMove =
  | { readonly kind: 'move'; readonly move: Premove }
  | { readonly kind: 'premove'; readonly premove: Premove };

export interface BoardViewOptions {
  readonly interaction: BoardInteraction;
  readonly orientation?: Color;
  readonly onResult?: (result: ResolvedMove) => void;
}

export class BoardView {
  private readonly root: HTMLElement;
  private readonly interaction: BoardInteraction;
  private readonly onResult: (result: ResolvedMove) => void;
  private orientation: Color;
  private pieces = new Map<Square, Piece>();

  private dragFrom: Square | null = null;
  private dragging = false;
  private startX = 0;
  private startY = 0;
  private pointerId: number | null = null;
  private floatEl: HTMLElement | null = null;
  private suppressClick = false;
  private overlay: HTMLElement | null = null;
  // Held as fields so `destroy` can remove the very same references `addEventListener` received.
  private readonly onClick = (e: MouseEvent): void => this.handleClick(e);
  private readonly onPointerDown = (e: PointerEvent): void => this.handlePointerDown(e);

  constructor(root: HTMLElement, options: BoardViewOptions) {
    this.root = root;
    this.interaction = options.interaction;
    this.orientation = options.orientation ?? 'white';
    this.onResult = options.onResult ?? (() => undefined);
    this.root.classList.add('cb-board');
    this.root.setAttribute('role', 'grid');
    this.root.setAttribute('aria-label', 'Chess board');
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.render();
  }

  /**
   * Detach from the root element.
   *
   * Mounting is not idempotent: the two listeners above are bound to the element, not to this
   * instance, so mounting a second view onto the same element leaves the first one's listeners
   * attached and every gesture is handled twice. Sections whose board element outlives the view —
   * anything rendered into markup that `bootstrap` re-runs over — must call this before remounting.
   */
  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('pointerdown', this.onPointerDown);
  }

  /** Set the position: updates both the rendered pieces and the interaction. */
  setPosition(fen: string): void {
    this.pieces = parsePlacement(fen);
    this.interaction.setPosition(fen);
    this.render();
  }

  setLastMove(from: Square, to: Square): void {
    this.interaction.setLastMove(from, to);
    this.render();
  }

  setTurn(myTurn: boolean): void {
    this.interaction.setTurn(myTurn);
  }

  flip(): void {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.render();
  }

  get orientationColor(): Color {
    return this.orientation;
  }

  // ---- input ---------------------------------------------------------------

  private squareAt(clientX: number, clientY: number): Square | null {
    const rect = this.root.getBoundingClientRect();
    return pixelToSquare(
      { x: clientX - rect.left, y: clientY - rect.top },
      rect.width,
      this.orientation,
    );
  }

  private handleClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.overlay) return;
    const sq = this.squareAt(event.clientX, event.clientY);
    if (!sq) return;
    this.dispatch(this.interaction.tap(sq));
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.overlay) return;
    const sq = this.squareAt(event.clientX, event.clientY);
    if (!sq) return;
    this.dragFrom = sq;
    this.dragging = false;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.pointerId = event.pointerId;
    const move = (e: PointerEvent): void => this.handlePointerMove(e);
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.handlePointerUp(e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.dragFrom === null || event.pointerId !== this.pointerId) return;
    if (!this.dragging) {
      const dist = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);
      if (dist < DRAG_THRESHOLD) return;
      const res = this.interaction.dragStart(this.dragFrom);
      if (res.kind === 'none') {
        this.dragFrom = null;
        return;
      }
      this.dragging = true;
      this.beginFloat(this.dragFrom);
      this.render();
    }
    this.moveFloat(event.clientX, event.clientY);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging || this.dragFrom === null) {
      this.dragFrom = null;
      return;
    }
    const target = this.squareAt(event.clientX, event.clientY);
    const from = this.dragFrom;
    this.endFloat();
    this.dragging = false;
    this.dragFrom = null;
    this.suppressClick = true;
    if (target) {
      this.dispatch(this.interaction.drop(from, target));
    } else {
      this.interaction.cancelPromotion();
      this.render();
    }
  }

  // ---- gesture results -----------------------------------------------------

  private dispatch(result: GestureResult): void {
    switch (result.kind) {
      case 'move':
        this.onResult({ kind: 'move', move: result.move });
        this.render();
        break;
      case 'premove':
        this.onResult({ kind: 'premove', premove: result.premove });
        this.render();
        break;
      case 'promotion':
        this.showPromotion(result.to);
        break;
      default:
        this.render();
    }
  }

  // ---- floating drag piece -------------------------------------------------

  private beginFloat(sq: Square): void {
    const p = this.pieces.get(sq);
    if (!p) return;
    const el = document.createElement('div');
    el.className = `cb-float ${pieceClass(p.color, p.role)}`;
    const cell = this.root.getBoundingClientRect().width / 8;
    el.style.width = `${cell}px`;
    el.style.height = `${cell}px`;
    document.body.appendChild(el);
    this.floatEl = el;
  }

  private moveFloat(x: number, y: number): void {
    if (!this.floatEl) return;
    const half = this.floatEl.offsetWidth / 2;
    this.floatEl.style.left = `${x - half}px`;
    this.floatEl.style.top = `${y - half}px`;
  }

  private endFloat(): void {
    this.floatEl?.remove();
    this.floatEl = null;
  }

  // ---- promotion overlay ---------------------------------------------------

  private showPromotion(to: Square): void {
    this.closeOverlay();
    const color: Piece['color'] = rankIndex(to) === 7 ? 'w' : 'b';
    const overlay = document.createElement('div');
    overlay.className = 'cb-promotion';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Choose promotion piece');
    for (const role of PROMO_ROLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cb-promo-choice ${pieceClass(color, role)}`;
      btn.setAttribute('aria-label', `Promote to ${role}`);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeOverlay();
        this.dispatch(this.interaction.resolvePromotion(role));
      });
      overlay.appendChild(btn);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cb-promo-cancel';
    cancel.textContent = '\u2715';
    cancel.setAttribute('aria-label', 'Cancel promotion');
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      this.interaction.cancelPromotion();
      this.closeOverlay();
      this.render();
    });
    overlay.appendChild(cancel);
    this.root.appendChild(overlay);
    this.overlay = overlay;
    const first = overlay.querySelector('button');
    if (first instanceof HTMLElement) first.focus();
  }

  private closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  // ---- rendering -----------------------------------------------------------

  private render(): void {
    const hl = this.interaction.highlights();
    const legal = new Set(hl.legal);
    const premove = new Set(hl.premove);
    const last = new Set<Square>(hl.lastMove ?? []);
    const ranks = ranksForOrientation(this.orientation);
    const files = filesForOrientation(this.orientation);

    const cells: string[] = [];
    for (const rank of ranks) {
      for (const file of files) {
        const sq = toSquare(file, rank);
        const piece = this.pieces.get(sq);
        const classes = ['cb-sq', `cb-${squareShade(sq)}`];
        if (sq === hl.selected) classes.push('cb-selected');
        if (last.has(sq)) classes.push('cb-last');
        if (premove.has(sq)) classes.push('cb-premove');
        if (legal.has(sq)) classes.push(piece ? 'cb-capture' : 'cb-legal');
        const label = piece ? `${sq} ${piece.color}${piece.role}` : sq;
        const dragged = this.dragging && sq === this.dragFrom ? ' cb-dragging' : '';
        const inner = piece
          ? `<span class="cb-piece ${pieceClass(piece.color, piece.role)}${dragged}" aria-hidden="true"></span>`
          : '';
        cells.push(
          `<div class="${classes.join(' ')}" role="gridcell" data-square="${sq}" aria-label="${label}">${inner}</div>`,
        );
      }
    }
    // Preserve the overlay across re-renders.
    this.root.innerHTML = cells.join('');
    if (this.overlay) this.root.appendChild(this.overlay);
  }
}
