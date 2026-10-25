{{- define "logice.name" -}}
{{- printf "%s-logice" .Release.Name | trunc 48 | trimSuffix "-" -}}
{{- end -}}

{{/* Digest overrides tag. The same helper serves the API, migration, and worker. */}}
{{- define "logice.image" -}}
{{- $repository := required (printf "%s.image.repository is required" .name) .image.repository -}}
{{- if .image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .image.digest) -}}
{{- fail (printf "%s.image.digest must be a sha256 digest" .name) -}}
{{- end -}}
{{- printf "%s@%s" $repository .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository (required (printf "%s.image.tag is required without a digest" .name) .image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "logice.apiEnv" -}}
- name: CLICKHOUSE_ADDR
  value: {{ include "logice.name" . }}-clickhouse:9000
- name: CLICKHOUSE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: CLICKHOUSE_PASSWORD
- name: COLLECTOR_URL
  value: http://{{ include "logice.name" . }}-collector:4318
- name: OTLP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: OTLP_TOKEN
- name: AUTH_ORIGIN
  value: {{ .Values.api.authOrigin | quote }}
- name: ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: ENCRYPTION_KEY
- name: PGHOST
  value: {{ include "logice.name" . }}-postgres
- name: PGPORT
  value: "5432"
- name: PGUSER
  value: logice
- name: PGDATABASE
  value: logice
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: POSTGRES_PASSWORD
{{- end -}}

{{- define "logice.labels" -}}
app.kubernetes.io/name: logice
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
