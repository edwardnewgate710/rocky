/**
 * App entry point.
 *
 * All wiring lives in the composition root (`./app`); this module handles only
 * environment concerns: running the bootstrap when the DOM is ready and on
 * navigation, and registering the service worker for PWA installability. It
 * contains no application logic.
 */
import { bootstrap } from './app/index.js';

if (typeof document !== 'undefined') {
  // The theme controller is recreated on every bootstrap; keep the latest so
  // the (document-level, bound-once) theme click handler always targets it.
  let currentTheme: { toggle: () => void } | null = null;

  const run = (): void => {
    const result = bootstrap(document);
    currentTheme = result.theme;
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
