# ADR-0007: Local Runnable Stack — Single-Node Gateway with Shared-Secret Token Verification

> **Status:** Accepted  
> **Date:** 2026-07-10  
> **Supersedes:** None  
> **Related:** ADR-0004 (Realtime Auth — TokenVerifier port), ADR-0001 (Persistence Data Modeling)

## Context

M14 Increment 1 delivers a local runnable stack: `docker compose up` brings
the entire platform live with real Postgres, API, WebSocket gateway, and web
frontend. This is the first time the services run together as an integrated
system (not the in-memory e2e-harness).

A key cross-service decision: how does the realtime gateway verify access
tokens issued by the API?

## Decision

### Shared-secret token verification (no API round-trip)

The gateway constructs its own `AccessTokenService` (from `@chess-platform/api`)
using the same `ACCESS_TOKEN_SECRET` environment variable as the API. Tokens
are stateless HMAC-SHA256 (JWS/HS256), so the gateway verifies them locally
without calling the API. This implements the `TokenVerifier` port from
ADR-0004.

**Why not call the API for verification?** The access token is self-contained
(claims + signature). A network round-trip would add latency to every WS join
for no security benefit — the signature is the proof. The API and gateway
share a secret, not a session.

**Why not a separate auth service?** That would add another moving part for
zero benefit at this scale. The shared-secret approach is the simplest correct
implementation of the `TokenVerifier` port.

### In-memory pub/sub (single-node)

The gateway uses `InMemoryPubSub` for fanout. This is correct for a
single-node deployment (one gateway process, one game authority). The `PubSub`
port is already defined; a Redis adapter implements the same interface for
multi-node in a later M14 increment.

### Gateway as a separate service package

The gateway service entry point lives in `services/gateway/` (not in
`packages/realtime-gateway/`) because it depends on `@chess-platform/api`
(for `AccessTokenService`) and `ws` — dependencies the gateway *domain*
package intentionally excludes to stay dependency-free and unit-testable. The
domain package's `transport.ts` documents this seam; the service package
implements it.

### Migration on startup

The API container runs `npm run migrate --workspace @chess-platform/persistence`
before starting the server. The migration runner is idempotent (tracks applied
migrations with checksums in `schema_migrations`), so re-starts are safe.

## Consequences

- The API and gateway MUST share the same `ACCESS_TOKEN_SECRET`. A mismatch
  causes all WS joins to fail with `unauthorized`. This is documented in
  `.env.example` and `docs/RUNNING.md`.
- Token rotation requires restarting both services with the new secret.
- Single-node only: the in-memory pub/sub and game authority do not survive
  a gateway restart (game state is lost). This is acceptable for local
  development. Production multi-node requires Redis pub/sub + a durable
  game authority (later M14 increment).
- The gateway service package adds a build step to the Docker image but does
  not affect the monorepo's npm workspace scripts (it's under `services/`,
  not `packages/`).
