{{/*
Helper templates for the Gambit Helm chart.
*/}}

{{/*
Expand the chart name.
*/}}
{{- define "gambit.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Full name: release name + chart name.
*/}}
{{- define "gambit.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version label.
*/}}
{{- define "gambit.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "gambit.labels" -}}
helm.sh/chart: {{ include "gambit.chart" . }}
{{ include "gambit.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "gambit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gambit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Secret name.
*/}}
{{- define "gambit.secretName" -}}
{{- default (printf "%s-secret" (include "gambit.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
ConfigMap name.
*/}}
{{- define "gambit.configMapName" -}}
{{- printf "%s-config" (include "gambit.fullname" .) -}}
{{- end -}}

{{/*
Postgres service name (when bundled).
*/}}
{{- define "gambit.postgresServiceName" -}}
{{- printf "%s-postgres" (include "gambit.fullname" .) -}}
{{- end -}}

{{/*
Redis service name (when bundled).
*/}}
{{- define "gambit.redisServiceName" -}}
{{- printf "%s-redis" (include "gambit.fullname" .) -}}
{{- end -}}

{{/*
DATABASE_URL resolution:
  - If postgres.enabled=true: build from bundled postgres service + Secret password.
  - If postgres.enabled=false: use externalDatabaseUrl from values.
Both api and gateway use this — they share the same DATABASE_URL source.
*/}}
{{- define "gambit.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "postgres://%s:$(POSTGRES_PASSWORD)@%s:%d/%s" .Values.postgres.user (include "gambit.postgresServiceName" .) (int .Values.postgres.port) .Values.postgres.database -}}
{{- else -}}
{{- required "externalDatabaseUrl is required when postgres.enabled=false" .Values.externalDatabaseUrl -}}
{{- end -}}
{{- end -}}

{{/*
REDIS_URL resolution:
  - If redis.enabled=true: build from bundled redis service.
  - If redis.enabled=false: use externalRedisUrl from values.
*/}}
{{- define "gambit.redisUrl" -}}
{{- if .Values.redis.enabled -}}
{{- printf "redis://%s:%d" (include "gambit.redisServiceName" .) (int .Values.redis.port) -}}
{{- else -}}
{{- required "externalRedisUrl is required when redis.enabled=false" .Values.externalRedisUrl -}}
{{- end -}}
{{- end -}}
