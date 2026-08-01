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
| `gateway.replicas` | `2` | Safe horizontal scaling through Redis ownership/command forwarding |
| `api.replicas` | `2` | API is stateless, can scale horizontally |
| `web.replicas` | `2` | Web is stateless, can scale horizontally |
| `postgres.enabled` | `true` | Bundle Postgres as a StatefulSet |
| `redis.enabled` | `true` | Bundle Redis as a StatefulSet |
| `externalDatabaseUrl` | `""` | External Postgres URL (when `postgres.enabled=false`) |
| `externalRedisUrl` | `""` | External Redis URL (when `redis.enabled=false`) |
| `secrets.existingSecret` | `""` | Existing Secret containing the required keys |
| `secrets.accessTokenSecret` | `""` | Required HMAC secret when `existingSecret` is not set |
| `secrets.postgresPassword` | `""` | Required when bundled Postgres is enabled |
| `secrets.externalSecrets.enabled` | `false` | Enable External Secrets Operator integration (ADR-0044) |
| `secrets.externalSecrets.secretStore.name` | `""` | SecretStore / ClusterSecretStore name |
| `secrets.externalSecrets.secretStore.kind` | `SecretStore` | SecretStore or ClusterSecretStore |
| `secrets.externalSecrets.accessTokenSecret.key` | `""` | Backing store key for ACCESS_TOKEN_SECRET |
| `secrets.externalSecrets.postgresPassword.key` | `""` | Backing store key for POSTGRES_PASSWORD |
| `web.ingress.enabled` | `true` | Enable Ingress for the web service |
| `web.ingress.host` | `gambit.local` | Ingress hostname |

### Secrets

**Never commit real secret values.** The chart templates secrets from
`.Values.secrets`. There are no placeholder credentials: Helm rendering fails
closed when the access-token secret is missing or shorter than 32 characters.
Provide secrets via:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.accessTokenSecret="<your-secret>" \
  --set secrets.postgresPassword="<your-password>"
```

Alternatively reference a pre-existing Secret by setting `secrets.existingSecret`, or use the **External Secrets Operator** integration (`secrets.externalSecrets.enabled=true`) to sync directly from a secrets manager (AWS Secrets Manager, GCP Secret Manager, Vault, etc.).

### External secrets (production)

For production environments using the [External Secrets Operator](https://external-secrets.io/):

1. Install the External Secrets Operator in your Kubernetes cluster.
2. Create a `SecretStore` or `ClusterSecretStore` connected to your cloud secrets manager (e.g. AWS Secrets Manager, GCP Secret Manager, Vault).
3. Install the Gambit chart with `secrets.externalSecrets` enabled:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.externalSecrets.enabled=true \
  --set secrets.externalSecrets.secretStore.name="gambit-store" \
  --set secrets.externalSecrets.secretStore.kind="SecretStore" \
  --set secrets.externalSecrets.accessTokenSecret.key="production/gambit/access-token" \
  --set secrets.externalSecrets.postgresPassword.key="production/gambit/postgres-password"
```

When enabled, the chart renders an `ExternalSecret` custom resource (`apiVersion: external-secrets.io/v1`) that ESO reconciles into a Kubernetes Secret named `<fullname>-secret`. The API and Gateway deployments consume this Secret seamlessly. Note that `secrets.externalSecrets` and `secrets.existingSecret` are mutually exclusive.


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

> [!NOTE]
> **Postgres `vector` Extension**: PostgreSQL must provide the `vector` extension (provided by `pgvector/pgvector:pg16` in bundled deployments). Managed Postgres databases used with `postgres.enabled=false` must have `pgvector` installed and available.

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
| API | `GET /v1/health` | `GET /v1/ready` (checks PostgreSQL) |
| Gateway | `GET :4176/health` | `GET :4176/ready` (checks PostgreSQL + Redis) |
| Web | `GET /` | `GET /` |

Kubernetes has no compose-style `depends_on`. Instead, health-gated ordering is
achieved via probes: the API's readiness probe prevents traffic until
migrations complete and the health endpoint responds; the gateway's init
container waits for the API to be Ready.

## Gateway scaling

M14 increment 5 added a Redis ownership registry and command forwarding. One
node owns each game; other nodes forward commands to it, while Redis pub/sub
fans authoritative broadcasts back to every connected client. Consequently
the chart now defaults to two gateway replicas. `REDIS_URL` is required for a
multi-replica deployment; keep one replica only when deliberately running
without Redis.

See `docs/adr/0010-game-authority-ownership.md` for the decision record.

## Search indexer

The live search indexer (ADR-0056) keeps `search_documents` current by consuming
game-ended broadcasts. Its dedup set is process-local, so it runs in a dedicated
single-replica Deployment instead of on the gateway replicas:

```bash
helm upgrade gambit deploy/helm/gambit --set gateway.searchIndexer.enabled=true
```

That Deployment's replica count is fixed at 1 by design and is not exposed as a
value — two indexers would each read and upsert every finished game. The upsert is
idempotent, so the index would still be correct, just built twice.

`--set search.enabled=false` disables search altogether (ADR-0055): the API stops
constructing a search repository and `GET /v1/search` returns 503. Combining that
with an enabled indexer fails at template time.

See `docs/adr/0057-search-indexer-deployment.md` for the decision record.

## Validation

```bash
# Lint the chart
helm lint deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)"

# Render templates (default values)
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)"

# Render templates (external datastores)
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379

# Validate against Kubernetes schemas
helm template deploy/helm/gambit \
  --set secrets.accessTokenSecret="$(openssl rand -base64 48)" \
  --set secrets.postgresPassword="$(openssl rand -base64 24)" \
  | kubeconform -strict -summary

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
