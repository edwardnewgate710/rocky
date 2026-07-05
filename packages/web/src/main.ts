/**
 * App entry point.
 *
 * All wiring lives in the composition root (`./app`); this module handles only
 * environment concerns: running the bootstrap once the DOM is ready and
 * registering the service worker. It contains no application logic.
 */
import { bootstrap } from './app/index.js';

if (typeof document !== 'undefined') {
  const run = (): void => {
    bootstrap(document);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
}
