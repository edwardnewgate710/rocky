# Deploying Gambit to Kubernetes

> M14 Increment 4 — Helm chart for Kubernetes deployment.

This guide covers deploying the Gambit platform to a Kubernetes cluster using
the bundled Helm chart at `deploy/helm/gambit/`. It is the next step after the
docker-compose local stack (M14 increment 1) and mirrors the same service
topology: Postgres, Redis, API, WebSocket gateway, and web frontend.

## Prerequisites

- A Kubernetes cluster (e.g., [kind](https://kind.sigs.k8s.io/), minikube, or a
  cloud provider)
- [Helm](https://helm.sh/) 3.x
- Container images built and pushed to a registry (see [Building images](#building-images))

## Quick start (kind / local cluster)

```bash
# 1. Build and push images to your registry (or load into kind)
docker build -f Dockerfile.api     -t ghcr.io/hessiun710/gambit-api:latest .
docker build -f Dockerfile.gateway -t ghcr.io/hessiun710/gambit-gateway:latest .
docker build -f Dockerfile.web     -t ghcr.io/hessiun710/gambit-web:latest .

# For kind, load images directly:
kind load docker-image ghcr.io/hessiun710/gambit-api:latest
kind load docker-image ghcr.io/hessiun710/gambit-gateway:latest
kind load docker-image ghcr.io/hessiun710/gambit-web:latest

# 2. Install the chart
helm install gambit deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)"

# 3. Check that everything is running
kubectl get pods

# 4. Port-forward the web service to access the UI
kubectl port-forward svc/gambit-web 3000:8080
# Open http://localhost:3000
```

## Building images

The chart references images via `values.yaml`:

| Service | Image | Dockerfile |
|---|---|---|
| API | `images.api.repository` | `Dockerfile.api` |
| Gateway | `images.gateway.repository` | `Dockerfile.gateway` |
| Web | `images.web.repository` | `Dockerfile.web` |

Override the repository and tag:

```bash
helm install gambit deploy/helm/gambit \
  --set images.api.repository=my-registry/gambit-api \
  --set images.api.tag=v1.0.0 \
  --set images.gateway.repository=my-registry/gambit-gateway \
  --set images.gateway.tag=v1.0.0 \
  --set images.web.repository=my-registry/gambit-web \
  --set images.web.tag=v1.0.0
```

## Configuration

### Key values

| Value | Default | Description |
|---|---|---|
| `gateway.replicas` | `1` | **MUST be 1** — see [Gateway replica constraint](#gateway-replica-constraint) |
| `api.replicas` | `2` | API is stateless, can scale horizontally |
| `web.replicas` | `2` | Web is stateless, can scale horizontally |
| `postgres.enabled` | `true` | Bundle Postgres as a StatefulSet |
| `redis.enabled` | `true` | Bundle Redis as a StatefulSet |
| `externalDatabaseUrl` | `""` | External Postgres URL (when `postgres.enabled=false`) |
| `externalRedisUrl` | `""` | External Redis URL (when `redis.enabled=false`) |
| `secrets.accessTokenSecret` | `""` | HMAC secret (placeholder default; override in production) |
| `secrets.postgresPassword` | `""` | Postgres password (placeholder default; override in production) |
| `web.ingress.enabled` | `true` | Enable Ingress for the web service |
| `web.ingress.host` | `gambit.local` | Ingress hostname |

### Secrets

**Never commit real secret values.** The chart templates secrets from
`.Values.secrets` with placeholder defaults for local dev/kind. In production,
provide secrets via:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.accessTokenSecret="<your-secret>" \
  --set secrets.postgresPassword="<your-password>"
```

Full secrets-manager integration (Vault, AWS Secrets Manager, external-secrets)
is a **later M14 increment** — not included here. The current chart uses a
plain Kubernetes Secret. When external-secrets is added, the Secret can be
managed by an ExternalSecret resource that syncs from the secrets manager.

### External datastores

For production, use managed Postgres and Redis:

```bash
helm install gambit deploy/helm/gambit \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl="postgres://user:pass@db.example.com:5432/gambit" \
  --set externalRedisUrl="redis://redis.example.com:6379" \
  --set secrets.accessTokenSecret="<your-secret>"
```

When `postgres.enabled=false`, the chart does not create the Postgres
StatefulSet/Service/PVC, and `DATABASE_URL` is set from `externalDatabaseUrl`.
The `POSTGRES_PASSWORD` key is omitted from the Secret (it is only needed for
the bundled Postgres). The same applies to Redis.

### Migrations

Database migrations run as an **init container** in the API Deployment, using
the same `npm run migrate --workspace @chess-platform/persistence` command that
the compose API runs. The migration init container runs before the API
container starts, ensuring the schema exists before the API serves traffic.

The gateway's init container (`wait-for-api`) waits for the API's health
endpoint to respond, which ensures the schema exists before the gateway starts
— mirroring compose's `depends_on: api: condition: service_healthy`.

### Health probes

| Service | Liveness | Readiness |
|---|---|---|
| API | `GET /v1/health` | `GET /v1/health` |
| Gateway | `GET :4176/health` | `GET :4176/health` |
| Web | `GET /` | `GET /` |

Kubernetes has no compose-style `depends_on`. Instead, health-gated ordering is
achieved via probes: the API's readiness probe prevents traffic until
migrations complete and the health endpoint responds; the gateway's init
container waits for the API to be Ready.

## Gateway replica constraint

> **CRITICAL: The gateway Deployment defaults to `replicas: 1` and MUST NOT be
> scaled beyond 1 without additional work.**

After M14 increment 3, cross-node BROADCAST fanout works (Redis pub/sub), but
game-command **OWNERSHIP** is NOT coordinated across gateway replicas. If two
players in the same game land on different gateway replicas, the non-owning
replica's in-memory authority goes stale and its optimistic event-store append
fails, so that player's moves are spuriously rejected.

Scaling the gateway beyond 1 replica requires one of:
- **Sticky per-game routing**: all WebSocket connections for a given game are
  routed to the same gateway replica (e.g., via a consistent-hash
  load balancer keyed by game ID).
- **Sharded authority**: game authority is sharded across replicas with a
  coordination protocol (e.g., a distributed lock or a routing layer that
  forwards commands to the owning replica).

Both are **later M14 increments**. Until then, `gateway.replicas` MUST be 1.

The API and web are stateless and MAY default to 2 replicas.

See `docs/adr/0009-kubernetes-helm.md` for the full decision record.

## Validation

```bash
# Lint the chart
helm lint deploy/helm/gambit

# Render templates (default values)
helm template deploy/helm/gambit

# Render templates (external datastores)
helm template deploy/helm/gambit \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379

# Validate against Kubernetes schemas
helm template deploy/helm/gambit | kubeconform -strict -summary

# Run the snapshot test (verifies key wiring)
PATH=/usr/local/bin:$PATH bash scripts/helm-snapshot-test.sh
```

## Uninstalling

```bash
helm uninstall gambit
```

This removes all resources created by the chart. PVCs for Postgres and Redis
are retained by default (StatefulSet PVCs are not automatically deleted). To
delete them:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=gambit
```
