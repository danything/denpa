{{- define "denpa-agent.labels" -}}
app.kubernetes.io/name: denpa-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/*
denpa と組むときの合言葉 (32 バイトの乱数を base64url で。docs/agent.md)。pairToken に書いてあればそれ。
無ければ**1度作ったら変えない** — クラスタにもう Secret があればその値 (lookup)、無ければ作る。
描くたびに違う値になるので、呼ぶのは Secret の1か所だけ。lookup はクラスタを見ない描き方 (helm template・ArgoCD) では空
*/}}
{{- define "denpa-agent.pairToken" -}}
{{- if .Values.pairToken -}}
{{- .Values.pairToken -}}
{{- else -}}
{{- $s := lookup "v1" "Secret" .Release.Namespace "tuner-agent-pair" -}}
{{- $kept := dig "data" "token" "" ($s | default dict) -}}
{{- if $kept -}}
{{- $kept | b64dec -}}
{{- else -}}
{{- randBytes 32 | replace "+" "-" | replace "/" "_" | trimSuffix "=" -}}
{{- end -}}
{{- end -}}
{{- end }}
