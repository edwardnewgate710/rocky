# Gambit Helm Chart

M14 Increment 4 — Kubernetes manifests + Helm chart.
M14 Increment 6 — External Secrets Operator (external-secrets.io) integration.

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
