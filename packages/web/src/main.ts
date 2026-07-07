/**
 * App entry point.
 *
 * All wiring lives in the composition root (`./app`); this module handles only
 * environment concerns: running the bootstrap once the DOM is ready and
 * registering the service worker for PWA installability. It contains no
 * application logic.
 */
import { bootstrap } from './app/index.js';

if (typeof document !== 'undefined') {
  const run = (): void => {
    const result = bootstrap(document);

    // Wire the theme toggle button to the controller.
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => result.theme.toggle());
    }

    // Wire nav links for SPA routing (prevent full page reloads).
    document.querySelectorAll('a[data-route]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = (link as HTMLAnchorElement).getAttribute('href');
        if (href) {
          history.pushState(null, '', href);
          // Re-run bootstrap for the new route.
          bootstrap(document);
        }
      });
    });

    // Handle browser back/forward.
    window.addEventListener('popstate', () => {
      bootstrap(document);
    });
  };

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
