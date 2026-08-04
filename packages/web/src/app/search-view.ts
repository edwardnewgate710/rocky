/**
 * Search view renderers — pure DOM helpers that take a container plus search results
 * and write DOM using `el()` and existing styling classes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import type { HydratedHit, SearchEntityType } from './search-results.js';

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
  hits: readonly HydratedHit[],
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
    const typeSpan = el(doc, 'span', { class: 'count' }, formatEntityType(hit.type));

    let nameNode: HTMLElement;
    if (hit.href) {
      nameNode = el(doc, 'a', { href: hit.href, class: 'tournament-link' }, hit.label);
    } else {
      nameNode = el(doc, 'span', {}, hit.label);
    }

    const row = el(doc, 'div', { class: 'panel-row' }, nameNode, typeSpan);
    container.appendChild(row);
  }
}

export function renderSearchPrompt(container: HTMLElement): void {
  renderEmpty(container, {
    mark: '🔍',
    title: 'Search Gambit',
    body: 'Search for players, games, or tournaments above.',
  });
}
