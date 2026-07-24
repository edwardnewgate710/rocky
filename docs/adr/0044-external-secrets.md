# ADR-0044: External Secrets Operator (external-secrets.io) integration

**Date:** 2026-07-24
**Status:** Accepted
**Milestone:** M14 Increment 6

## Context

The Gambit Helm chart (`deploy/helm/gambit/`) packages the platform for Kubernetes. Previously (ADR-0009), sensitive credentials—specifically `ACCESS_TOKEN_SECRET` (HMAC secret shared between API and gateway) and `POSTGRES_PASSWORD` (when bundled Postgres is enabled)—were provisioned in one of two ways:
1. Inline via `secrets.accessTokenSecret` / `secrets.postgresPassword` → rendered as an inline Opaque `Secret` (`templates/secret.yaml`).
2. Existing Secret reference via `secrets.existingSecret` → chart renders no Secret resource and consumers reference the named external Secret.

While effective, production Kubernetes environments using secrets managers (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, Azure Key Vault, etc.) require an automated, operator-driven reconciliation loop to sync remote secrets into Kubernetes `Secret` objects.

The External Secrets Operator (ESO, `external-secrets.io`) is the standard Kubernetes operator for this pattern.

## Decision

### 1. `secrets.externalSecrets` values contract

Add `secrets.externalSecrets` to `deploy/helm/gambit/values.yaml`:

```yaml
secrets:
  existingSecret: ""
  accessTokenSecret: ""
  postgresPassword: ""
  externalSecrets:
    enabled: false
    secretStore:
      name: ""
      kind: SecretStore   # or ClusterSecretStore
    refreshInterval: 1h
    accessTokenSecret:
      key: ""
      property: ""
    postgresPassword:
      key: ""
      property: ""
```

### 2. Seam preservation: `ExternalSecret.target.name` equals `gambit.secretName`

The `ExternalSecret` resource (`templates/externalsecret.yaml`) sets `spec.target.name` to `{{ include "gambit.secretName" . }}`.

Because `templates/api.yaml` and `templates/gateway.yaml` already reference `gambit.secretName` via `secretKeyRef` for `ACCESS_TOKEN_SECRET` and `POSTGRES_PASSWORD`, the Deployment templates require **zero changes**. ESO reconciles the remote keys into the exact Secret name expected by the application containers.

### 3. Mutual exclusivity and inline Secret skipping

The three secret provisioning modes (inline, `existingSecret`, and `externalSecrets`) are mutually exclusive:
- If `externalSecrets.enabled` is `true` AND `existingSecret` is set → Helm `fail` error.
- If `externalSecrets.enabled` is `true` AND a non-empty inline `secrets.accessTokenSecret` / `secrets.postgresPassword` is set → Helm `fail` error. (Without this guard the inline value would be silently ignored — `secret.yaml` is suppressed in ES mode — leaving an operator believing an inline credential is active.)
- When `externalSecrets.enabled` is `true`, `templates/secret.yaml` skips rendering the inline Opaque `Secret` completely. Inline min-length validation for `accessTokenSecret` / `postgresPassword` is skipped because inline values are intentionally empty in ES mode.
- `secretStore.kind` is validated against the enum `SecretStore` / `ClusterSecretStore` (Helm `fail` otherwise) — ESO rejects any other value, and a typo would otherwise render a silently-unusable `ExternalSecret`.

### 4. API version choice

Use `apiVersion: external-secrets.io/v1` (current stable API). Do not use `v1beta1`.

### 5. CI schema validation & `kubeconform` caveat

`ExternalSecret` is a Custom Resource Definition (CRD) and its schema is not bundled in `kubeconform`'s standard Kubernetes schema set.

In CI (`.github/workflows/ci.yml`), three render cases are validated:
1. Default values (`externalSecrets.enabled=false`): validated with `kubeconform -strict` (no CRDs rendered).
2. External datastores (`externalSecrets.enabled=false`): validated with `kubeconform -strict`.
3. External secrets (`externalSecrets.enabled=true`): piped to `kubeconform -strict -ignore-missing-schemas -summary`.

`-ignore-missing-schemas` skips validation for unbundled CRDs (`ExternalSecret`) while strictly enforcing schema conformance on all standard Kubernetes resources in the rendered output (Deployments, Services, ConfigMaps, Ingress).

*Alternative considered:* Pinning external CRD JSON schema URLs via `-schema-location`. Rejected to avoid coupling CI runs to external network dependencies and URL version drift.

### 6. Out-of-scope operational prerequisites

Installing the External Secrets Operator in the target Kubernetes cluster and configuring a `SecretStore` or `ClusterSecretStore` are infrastructure prerequisites performed outside of this Helm chart.

## Consequences

- Full integration with external-secrets.io without modifying application Deployment manifests.
- Seamless compatibility with Vault, AWS/GCP/Azure secrets managers.
- Backward compatibility for default inline and existingSecret paths preserved byte-for-byte.
- Strict fail-closed validation for missing required external secret keys or invalid store configurations.
