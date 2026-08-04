/**
 * App entry point.
 *
 * All wiring lives in the composition root (`./app`); this module handles only
 * environment concerns: running the bootstrap when the DOM is ready and on
 * navigation, and registering the service worker for PWA installability. It
 * contains no application logic.
 */
import { bootstrap } from './app/index.js';
import { buildSearchUrl, parseSearchMode } from './app/search-results.js';

/** The disposal surface `run()` needs; every controller it tears down exposes exactly this. */
type Disposable = { dispose: () => void } | null;

if (typeof document !== 'undefined') {
  // The theme controller is recreated on every bootstrap; keep the latest so
  // the (document-level, bound-once) theme click handler always targets it.
  let currentTheme: { toggle: () => void } | null = null;

  // Controllers from the previous route. `run()` re-bootstraps in place, and the ones that own a
  // timer or in-flight requests keep working against sections the new route has already hidden —
  // the lobby's seek refresh, the profile's fetches, and the tournament live poll all outlive the
  // page that started them and accumulate one more copy per navigation. Disposing the previous set
  // first is what makes re-bootstrapping safe.
  let previous: { lobby: Disposable; profile: Disposable; tournament: Disposable; search: Disposable; messages: Disposable } | null = null;

  const run = (): void => {
    previous?.lobby?.dispose();
    previous?.profile?.dispose();
    previous?.tournament?.dispose();
    previous?.search?.dispose();
    previous?.messages?.dispose();
    const result = bootstrap(document);
    currentTheme = result.theme;
    previous = { lobby: result.lobby, profile: result.profile, tournament: result.tournament, search: result.search, messages: result.messages };
  };

  // Bound once on document — survives bootstrap re-runs (which replace the
  // section contents but not these top-level listeners).

  // Theme toggle.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && target.closest('#theme-toggle')) {
      currentTheme?.toggle();
    }
  });

  // SPA nav links (prevent full page reloads, re-run bootstrap for new route).
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const link = target.closest('a[data-route]');
    if (!(link instanceof HTMLAnchorElement)) return;
    // Let the browser handle modified clicks (open in new tab/window),
    // links targeting another browsing context, and downloads normally.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.target && link.target !== '_self') return;
    if (link.hasAttribute('download')) return;
    e.preventDefault();
    const href = link.getAttribute('href');
    if (href) {
      history.pushState(null, '', href);
      run();
    }
  });

  // Header search. Bound once on document like the handlers above: the form sits in the nav, which
  // `bootstrap` never replaces, so binding it per run would stack one listener per navigation and a
  // single submit would push that many history entries.
  document.addEventListener('submit', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.id !== 'search-form') return;
    e.preventDefault();
    const input = document.getElementById('search-input') as HTMLInputElement | null;
    const mode = parseSearchMode(new URLSearchParams(location.search).get('mode'));
    history.pushState(null, '', buildSearchUrl(input?.value.trim() ?? '', mode));
    run();
  });

  // Browser back/forward.
  window.addEventListener('popstate', () => {
    run();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  // Register the service worker for PWA installability.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Log registration failures so SW breakage is visible (m1).
        console.warn('[Gambit] Service worker registration failed:', err);
      });
    });
  }
}
