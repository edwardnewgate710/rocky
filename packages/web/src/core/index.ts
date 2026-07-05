/**
 * `@chess-platform/web` core — dependency-free presentation logic shared by the
 * board component, clocks and premove handling. UI framework code composes
 * these; nothing here touches the DOM so it stays unit-testable with node:test.
 */
export * from './board.js';
export * from './premove.js';
export * from './clock.js';
export * from './position.js';
export * from './interaction.js';
export * from './mover.js';
export * from '../ports/move-oracle.js';
