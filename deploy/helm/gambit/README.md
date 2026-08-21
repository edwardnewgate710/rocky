# Gambit Helm Chart

M14 Increment 4 — Kubernetes manifests + Helm chart.
M14 Increment 6 — External Secrets Operator (external-secrets.io) integration.
M14 Increment 7 — Dedicated single-replica Deployment for the live search indexer.
M14 Increment 9 — Blue/green and canary release strategies for the HTTP tier.

See `docs/DEPLOYING.md` for the full install guide.

## Release strategies

`rollout.strategy` is `rolling` (default), `blueGreen` or `canary`, and applies to the
api and web. The gateway is excluded on purpose: a flip would sever every live
WebSocket connection, and game-command ownership (ADR-0010) is keyed by game rather
than version.

```bash
# Blue/green: both colors up, cut over by rewriting a Service selector.
helm upgrade gambit deploy/helm/gambit \
  --set rollout.strategy=blueGreen \
  --set rollout.blueGreen.colors.blue.tag=1.0.0 \
  --set rollout.blueGreen.colors.green.tag=1.1.0 \
  --set rollout.blueGreen.activeColor=green

# Canary: a weighted share of ingress traffic (requires ingress-nginx).
helm upgrade gambit deploy/helm/gambit \
  --set rollout.strategy=canary \
  --set rollout.canary.tag=1.1.0 \
  --set rollout.canary.weight=10
```

Both run two API versions against one database, so migrations in the release must be
backward compatible with the version still serving. See
`docs/adr/0075-progressive-delivery.md`.

## External secrets

To use [External Secrets Operator](https://external-secrets.io/) with an existing `SecretStore` or `ClusterSecretStore`:

```bash
helm install gambit deploy/helm/gambit \
  --set secrets.externalSecrets.enabled=true \
  --set secrets.externalSecrets.secretStore.name=gambit-store \
  --set secrets.externalSecrets.secretStore.kind=SecretStore \
  --set secrets.externalSecrets.accessTokenSecret.key=gambit/access-token \
  --set secrets.externalSecrets.resendApiKey.key=gambit/resend-api-key \
  --set secrets.externalSecrets.postgresPassword.key=gambit/postgres-password \
  --set email.from=security@your-verified-domain.example \
  --set email.publicWebOrigin=https://your-public-web-origin.example
```

Production email uses only Resend. Set `email.from` and `email.publicWebOrigin`, and provide
`RESEND_API_KEY` through `secrets.existingSecret` or External Secrets. The chart does not accept an
inline provider credential or default sender/origin. The automated deploy workflow reads the two
non-secret values from the selected GitHub Environment's `EMAIL_FROM` and `PUBLIC_WEB_ORIGIN`
variables. `email.provider=console` is available only with a non-production `config.nodeEnv` and
prints no recipient, token, or completed URL.

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
