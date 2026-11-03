{{- define "denpa-agent.labels" -}}
app.kubernetes.io/name: denpa-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/*
denpa と組むときの合言葉 (32 バイトの乱数を base64url で。docs/agent.md)。
**1 度作ったら変えない。** クラスタにもう Secret があればその値 (lookup)、無ければ作る。
描くたびに違う値になるので、呼ぶのは Secret の1か所だけ。lookup はクラスタを見ない描き方 (helm template・ArgoCD) では空
*/}}
{{- define "denpa-agent.pairToken" -}}
{{- $s := lookup "v1" "Secret" .Release.Namespace "tuner-agent-pair" -}}
{{- $kept := dig "data" "token" "" ($s | default dict) -}}
{{- if $kept -}}
{{- $kept | b64dec -}}
{{- else -}}
{{- randBytes 32 | replace "+" "-" | replace "/" "_" | trimSuffix "=" -}}
{{- end -}}
{{- end }}

{{/* 合言葉を置く Secret の名前 (values.yaml の pairSecret。空なら chart が作る tuner-agent-pair) */}}
{{- define "denpa-agent.pairSecretName" -}}
{{- .Values.pairSecret | default "tuner-agent-pair" -}}
{{- end }}
