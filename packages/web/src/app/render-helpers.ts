/**
 * Shared DOM rendering and formatting helpers used by bootstrap and views.
 */
import type { TimeControl } from '../net/ws-protocol.js';

/** Format clock milliseconds as `M:SS`. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Format a time control into a human-readable string. */
export function formatTimeControl(tc: Pick<TimeControl, 'kind' | 'initialMs' | 'incrementMs' | 'delayMs'>): string {
  if (tc.kind === 'unlimited') return 'Unlimited';
  if (tc.kind === 'sudden_death') {
    const sec = tc.initialMs / 1000;
    return sec >= 60 && sec % 60 === 0 ? `${sec / 60} min` : `${sec} sec`;
  }
  if (tc.kind === 'increment') {
    return `${tc.initialMs / 60000}+${tc.incrementMs / 1000}`;
  }
  if (tc.kind === 'delay') {
    const sec = tc.initialMs / 1000;
    const base = sec >= 60 && sec % 60 === 0 ? `${sec / 60} min` : `${sec} sec`;
    return `${base} delay ${tc.delayMs / 1000}`;
  }
  return 'Unknown';
}

/** Options for {@link renderEmpty}. */
export interface EmptyStateOptions {
  /** Optional decorative glyph (a chess piece symbol); hidden from a11y. */
  readonly mark?: string;
  readonly title: string;
  readonly body: string;
  /** Optional call-to-action rendered as a SPA nav link. */
  readonly cta?: { readonly label: string; readonly href: string; readonly route: string };
  /** Lighter, left-aligned variant for small sub-sections (no panel). */
  readonly inline?: boolean;
}

/**
 * Render a first-run / no-data empty state into a container, replacing its
 * contents. Empty states name the next action rather than leaving blank space.
 */
export function renderEmpty(container: HTMLElement, opts: EmptyStateOptions): void {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = opts.inline ? 'empty empty-inline' : 'empty';

  if (opts.mark && !opts.inline) {
    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = opts.mark;
    wrap.appendChild(mark);
  }

  const title = document.createElement('p');
  title.className = 'empty-title';
  title.textContent = opts.title;
  wrap.appendChild(title);

  const body = document.createElement('p');
  body.className = 'empty-body';
  body.textContent = opts.body;
  wrap.appendChild(body);

  if (opts.cta) {
    const link = document.createElement('a');
    link.className = 'empty-cta';
    link.href = opts.cta.href;
    link.dataset.route = opts.cta.route;
    link.textContent = opts.cta.label;
    wrap.appendChild(link);
  }

  container.appendChild(wrap);
}
