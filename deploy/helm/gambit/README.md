# Gambit Helm Chart

M14 Increment 4 — Kubernetes manifests + Helm chart.
M14 Increment 6 — External Secrets Operator (external-secrets.io) integration.
M14 Increment 7 — Dedicated single-replica Deployment for the live search indexer.

See `docs/DEPLOYING.md` for the full install guide.

## External secrets

To use [External Secrets Operator](https://external-secrets.io/) with an existing `SecretStore` or `ClusterSecretStore`:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.externalSecrets.enabled=true \
  --set secrets.externalSecrets.secretStore.name=gambit-store \
  --set secrets.externalSecrets.secretStore.kind=SecretStore \
  --set secrets.externalSecrets.accessTokenSecret.key=gambit/access-token \
  --set secrets.externalSecrets.postgresPassword.key=gambit/postgres-password
```

## Search indexer

The live search indexer (ADR-0056) dedups in-process, so it must run as exactly one
process per release. It therefore gets its own single-replica Deployment rather than
riding the `gateway.replicas` pods:

```bash
helm upgrade gambit deploy/helm/gambit --set gateway.searchIndexer.enabled=true
```

`replicas` for that Deployment is intentionally not configurable. Scale the gateway, not
the indexer.

To disable search entirely (the ADR-0055 kill switch — the API stops constructing a search
repository and `GET /v1/search` returns 503):

```bash
helm upgrade gambit deploy/helm/gambit --set search.enabled=false
```

Enabling the indexer while search is disabled fails at template time.
