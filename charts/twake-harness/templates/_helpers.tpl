{{- define "twake-harness.labels" -}}
app.kubernetes.io/name: twake-harness
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .Values.role }}
{{- end }}

{{- define "twake-harness.selectorLabels" -}}
app.kubernetes.io/name: twake-harness
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "twake-harness.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{- define "twake-harness.secretName" -}}
{{ .Values.existingSecret | default (printf "%s-env" .Release.Name) }}
{{- end }}
