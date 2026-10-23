{{- define "logice.name" -}}
{{- printf "%s-logice" .Release.Name | trunc 48 | trimSuffix "-" -}}
{{- end -}}

{{- define "logice.apiEnv" -}}
- name: CLICKHOUSE_ADDR
  value: {{ include "logice.name" . }}-clickhouse:9000
- name: CLICKHOUSE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: CLICKHOUSE_PASSWORD
- name: AUTH_ORIGIN
  value: {{ .Values.api.authOrigin | quote }}
- name: AUTH_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: AUTH_ENCRYPTION_KEY
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
