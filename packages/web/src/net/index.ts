/**
 * `@chess-platform/web` networking layer — the transport-facing foundation the
 * typed API client is built on. Framework-independent and unit-tested; the DOM
 * never imports this directly (the app composition root does).
 */
export * from '../ports/http.js';
export * from './errors.js';
export * from './retry.js';
export * from './http-client.js';
export * from './session.js';
