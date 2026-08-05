/**
 * Search view renderers — pure DOM helpers that take a container plus search results
 * and write DOM using `el()` and existing styling classes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import type { SearchRow, SearchEntityType } from './search-results.js';

export function formatEntityType(type: SearchEntityType | null): string {
  switch (type) {
    case 'game':
      return 'Game';
    case 'player':
      return 'Player';
    case 'tournament':
      return 'Tournament';
    default:
      return 'Result';
  }
}

export function renderSearchResults(
  container: HTMLElement,
  hits: readonly SearchRow[],
): void {
  container.innerHTML = '';
  if (hits.length === 0) {
    renderEmpty(container, {
      mark: '🔍',
      title: 'No results found',
      body: 'Try adjusting your search query or switching mode.',
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const hit of hits) {
    const nameNode = hit.href
      ? el(doc, 'a', { href: hit.href, class: 'row-link' }, hit.label)
      : el(doc, 'span', {}, hit.label);

    // `.panel-row` is space-between and takes exactly two children. The subtitle belongs to the
    // title, so it travels with it inside `.row-main`; handed to the row as a third child it would
    // fly to the opposite edge, detached from the thing it describes. Same rule as teams, forum
    // threads and achievements — see DESIGN.md.
    const leading = hit.subtitle
      ? el(doc, 'span', { class: 'row-main' }, nameNode, el(doc, 'span', { class: 'count' }, hit.subtitle))
      : el(doc, 'span', { class: 'row-main' }, nameNode);

    const typeSpan = el(doc, 'span', { class: 'count' }, formatEntityType(hit.type));
    container.appendChild(el(doc, 'div', { class: 'panel-row' }, leading, typeSpan));
  }
}

export function renderSearchPrompt(container: HTMLElement): void {
  renderEmpty(container, {
    mark: '🔍',
    title: 'Search Gambit',
    body: 'Search for players, games, or tournaments above.',
  });
}
