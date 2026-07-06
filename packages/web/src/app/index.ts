/**
 * `@chess-platform/web` application layer — the composition root that wires the
 * networking, API and UI seams together. This is the one place that depends on
 * every layer at once; everything else stays decoupled behind its ports.
 */
export * from './config.js';
export * from './composition.js';
export * from './board.js';
export * from './bootstrap.js';
export * from './game-controller.js';
