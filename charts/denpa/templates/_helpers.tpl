{{/*
名前は release 名を使わず固定にしてある。OIDC の Secret (`denpa-oidc`) や
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

{{/*
エージェントと組むときの合言葉 (32 バイトの乱数を base64url で。docs/agent.md)。**1度作ったら変えない** —
クラスタにもう Secret があればその値 (lookup)、無ければ作る。描くたびに違う値になるので、呼ぶのは Secret の1か所だけ。
lookup はクラスタを見ない描き方 (helm template・ArgoCD) では空なので、そのときは毎回作り直す (values.yaml の agent の説明)
*/}}
{{- define "denpa.pairToken" -}}
{{- $s := lookup "v1" "Secret" .Release.Namespace "tuner-agent-pair" -}}
{{- $kept := dig "data" "token" "" ($s | default dict) -}}
{{- if $kept -}}
{{- $kept | b64dec -}}
{{- else -}}
{{- randBytes 32 | replace "+" "-" | replace "/" "_" | trimSuffix "=" -}}
{{- end -}}
{{- end }}
