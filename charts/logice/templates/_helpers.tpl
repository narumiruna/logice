{{- define "logice.name" -}}
{{- printf "%s-logice" .Release.Name | trunc 48 | trimSuffix "-" -}}
{{- end -}}

{{- define "logice.labels" -}}
app.kubernetes.io/name: logice
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
