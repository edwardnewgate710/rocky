/**
 * DOM entry for the composition root: build the application graph, mount the
 * interactive board, and return the wired handles. This is the only app-layer
 * module that reads the DOM; it is invoked from `main.ts`. Keeping it separate
 * from {@link createApp} lets the object graph be composed and tested with no
 * DOM present.
 */
import { createApp } from './composition.js';
import type { App } from './composition.js';
import { resolveConfig } from './config.js';
import { mountBoard } from './board.js';
import type { MountedBoard } from './board.js';

/** Everything the bootstrap wired, returned for later increments and tests. */
export interface Bootstrapped {
  readonly app: App;
  /** The mounted board, or `null` when the board element is absent. */
  readonly board: MountedBoard | null;
}

/** Compose the app and mount the board against the given document. */
export function bootstrap(doc: Document): Bootstrapped {
  const app = createApp({ config: resolveConfig() });

  const boardEl = doc.getElementById('board');
  const board = boardEl
    ? mountBoard({
        boardEl,
        statusEl: doc.getElementById('status'),
        flipEl: doc.getElementById('flip'),
      })
    : null;

  return { app, board };
}
