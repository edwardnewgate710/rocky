#!/usr/bin/env bash
#
# Snapshot test: proves key wiring of the Gambit Helm chart.
#
# Verifies:
#   1. Gateway replicas == 2
#   2. API + gateway share the same DATABASE_URL source (both reference
#      $(POSTGRES_PASSWORD) from the Secret when postgres is bundled)
#   3. POSTGRES_PASSWORD appears BEFORE DATABASE_URL in every container's
#      env list (Kubernetes only expands $(VAR) for vars defined earlier —
#      regression guard for the env-ordering bug)
#   4. Gateway gets REDIS_URL + NODE_ID from the pod name (downward API)
#   5. Secrets come from the Secret (not hardcoded in env)
#   6. Probes hit the correct endpoints
#
set -euo pipefail

CHART_DIR="deploy/helm/gambit"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

# Render default values
HELM_SECRETS=(
  --set secrets.accessTokenSecret=test-only-access-token-secret-32-bytes-minimum
  --set secrets.postgresPassword=test-only-postgres-password
)

helm template "$CHART_DIR" "${HELM_SECRETS[@]}" > "$TMPDIR/default.yaml" 2>/dev/null

# Render external-datastore override
helm template "$CHART_DIR" \
  --set secrets.accessTokenSecret=test-only-access-token-secret-32-bytes-minimum \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379 \
  > "$TMPDIR/external.yaml" 2>/dev/null

# Render external-secrets override
helm template "$CHART_DIR" \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set externalDatabaseUrl=postgres://user:pass@db.example.com:5432/gambit \
  --set externalRedisUrl=redis://redis.example.com:6379 \
  --set secrets.externalSecrets.enabled=true \
  --set secrets.externalSecrets.secretStore.name=gambit-store \
  --set secrets.externalSecrets.accessTokenSecret.key=gambit/access-token \
  > "$TMPDIR/external-secrets.yaml" 2>/dev/null

# Rendering without a secret must fail closed.
if helm template "$CHART_DIR" > /dev/null 2>&1; then
  echo "Chart rendered without ACCESS_TOKEN_SECRET"
  exit 1
fi

echo ""
echo "=== Snapshot test: key wiring ==="
echo ""

# --- 1. Gateway replicas == 2 ---
GATEWAY_REPLICAS=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.replicas' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway replicas == 2 (default values)" "$([ "$GATEWAY_REPLICAS" = "2" ] && echo 0 || echo 1)"

# --- 2. API + gateway share the same DATABASE_URL source ---
API_DB_URL=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
GW_DB_URL=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API DATABASE_URL references \$(POSTGRES_PASSWORD)" "$([ "$API_DB_URL" = 'postgres://gambit:$(POSTGRES_PASSWORD)@release-name-gambit-postgres:5432/gambit' ] && echo 0 || echo 1)"
check "Gateway DATABASE_URL references \$(POSTGRES_PASSWORD)" "$([ "$GW_DB_URL" = 'postgres://gambit:$(POSTGRES_PASSWORD)@release-name-gambit-postgres:5432/gambit' ] && echo 0 || echo 1)"
check "API and gateway share the same DATABASE_URL source" "$([ "$API_DB_URL" = "$GW_DB_URL" ] && echo 0 || echo 1)"

# --- 2b. External datastore: DATABASE_URL comes from externalDatabaseUrl ---
API_DB_EXT=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/external.yaml" 2>/dev/null || echo "")
GW_DB_EXT=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="DATABASE_URL") | .value' "$TMPDIR/external.yaml" 2>/dev/null || echo "")
check "External: API DATABASE_URL = externalDatabaseUrl" "$([ "$API_DB_EXT" = 'postgres://user:pass@db.example.com:5432/gambit' ] && echo 0 || echo 1)"
check "External: Gateway DATABASE_URL = externalDatabaseUrl" "$([ "$GW_DB_EXT" = 'postgres://user:pass@db.example.com:5432/gambit' ] && echo 0 || echo 1)"

# --- 3. REGRESSION GUARD: POSTGRES_PASSWORD appears BEFORE DATABASE_URL ---
# Kubernetes only expands $(VAR) for vars defined earlier in the same env list.
# If POSTGRES_PASSWORD comes after DATABASE_URL, $(POSTGRES_PASSWORD) stays
# literal and the DB connection fails.

# Helper: get the env-array index of a named env var in a specific container
# Args: yaml_file, deployment_name_pattern, container_type (containers|initContainers), container_name, env_name
env_index() {
  local yaml_file="$1" dep_pattern="$2" container_type="$3" container_name="$4" env_name="$5"
  yq ". | select(.kind==\"Deployment\" and .metadata.name | test(\"$dep_pattern\")) | .spec.template.spec.${container_type}[] | select(.name==\"$container_name\") | .env | to_entries | .[] | select(.value.name==\"$env_name\") | .key" "$yaml_file" 2>/dev/null || echo "-1"
}

# API migrate initContainer
MIGRATE_PW_IDX=$(env_index "$TMPDIR/default.yaml" "api" "initContainers" "migrate" "POSTGRES_PASSWORD")
MIGRATE_DB_IDX=$(env_index "$TMPDIR/default.yaml" "api" "initContainers" "migrate" "DATABASE_URL")
check "API migrate: POSTGRES_PASSWORD (idx=$MIGRATE_PW_IDX) before DATABASE_URL (idx=$MIGRATE_DB_IDX)" "$([ -n "$MIGRATE_PW_IDX" ] && [ -n "$MIGRATE_DB_IDX" ] && [ "$MIGRATE_PW_IDX" -lt "$MIGRATE_DB_IDX" ] && echo 0 || echo 1)"

# API main container
API_PW_IDX=$(env_index "$TMPDIR/default.yaml" "api" "containers" "api" "POSTGRES_PASSWORD")
API_DB_IDX=$(env_index "$TMPDIR/default.yaml" "api" "containers" "api" "DATABASE_URL")
check "API container: POSTGRES_PASSWORD (idx=$API_PW_IDX) before DATABASE_URL (idx=$API_DB_IDX)" "$([ -n "$API_PW_IDX" ] && [ -n "$API_DB_IDX" ] && [ "$API_PW_IDX" -lt "$API_DB_IDX" ] && echo 0 || echo 1)"

# Gateway main container
GW_PW_IDX=$(env_index "$TMPDIR/default.yaml" "gateway" "containers" "gateway" "POSTGRES_PASSWORD")
GW_DB_IDX=$(env_index "$TMPDIR/default.yaml" "gateway" "containers" "gateway" "DATABASE_URL")
check "Gateway container: POSTGRES_PASSWORD (idx=$GW_PW_IDX) before DATABASE_URL (idx=$GW_DB_IDX)" "$([ -n "$GW_PW_IDX" ] && [ -n "$GW_DB_IDX" ] && [ "$GW_PW_IDX" -lt "$GW_DB_IDX" ] && echo 0 || echo 1)"

# --- 4. Gateway gets REDIS_URL + NODE_ID from pod name ---
GW_REDIS_URL=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="REDIS_URL") | .value' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway gets REDIS_URL (bundled redis)" "$([ "$GW_REDIS_URL" = 'redis://release-name-gambit-redis:6379' ] && echo 0 || echo 1)"

GW_NODE_ID_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="NODE_ID") | .valueFrom.fieldRef.fieldPath' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway NODE_ID from pod name (downward API)" "$([ "$GW_NODE_ID_REF" = 'metadata.name' ] && echo 0 || echo 1)"

# External redis
GW_REDIS_EXT=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="REDIS_URL") | .value' "$TMPDIR/external.yaml" 2>/dev/null || echo "")
check "External: Gateway REDIS_URL = externalRedisUrl" "$([ "$GW_REDIS_EXT" = 'redis://redis.example.com:6379' ] && echo 0 || echo 1)"

# --- 5. Secrets come from the Secret (not hardcoded) ---
API_SECRET_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="ACCESS_TOKEN_SECRET") | .valueFrom.secretKeyRef.name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API ACCESS_TOKEN_SECRET from Secret" "$([ "$API_SECRET_REF" = 'release-name-gambit-secret' ] && echo 0 || echo 1)"

GW_SECRET_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="ACCESS_TOKEN_SECRET") | .valueFrom.secretKeyRef.name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway ACCESS_TOKEN_SECRET from Secret" "$([ "$GW_SECRET_REF" = 'release-name-gambit-secret' ] && echo 0 || echo 1)"

# Verify POSTGRES_PASSWORD comes from Secret (not hardcoded)
PG_PW_REF=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .env[] | select(.name=="POSTGRES_PASSWORD") | .valueFrom.secretKeyRef.name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API POSTGRES_PASSWORD from Secret" "$([ "$PG_PW_REF" = 'release-name-gambit-secret' ] && echo 0 || echo 1)"

# --- 6. API has migration init container ---
MIGRATE_CMD=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.initContainers[] | select(.name=="migrate") | .command[2]' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API has migration init container" "$([ "$MIGRATE_CMD" = 'npm run migrate --workspace @chess-platform/persistence' ] && echo 0 || echo 1)"

# --- 7. Gateway has wait-for-api init container ---
WAIT_CMD=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.initContainers[] | select(.name=="wait-for-api") | .name' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway has wait-for-api init container" "$([ "$WAIT_CMD" = 'wait-for-api' ] && echo 0 || echo 1)"

# --- 8. Probes hit correct endpoints ---
API_PROBE=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("api")) | .spec.template.spec.containers[] | select(.name=="api") | .readinessProbe.httpGet.path' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "API readiness probe hits /v1/ready" "$([ "$API_PROBE" = '/v1/ready' ] && echo 0 || echo 1)"

GW_PROBE=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .readinessProbe.httpGet.path' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Gateway readiness probe hits /ready" "$([ "$GW_PROBE" = '/ready' ] && echo 0 || echo 1)"

WEB_PROBE=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("web")) | .spec.template.spec.containers[] | select(.name=="web") | .readinessProbe.httpGet.path' "$TMPDIR/default.yaml" 2>/dev/null || echo "")
check "Web readiness probe hits /" "$([ "$WEB_PROBE" = '/' ] && echo 0 || echo 1)"

# --- 9. External secrets integration ---
ES_KIND=$(grep -c 'kind: ExternalSecret' "$TMPDIR/external-secrets.yaml" || true)
check "External secrets: renders kind: ExternalSecret" "$([ "$ES_KIND" -gt 0 ] && echo 0 || echo 1)"

ES_API_VER=$(grep -c 'apiVersion: external-secrets.io/v1' "$TMPDIR/external-secrets.yaml" || true)
check "External secrets: apiVersion external-secrets.io/v1" "$([ "$ES_API_VER" -gt 0 ] && echo 0 || echo 1)"

ES_TARGET=$(yq '. | select(.kind=="ExternalSecret") | .spec.target.name' "$TMPDIR/external-secrets.yaml" 2>/dev/null || grep -A2 'target:' "$TMPDIR/external-secrets.yaml" | grep 'name:' | head -n1 | awk '{print $2}')
GW_SECRET_REF_ES=$(yq '. | select(.kind=="Deployment" and .metadata.name | test("gateway")) | .spec.template.spec.containers[] | select(.name=="gateway") | .env[] | select(.name=="ACCESS_TOKEN_SECRET") | .valueFrom.secretKeyRef.name' "$TMPDIR/external-secrets.yaml" 2>/dev/null || grep -A3 'ACCESS_TOKEN_SECRET' "$TMPDIR/external-secrets.yaml" | grep 'name:' | head -n1 | awk '{print $2}')
check "External secrets: target.name resolves to consumer secretKeyRef name" "$([ -n "$ES_TARGET" ] && [ "$ES_TARGET" = "$GW_SECRET_REF_ES" ] && [ "$ES_TARGET" = "release-name-gambit-secret" ] && echo 0 || echo 1)"

ES_SECRET_COUNT=$(grep -c '^kind: Secret$' "$TMPDIR/external-secrets.yaml" || true)
check "External secrets: inline Secret is not rendered (kind: Secret count == 0)" "$([ "$ES_SECRET_COUNT" = "0" ] && echo 0 || echo 1)"

DEFAULT_SECRET_COUNT=$(grep -c '^kind: Secret$' "$TMPDIR/default.yaml" || true)
DEFAULT_ES_COUNT=$(grep -c '^kind: ExternalSecret$' "$TMPDIR/default.yaml" || true)
check "Default render: exactly one kind: Secret" "$([ "$DEFAULT_SECRET_COUNT" = "1" ] && echo 0 || echo 1)"
check "Default render: no kind: ExternalSecret" "$([ "$DEFAULT_ES_COUNT" = "0" ] && echo 0 || echo 1)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All snapshot tests passed."
