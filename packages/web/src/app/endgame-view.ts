/**
 * Rendering for the endgame trainer (M15 inc 20, ADR-0128).
 *
 * Two things this file must never do. It must not show the learner the solution before they have
 * attempted the position — `/next` does not send one, and nothing here may derive one. And it must
 * not render a decided game as an evaluation: a move that ends the game arrives as the `terminal`
 * branch, which has a result and no score (ADR-0116).
 */
import type {
  EndgameAttemptResult,
  EndgamePosition,
} from '../api/models.js';
import { mountBoard } from './board.js';

export const ENDGAME_MESSAGES = {
  idle: 'Pick a training endgame to begin.',
  loading: 'Loading a training position…',
  judging: 'Checking your move…',
  signedOut: 'Sign in to train endgames.',
  unavailable: 'Endgame training is unavailable right now.',
  rateLimited: 'Too many attempts. Try again shortly.',
  rejected: 'That move cannot be played in this position.',
  failed: 'Could not load the endgame trainer.',
  noMatch: 'No training position matches those filters.',
  yourMove: 'Play the move you think is best.',
} as const;

/** Objective wording the learner reads, kept out of the render functions so it stays consistent. */
const OBJECTIVE_LABEL: Record<EndgamePosition['objective'], string> = {
  mate: 'Deliver checkmate',
  win: 'Win the position',
  draw: 'Hold the draw',
};

const CLASSIFICATION_LABEL: Record<EndgameAttemptResult['classification'], string> = {
  optimal: 'Best move',
  acceptable: 'Playable, but not best',
  throws_result: 'Throws the result away',
};

/**
 * Render the training position: the board, the objective, and nothing else.
 *
 * No solution, no evaluation, no "mate in N" — the server sends none of it, and inventing any of it
 * here would defeat the exercise (ADR-0095).
 *
 * @param doc - the owning document.
 * @param boardEl - the element the read-only board mounts into.
 * @param rows - the container for the position's descriptive rows.
 * @param position - what the server selected.
 * @returns the mounted board, so the caller can tear it down before mounting the next one.
 */
export function renderEndgamePosition(
  doc: Document,
  boardEl: HTMLElement,
  rows: HTMLElement,
  position: EndgamePosition,
): { dispose: () => void } {
  const board = mountBoard({ boardEl });
  board.setTurn(false);
  board.setPosition(position.fen);

  rows.innerHTML = '';
  rows.appendChild(row(doc, 'Endgame', position.name));
  rows.appendChild(row(doc, 'Objective', OBJECTIVE_LABEL[position.objective]));
  rows.appendChild(row(doc, 'To move', position.sideToMove === 'w' ? 'White' : 'Black'));
  rows.appendChild(row(doc, 'Level', position.difficulty));
  if (position.technique) rows.appendChild(row(doc, 'Technique', position.technique));
  return board;
}

/**
 * Render the verdict on an attempted move.
 *
 * @returns the note to display beside the rows, or `null` when the rows say it all.
 */
export function renderEndgameVerdict(
  doc: Document,
  rows: HTMLElement,
  resultEl: HTMLElement,
  result: EndgameAttemptResult,
): string | null {
  rows.innerHTML = '';
  rows.appendChild(row(doc, 'Your move', result.move));
  rows.appendChild(row(doc, 'Verdict', CLASSIFICATION_LABEL[result.classification]));
  rows.appendChild(row(doc, 'Goal', result.goalPreserved ? 'Still alive' : 'Lost'));

  if (result.kind === 'terminal') {
    // A decided game has a result, not a score. Rendering an evaluation here — even a zero — would
    // describe a finished position as an equal one.
    rows.appendChild(row(doc, 'Game', terminalLabel(result.terminal.reason, result.terminal.result)));
    resultEl.hidden = false;
    return null;
  }

  rows.appendChild(row(doc, 'Before', evaluationLabel(result.evalBefore)));
  rows.appendChild(row(doc, 'After', evaluationLabel(result.evalAfter)));
  rows.appendChild(row(doc, 'Cost', lossLabel(result)));
  if (result.betterMove !== null) rows.appendChild(row(doc, 'Engine prefers', result.betterMove));
  if (result.bestLine.length > 0) rows.appendChild(row(doc, 'Line', result.bestLine.join(' ')));
  rows.appendChild(row(doc, 'Depth', String(result.depth)));
  resultEl.hidden = false;
  return null;
}

/**
 * Empty the verdict back to its unanswered state.
 *
 * @param rows - the verdict rows to clear.
 * @param resultEl - the result group to hide and mark not-busy.
 */
export function clearEndgame(rows: HTMLElement, resultEl: HTMLElement): void {
  rows.innerHTML = '';
  resultEl.hidden = true;
  resultEl.setAttribute('aria-busy', 'false');
}

/**
 * @param resultEl - the result group.
 * @param busy - whether work is in flight. Announced through `aria-busy` so a screen reader knows
 * the region is about to change rather than reading the previous verdict as current.
 */
export function setEndgameBusy(resultEl: HTMLElement, busy: boolean): void {
  resultEl.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * @param el - the note element, a polite live region.
 * @param text - the note, or `null` to hide it. Hidden rather than blanked so an empty line does
 * not sit in the layout.
 */
export function renderEndgameNote(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/**
 * @param el - the error element, an assertive live region.
 * @param text - the message, or `null` to clear it.
 */
export function renderEndgameError(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? '';
  el.hidden = text === null;
}

/** `{kind:'decisive'}` has no number to show, and must not be given one. */
function lossLabel(result: Extract<EndgameAttemptResult, { kind: 'judged' }>): string {
  if (result.loss.kind === 'decisive') return 'Decisive — the goal is gone';
  const pawns = result.loss.value / 100;
  return pawns === 0 ? 'Nothing' : `${pawns.toFixed(2)} pawns`;
}

/**
 * @param evaluation - an engine evaluation from the mover's perspective.
 * @returns it in the reader's terms — a mate distance, or pawns to two places. A mate is never
 * rendered as a number of pawns, because it is not one.
 */
function evaluationLabel(evaluation: { readonly type: 'cp' | 'mate'; readonly value: number }): string {
  if (evaluation.type === 'mate') {
    return evaluation.value >= 0 ? `Mate in ${evaluation.value}` : `Mated in ${Math.abs(evaluation.value)}`;
  }
  const pawns = evaluation.value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/**
 * @param reason - why the game ended, in the server's vocabulary.
 * @param result - the score.
 * @returns the pair as one readable phrase.
 */
function terminalLabel(reason: string, result: string): string {
  return `${reason.replaceAll('_', ' ')} · ${result}`;
}

/**
 * One label/value row in the shared panel language.
 *
 * @param doc - the owning document, a parameter so this works under the test double.
 * @param labelText - the left column.
 * @param valueText - the right column, set as text so nothing from the server can be markup.
 * @returns the row, unattached.
 */
function row(doc: Document, labelText: string, valueText: string): HTMLElement {
  const item = doc.createElement('div');
  item.className = 'panel-row';
  const label = doc.createElement('span');
  label.className = 'endgame-label';
  label.textContent = labelText;
  const value = doc.createElement('span');
  value.className = 'endgame-value';
  value.textContent = valueText;
  item.appendChild(label);
  item.appendChild(value);
  return item;
}
