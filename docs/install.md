# 立てる

README の手順の細かいところ。用意するもの、入れ方 (1行・Compose・1コンテナ・Helm)、誰を通すか、前段 (リバースプロキシ) の後ろに置くとき。
Mac と Windows の入れ方の中身は [install-mac.md](install-mac.md) と [install-windows.md](install-windows.md) に。使う前に [使ってよい範囲](../README.md#使ってよい範囲) を読んでください。

## 用意するもの

チューナー・カードリーダー・OS の一覧と機材ごとのページは [tuners.md](tuners.md#要るもの) に。

- イメージは amd64 と arm64 を同じタグにまとめてあり、自分のアーキテクチャのものが降ってきます
- **Intel の GPU** — `/dev/dri` が見えれば起動時に見つけて GPU でエンコードします。compose.prod.yml では渡す行をコメントにしてあるので、
  `compose.override.yml` で渡します (Helm は既定で渡す)。GPU を使えるのは amd64 だけです
  ([encode.md](encode.md#gpu-でエンコードする-intel-qsv--va-api))

## 1行で入れる

**イメージは公開してあるので、clone は要りません。** 立ち上がるとブラウザが開きます。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex   # Windows (x64)
```

- **Linux** (amd64 / arm64) — 全部 Docker Compose。`~/denpa` に compose.prod.yml を `compose.yml` として置いて起動します
- **Mac** (Apple Silicon) — エージェントは Mac の上で直接 (LaunchAgent)、denpa 本体は Docker。USB をコンテナに渡せないため ([install-mac.md](install-mac.md))
- **Windows** (x64) — エージェントは Windows の上で直接 (タスク スケジューラ)、denpa 本体は WSL のコンテナ (`wslc`)。Docker Desktop は要りません。
  チューナーは px4-userland の機材 (PX-Q3U4 など) と siano-userland の機材 (PX-S1UD など)。ドライバは Zadig で WinUSB に ([install-windows.md](install-windows.md))
- **Docker・WSL は入れません。** 無ければ入れ方を示して止まります (Linux は <https://get.docker.com>、
  Mac は Docker Desktop か OrbStack、Windows は `wsl --update`)
- **入口は [genkan](https://github.com/danything/genkan)** (ホスト名で振り分けるリバースプロキシ。Linux・Mac)。
  動いていればそれを使い、無ければ 80 と 443 が空いているときだけ `~/genkan` に入れて <http://denpa.localhost> で開きます。
  入れられなければ `http://<IP>:3000` (localhost は Docker の中継を通って送信元が Docker のゲートウェイに見え、
  既定では信頼しないため。[auth.md](auth.md#ネットワークの中なら何も聞かない))。`denpa.localhost` はそのマシンでしか
  引けないので、LAN のほかの機器 (テレビ・スマホ) からも `http://<IP>:3000` で開きます。Windows はいつも <http://localhost:3000>
- 置き場は `~/denpa` (`DENPA_HOME`)。`compose.yml` は更新のたびに上書きするので、
  **変えたいことは同じ場所の `compose.override.yml` に書きます** (Compose が重ねて読み、install.sh は触らない)。
  Windows は `~/denpa/denpa.env`
- もう一度流すと最新のリリースに上がります。`… | bash -s -- --uninstall` で止めて外します
  (`~/denpa`・録画・DB は残す)。ブラウザを開かないなら `--no-open`。Windows は `-Uninstall` / `-NoOpen`
  (渡し方は install.ps1 の頭)

### Docker Compose を手で置く

Linux ならこれだけです (エージェントは `tuner-agent` として一緒に立つ)。

```sh
mkdir denpa && cd denpa
curl -Lo compose.yml https://raw.githubusercontent.com/danything/denpa/main/compose.prod.yml
docker compose up -d
```

### 1つのコンテナで (`denpa-aio`)

本体とエージェントを1つにまとめたイメージです。チューナーを挿した機械で全部動かすとき
(NAS や、ほかの仕組みに載せるとき) 向け。中身は2つのイメージと同じです。

```sh
docker run -d --name denpa --restart unless-stopped --stop-timeout 21900 \
  --cap-add SYS_RESOURCE \
  --device-cgroup-rule 'c 189:* rmw' --device-cgroup-rule 'c 212:* rmw' \
  -v /dev/bus/usb:/dev/bus/usb -v /dev/dvb:/dev/dvb \
  -e TRUSTED_NETWORKS=192.168.0.0/16,10.0.0.0/8 \
  -v ./config:/config -v denpa-data:/data -v denpa-media:/media \
  -p 3000:3000 ghcr.io/danything/denpa-aio:latest
```

- エージェントの設定 (`tuners.json` / `channels.json`) は `/config`、DB は `/data`、録画は `/media` の下
  (元のTS は `raw`、エンコードしたものは `encoded`)。前のバージョンから上げるときは [config.md](config.md#置き場を変えた-前のバージョンから上げるとき)
- `--privileged` は要りません。USB (189) と DVB (212) のデバイスを開く許可と、pipe を広げる
  `SYS_RESOURCE` だけ渡します。デバイスはディレクトリごと見せるので、挿し直しても再起動は要りません
- 止めるときは録画の終わりを待つので、`--stop-timeout` を長くしておきます (compose の `stop_grace_period` と同じ)。
  どちらかのプロセスが落ちたらコンテナごと終わり、起こし直しは `--restart` に任せます

### Helm (Kubernetes)

```sh
# 本体 + チューナーエージェント (同じクラスタに置く)
helm install denpa oci://ghcr.io/danything/charts/denpa \
  --namespace denpa --create-namespace \
  --set denpa.trustedNetworks=192.168.0.0/16 \
  --set httpRoute.enabled=true \
  --set 'httpRoute.parentRefs[0].name=my-gateway' \
  --set 'httpRoute.parentRefs[0].namespace=gateway-system' \
  --set 'httpRoute.hostnames[0]=denpa.example.home'
```

チューナーを挿した機械にエージェントだけ置き、本体を別の所で動かすなら
`oci://ghcr.io/danything/charts/denpa-agent` を使い、本体側は `TUNER_AGENT_URL` でそこを指します
([agent.md](agent.md#エージェントは別イメージ別プロセス))。値の一覧と意味は
[charts/denpa/values.yaml](../charts/denpa/values.yaml) のコメントにあります。

### イメージのタグ

`latest` はリリースのたびに新しくなります。バージョンを固定するなら `2.7.0` のように書きます
([architecture.md](architecture.md#イメージのタグ))。

### 配布物を確かめる

リリースのイメージ (`denpa`・`denpa-agent`・`denpa-aio`) と、Mac・Windows 用のエージェント
(リリースに添えた `denpa-agent-…-darwin-arm64.tar.gz`・`denpa-agent-…-windows-x64.zip`) には、
**出所の証明 (attestation)** を付けています (2.13.0 から)。このリポジトリのリリースの
workflow が作ったものかを、[GitHub CLI](https://cli.github.com/) で確かめられます。

```sh
# イメージ
gh attestation verify oci://ghcr.io/danything/denpa:2.13.0 -R danything/denpa
# エージェント (リリースから取ったファイル)
gh attestation verify denpa-agent-2.13.0-darwin-arm64.tar.gz -R danything/denpa
```

install.sh / install.ps1 が確かめるのは、同じリリースに置いた `.sha256` だけです。取り損ねて壊れたファイルは
見分けられますが、すり替えまでは防げません。気になるなら、入れる前に上のように確かめてください。
インストーラ自身では確かめません (gh が入っていてログインしていないと確かめられず、そこで入れられなくなるため)。

## 誰を通すか

設定するまで全部断ります。compose の `TRUSTED_NETWORKS` の初期値は家の中 (`192.168.0.0/16,10.0.0.0/8`) で、ここからはログインなしで通ります。
通るのは IP の直書きや `.local` などの名前で開いたときで、自分のドメインなどの名前で開くなら `ALLOWED_HOSTS` に書きます ([auth.md](auth.md#ログインなしで開ける名前-allowed_hosts))。
画面をログインで守るなら OIDC の3つを渡します (リダイレクト URI は `https://<denpa>/login/callback`)。

```yaml
# ~/denpa/compose.override.yml
services:
  denpa:
    environment:
      TRUSTED_NETWORKS: 192.168.1.0/24
      OIDC_ISSUER: https://login.microsoftonline.com/<tenant>/v2.0
      OIDC_CLIENT_ID: <アプリケーションID>
      OIDC_CLIENT_SECRET: <クライアントシークレット>
```

Windows は同じ名前を `KEY=値` で `~/denpa/denpa.env` に、Helm は `denpa.trustedNetworks` と
`denpa.oidcSecretName` に書きます。
**`TRUSTED_NETWORKS=0.0.0.0/0` はインターネットに向けて開くのと同じです。** 家の外に出すなら OIDC を使います。
ログインの細かいことは [auth.md](auth.md)、変数の一覧は [config.md](config.md)。

## LAN でも https で開く

**持っているドメインの名前を LAN の中のアドレスに向ければ、公開しないまま本物の証明書が
使えます** (DNS-01 なら外から繋がる必要が無い。`.arpa` のような内側だけの名前は ACME で
取れない)。ホーム画面に置けるのも全画面にできるのも https のページだけなので、PWA にも要ります。
外向きと LAN 用の2つの名前で出すなら、ホーム画面の名前を分けられます ([watch.md](watch.md#ホーム画面に置く))。
その名前で信頼したネットワークからログインなしで開くなら、名前を `ALLOWED_HOSTS` (か `PWA_NAMES`) に書きます
([auth.md](auth.md#ログインなしで開ける名前-allowed_hosts))。

## うまくいかないとき

立てたあとの手順は [README](../README.md#3-開く)。うまくいかないときは設定の「受信」 (`/settings/reception`) を見ます。エージェントと
カードリーダーの状態、スキャンの結果、番組表の集まり具合が出ます。ログは設定の「その他」の「ログ」 (`/settings/general#logs`) で読め、そこから伏せたログ入りの Issue を開けます。

イメージにはシェルがありません (土台は distroless。[development.md](development.md#イメージの土台は-distroless))。
コンテナの中を見るときは、シェルのあるコンテナを横に付けます。

```sh
# Docker。名前は docker ps に出るもの (compose なら denpa-denpa-1)。中のファイルは /proc/1/root/ の下
docker run --rm -it --pid=container:denpa-denpa-1 --network=container:denpa-denpa-1 busybox
# Kubernetes
kubectl debug -it deploy/denpa --image=busybox --target=denpa -n denpa
```

## 前段 (リバースプロキシ) の後ろに置く

- **前段のアドレスを `TRUSTED_PROXIES` に書きます** (CIDR のカンマ区切り)。無いと接続元がすべて前段になり、
  `TRUSTED_NETWORKS` が誰にも当たりません。決め方は [auth.md](auth.md#前段の後ろに置くとき-trusted_proxies)
- **`Host` をそのまま渡し、WebSocket を通します。** `Host` が書き換わると設定の保存などの POST が
  `403 Cross-site POST form submissions are forbidden` で断られ、WebSocket が通らないとライブが
  「繋がりませんでした」になります。Caddy・Traefik・Envoy (Gateway API) は何もしなくても満たします。
  Nginx Proxy Manager は「Websockets Support」を入れます。nginx は自分で書きます:

  ```nginx
  location / {
      proxy_pass http://<denpa>:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_buffering off;  # SSE とライブを溜めずに流す
  }
  ```

- **`/denpa` のような接頭辞の下にも置けます** (Home Assistant の Ingress など)。接頭辞は denpa に教えません。
  OIDC に渡す絶対 URL にだけ、前段が付ける `X-Forwarded-Prefix` (Home Assistant は `X-Ingress-Path`) を
  頭に付けます (`paths.ts` の `publicBase`)
