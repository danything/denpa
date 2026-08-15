{{/*
名前は release 名を使わず固定にしてある。SealedSecret (`denpa-oidc`) や
CI が書く image mark など、外から名前で参照されるものがあるため。
複数の denpa を1つの名前空間に入れることは無い (チューナーは1台の物理機材)
*/}}
{{- define "denpa.labels" -}}
app.kubernetes.io/name: denpa
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/* PVC の名前。existingClaim があればそれ、無ければ chart が作るもの */}}
{{- define "denpa.pvcName" -}}
{{- $p := index .Values.persistence .key -}}
{{- if $p.existingClaim }}{{ $p.existingClaim }}{{ else }}{{ .name }}{{ end -}}
{{- end }}
