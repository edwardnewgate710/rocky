# 13. Rate Limiter Port

Date: 2026-07-16

## Status

Accepted

## Context

To protect sensitive authentication endpoints (`/v1/auth/register`, `/v1/auth/login`, and `/v1/auth/refresh`) from credential-stuffing and brute-force attacks, we need a rate limiting mechanism.

However, a production deployment might run multiple instances of the API server behind a load balancer, which necessitates a distributed rate limiter (like Redis). On the other hand, for local development, automated testing, or single-instance deployments, an in-memory rate limiter is much simpler and avoids external dependencies.

## Decision

We have introduced a `RateLimiter` port (`packages/api/src/ports/rate-limiter.ts`) that abstracts the rate limiting implementation from the core route logic.

```typescript
export interface RateLimiter {
  check(key: string, limit: RateLimit): RateLimitResult;
}
```

The API package ships with an `InMemoryRateLimiter` implementation which stores request counts in memory using a fixed-window algorithm. It takes a `Clock` dependency, allowing tests to drive time deterministically without relying on `Date.now()`.

By injecting this port through `ApiDependencies`, we keep the route handlers decoupled from the storage mechanism. A future Postgres or Redis-backed implementation can be trivially swapped in at the deployment composition root without altering the business logic.

## Consequences

- **Pros:**
  - Route handlers remain easily testable using the `InMemoryRateLimiter` and a manual clock.
  - Development requires zero external dependencies.
  - A distributed rate limiter can be seamlessly introduced in the future.
- **Cons:**
  - The `InMemoryRateLimiter` resets upon server restart and does not share state across horizontally scaled instances, making it unsuitable for multi-instance production deployments without sticky sessions.
