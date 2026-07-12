# ADR-0009: Kubernetes Helm chart

**Date:** 2026-07-12
**Status:** Accepted
**Milestone:** M14 Increment 4

## Context

M14 increments 1–3 delivered a docker-compose local stack, durable
Postgres-backed game authority, and Redis pub/sub fanout. The next step is
packaging the stack for Kubernetes — the standard production deployment target.

The existing stack has five services: Postgres, Redis, API, WebSocket gateway,
and web frontend. The docker-compose wiring is well-understood and serves as
the reference for the Kubernetes manifests.

A critical constraint from increment 3: cross-node BROADCAST fanout works
(Redis), but game-command OWNERSHIP is NOT coordinated across gateway replicas.
Two players in the same game on different gateway replicas will experience
spurious move rejections because the non-owning replica's in-memory authority
goes stale and its optimistic event-store append fails.

## Decision

### 1. Helm chart with bundled vs. external datastores

Package the stack as a Helm chart at `deploy/helm/gambit/`. Postgres and Redis
are bundled as StatefulSets with PVCs, gated behind `postgres.enabled` /
`redis.enabled` values (default `true` for a self-contained install on kind or
a local cluster).

When disabled, `DATABASE_URL` and `REDIS_URL` are taken from
`externalDatabaseUrl` / `externalRedisUrl` values, supporting managed
datastores (e.g., RDS, ElastiCache) without chart modification.

**Rationale:** A self-contained chart that works out-of-the-box on kind is
valuable for development and testing. The gating mechanism allows the same
chart to be used in production with managed datastores, avoiding chart
duplication.

### 2. Migrations as an init container

Run persistence migrations as an init container in the API Deployment, using
the same `npm run migrate --workspace @chess-platform/persistence` command that
the compose API runs. The gateway's init container (`wait-for-api`) waits for
the API's health endpoint before starting.

**Rationale:** Kubernetes has no compose-style `depends_on` with
`condition: service_healthy`. The init container approach ensures the schema
exists before the API serves traffic and before the gateway starts, mirroring
compose's health-gated startup ordering. An alternative (a separate pre-install
Job) was considered but rejected because:
- The API image already contains the migration runner; reusing it in an init
  container avoids duplicating the migration command in a separate Job.
- A pre-install Job runs before any Deployment, but the Job's pod might be
  scheduled on a node that doesn't have the image cached, causing delays.
  An init container runs on the same node as the API pod, so the image is
  already pulled.
- Init containers are simpler to reason about: the API pod will not start
  until migrations complete, period.

### 3. Single gateway replica (replicas: 1)

The gateway Deployment defaults to `replicas: 1` and MUST NOT be scaled beyond
1 without additional work.

**Rationale:** Game-command ownership is not coordinated across gateway
replicas. Scaling beyond 1 requires sticky per-game routing (all connections
for a game routed to one replica) or sharded authority — both are later M14
increments. Setting `replicas > 1` today would cause spurious move rejections
for players whose games span multiple replicas.

The API and web are stateless and default to 2 replicas.

This constraint is documented in:
- `values.yaml` comments (at the top and at `gateway.replicas`)
- This ADR
- `docs/DEPLOYING.md` (dedicated section)

### 4. Config split: ConfigMap + Secret

Non-secret environment variables (PORT, HOST, NODE_ENV, ACCESS_TOKEN_TTL_SEC,
ports) are in a ConfigMap. Sensitive values (ACCESS_TOKEN_SECRET,
POSTGRES_PASSWORD) are in a Secret.

Secrets are templated from `.Values` with placeholder defaults for local dev.
Do NOT commit real secret values — provide via `helm --set` or
external-secrets.

**Full secrets-manager integration (Vault, AWS Secrets Manager) is deferred to
a later M14 increment.** The current chart uses a plain Kubernetes Secret.
When external-secrets is added, the Secret can be managed by an ExternalSecret
resource that syncs from the secrets manager, without changing the chart's
Secret reference structure.

### 5. NODE_ID via the downward API

The gateway's `NODE_ID` environment variable is set from the pod name via the
Kubernetes downward API (`fieldRef: metadata.name`), mirroring compose's
`NODE_ID: gateway-${HOSTNAME}`. This gives each gateway pod a unique,
stable identity for Redis pub/sub self-delivery skip.

### 6. Image references parameterized

Image repository + tag are parameterized in `values.yaml`, reusing the existing
`Dockerfile.api` / `Dockerfile.gateway` / `Dockerfile.web` images. No new
Dockerfiles are needed.

### 7. Probes hitting existing health endpoints

Liveness and readiness probes hit the existing health endpoints:
- API: `GET /v1/health`
- Gateway: `GET :{PORT+1}/health` (port 4176)
- Web: `GET /`

No application source changes were needed — the health endpoints already
existed from M14 increment 1.

## Consequences

- The chart works out-of-the-box on kind with bundled datastores.
- The same chart supports production with managed datastores via value
  overrides.
- The gateway is limited to 1 replica until sticky routing or sharded authority
  is implemented (later M14 increment).
- Secrets management is basic (plain Kubernetes Secret) until external-secrets
  integration is added (later M14 increment).
- No application source changes were required — this is pure
  infrastructure/packaging.
