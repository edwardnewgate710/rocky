import type { GambitClient } from '../api/client.js';
import type { SearchMode } from '../api/models.js';
import { SearchController } from './search-controller.js';
import type { SearchCallbacks } from './search-controller.js';
import { buildSearchUrl, parseSearchMode } from './search-results.js';
import { renderSearchPrompt, renderSearchResults } from './search-view.js';

interface SearchElements {
  readonly mode: HTMLElement | null;
  readonly input: HTMLInputElement | null;
  readonly results: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface SearchRenderState {
  resultsRendered: boolean;
}

interface SearchRequest {
  readonly rawQuery: string;
  readonly query: string;
  readonly mode: SearchMode;
}

interface SearchModeOption {
  readonly value: SearchMode;
  readonly label: string;
}

const SEARCH_MODES: readonly SearchModeOption[] = [
  { value: 'keyword', label: 'Keyword' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'hybrid', label: 'Hybrid' },
];

function searchElements(doc: Document): SearchElements {
  return {
    mode: doc.getElementById('search-mode'),
    input: doc.getElementById('search-input') as HTMLInputElement | null,
    results: doc.getElementById('search-results'),
    error: doc.getElementById('search-error'),
  };
}

function currentSearchRequest(): SearchRequest {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const rawQuery = params.get('q') ?? '';
  return {
    rawQuery,
    query: rawQuery.trim(),
    mode: parseSearchMode(params.get('mode')),
  };
}

function navigateToSearchMode(query: string, mode: SearchMode): void {
  history.pushState(null, '', buildSearchUrl(query, mode));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function createModeInput(
  doc: Document,
  option: SearchModeOption,
  activeMode: SearchMode,
  query: string,
): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'radio';
  input.name = 'search-mode-option';
  input.value = option.value;
  input.checked = option.value === activeMode;
  input.addEventListener('change', () => {
    if (input.checked) navigateToSearchMode(query, option.value);
  });
  return input;
}

function createModeControl(
  doc: Document,
  option: SearchModeOption,
  activeMode: SearchMode,
  query: string,
): HTMLLabelElement {
  const control = doc.createElement('label');
  control.className = 'cg-seg';
  const label = doc.createElement('span');
  label.className = 'cg-seg-label';
  label.textContent = option.label;
  control.append(createModeInput(doc, option, activeMode, query), label);
  return control;
}

function renderModeSelector(
  doc: Document,
  container: HTMLElement,
  activeMode: SearchMode,
  query: string,
): void {
  container.innerHTML = '';
  for (const option of SEARCH_MODES) {
    container.appendChild(createModeControl(doc, option, activeMode, query));
  }
}

function resetSearchSurface(elements: SearchElements): void {
  // Search route elements persist across bootstrap runs, including interrupted loading states.
  if (elements.results) elements.results.setAttribute('aria-busy', 'false');
  if (elements.error) elements.error.textContent = '';
}

function setSearchLoading(
  elements: SearchElements,
  state: SearchRenderState,
  loading: boolean,
): void {
  if (!elements.results) return;
  elements.results.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (loading) {
    state.resultsRendered = false;
    return;
  }
  if (!state.resultsRendered) elements.results.innerHTML = '';
}

function createSearchCallbacks(elements: SearchElements): SearchCallbacks {
  const state: SearchRenderState = { resultsRendered: false };
  return {
    onResults: (hits) => {
      state.resultsRendered = true;
      if (elements.error) elements.error.textContent = '';
      if (elements.results) renderSearchResults(elements.results, hits);
    },
    onLoading: (loading) => setSearchLoading(elements, state, loading),
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
  };
}

export function mountSearch(doc: Document, client: GambitClient): SearchController {
  const elements = searchElements(doc);
  const request = currentSearchRequest();
  resetSearchSurface(elements);

  // The persistent header form is bound once in main.ts; route mounts only refresh its value.
  if (elements.input) elements.input.value = request.rawQuery;
  if (elements.mode) renderModeSelector(doc, elements.mode, request.mode, request.query);

  const controller = new SearchController({
    client,
    callbacks: createSearchCallbacks(elements),
  });
  if (request.query) void controller.search(request.query, request.mode);
  else if (elements.results) renderSearchPrompt(elements.results);
  return controller;
}
