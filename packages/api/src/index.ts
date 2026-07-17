/**
 * @packageDocumentation
 * `@chess-platform/api` — the stateless REST + identity service. The root entry
 * is driver-free: it exposes {@link createApiServer}, the HTTP/router primitives,
 * the auth building blocks (password hashing, HMAC access tokens, refresh
 * rotation), the injectable ports, presenters, the OpenAPI generator, and the
 * in-memory fakes. Postgres wiring lives behind the `@chess-platform/api/pg`
 * subpath so consumers that only need the interfaces never pull in `pg`.
 */

export * from './config';
export * from './deps';
export * from './server';
export * from './routes';
export * from './domain';
export * from './presenters';
export * from './tournament/launcher';
export * from './tournament/service';
export * from './tournament/live-view';

export * from './auth/password';
export * from './auth/tokens';
export * from './auth/refresh';
export * from './auth/service';

export * from './ports/clock';
export * from './ports/ids';
export * from './ports/audit';
export * from './ports/rate-limiter';
export * from './ports/in-memory-rate-limiter';

export * from './http/errors';
export * from './http/context';
export * from './http/router';
export * from './http/validate';
export * from './http/cookie';

export * from './openapi/types';
export * from './openapi/spec';
export * from './openapi/schemas';

export * from './fakes';
