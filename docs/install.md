# 立てる

README の手順の細かいところ。用意するもの、入れ方 (1 行・Compose・1 コンテナ・Helm・Talos Linux・Android)、誰を通すか、前段 (リバースプロキシ) の後ろに置くとき。
Mac と Windows の入れ方の中身は [install-mac.md](install-mac.md) と [install-windows.md](install-windows.md) に、Android の端末で動かすなら [install-android.md](install-android.md) に。使う前に [使ってよい範囲](../README.md#使ってよい範囲) を読んでください。

## 用意するもの

チューナー・カードリーダー・OS の一覧と機材ごとのページは [tuners.md](tuners.md#要るもの) に。

- イメージは amd64 と arm64 を同じタグにまとめてあり、自分のアーキテクチャのものが降ってきます
- **Intel・AMD の GPU**: `/dev/dri` が見えれば起動時に見つけて GPU でエンコードします。compose.prod.yml では渡す行をコメントにしてあるので、
  `compose.override.yml` で渡します (Helm は既定で渡す)。Intel・AMD の GPU を使えるのは amd64 だけです
  ([encode.md](encode.md#gpu-でエンコードする-va-api))
- **NVIDIA の GPU**: ホストにドライバ (530 以降) と NVIDIA Container Toolkit を入れ、GPU を予約して渡せば、H.264・H.265 と AV1 (RTX 40 以降) を
  NVENC でエンコードします (amd64。[encode.md](encode.md#nvidia-でエンコードする))
- **Rockchip (RK3588 / RK3588S)**: BSP カーネルの上で `/dev/mpp_service` と `/dev/dma_heap` を渡せば、H.264 と H.265 を
  ハードウェアでエンコードします (arm64。[encode.md](encode.md#rockchip-rk3588-でエンコードする))

## 1行で入れる

**イメージは公開してあるので、clone は要りません。** 立ち上がるとブラウザが開きます。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash        # Linux
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | sudo bash   # Mac (Apple Silicon)
```

```powershell
irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex   # Windows (x64)
```

- **Linux** (amd64 / arm64): 全部 Docker Compose。`~/denpa` に compose.prod.yml を `compose.yml` として置いて起動します
- **Mac** (Apple Silicon): denpa 本体もエージェントも Mac の上で直接 (root の LaunchDaemon)。Docker は要りません。sudo で流します ([install-mac.md](install-mac.md))
- **Windows** (x64): denpa 本体もエージェントも Windows の上で直接 (タスク スケジューラの SYSTEM のタスク)。WSL・Docker Desktop は要りません。管理者の PowerShell で流します。
  チューナーは IT930x の機材 (PX-MLT5 系・PX-Q3U4 など) と PX-S1UD と Sony CECH-ZD1 J と PIXELA PIX-DT295。ドライバは `install.ps1 -WinUsb` で WinUSB に替える ([install-windows.md](install-windows.md#チューナーのドライバを-winusb-に替える))
- **Docker は入れません** (Linux)。無ければ入れ方 (<https://get.docker.com>) を示して止まります
- **入口は [genkan](https://github.com/danything/genkan)** (ホスト名で振り分けるリバースプロキシ。Linux)。
  動いていればそれを使い、無ければ 80 と 443 が空いているときだけ `~/genkan` に入れて <http://denpa.localhost> で開きます。
  入れられなければ `http://<IP>:3000` (localhost は Docker の中継を通って送信元が Docker のゲートウェイに見え、
  既定では信頼しないため。[auth.md](auth.md#ネットワークの中なら何も聞かない))。`denpa.localhost` はそのマシンでしか
  引けないので、LAN のほかの機器 (テレビ・スマホ) からも `http://<IP>:3000` で開きます。Mac と Windows はいつも <http://localhost:3000>
- 置き場は `~/denpa` (`DENPA_HOME`)。`compose.yml` は更新のたびに上書きするので、
  **変えたいことは同じ場所の `compose.override.yml` に書きます** (Compose が重ねて読み、install.sh は触らない)。
  Mac は `/Library/Application Support/denpa/data/denpa.env`、Windows は `%ProgramData%\denpa\denpa.env`
- denpa とエージェントが組むときの合言葉 ([agent.md](agent.md)) は、Linux は `~/denpa/.env` の `AGENT_PAIR_TOKEN` に、
  Mac と Windows は `~/denpa/config/tls/pair-token` (エージェント自身の置き場) に、無いときだけ作って両方へ渡します。上げ直しても変えません
- もう一度流すと最新のリリースに上がります。`… | bash -s -- --uninstall` (Mac は `… | sudo bash -s -- --uninstall`) で止めて外します
  (`~/denpa`・録画・DB は残す)。ブラウザを開かないなら `--no-open`。Windows は `-Uninstall` / `-NoOpen`
  (渡し方は install.ps1 の冒頭)

### Docker Compose を手で置く

Linux ならこれだけです (エージェントは `tuner-agent` として一緒に立つ)。

```sh
mkdir denpa && cd denpa
curl -Lo compose.yml https://raw.githubusercontent.com/danything/denpa/main/compose.prod.yml
# denpa とエージェントが組むときの合言葉 (agent.md)。一度作ったら変えない
echo "AGENT_PAIR_TOKEN=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" > .env
docker compose up -d
```

`.env` の `AGENT_PAIR_TOKEN` が無いと compose は止まります (install.sh は無いときだけ作ります)。

### 1つのコンテナで (`denpa-aio`)

本体とエージェントを 1 つにまとめたイメージです。チューナーを挿した機械で全部動かすとき
(NAS や、ほかの仕組みに載せるとき) 向け。中身は 2 つのイメージと同じです。

```sh
docker run -d --name denpa --restart unless-stopped --stop-timeout 21900 \
  --device-cgroup-rule 'c 189:* rmw' --device-cgroup-rule 'c 212:* rmw' \
  -v /dev/bus/usb:/dev/bus/usb -v /dev/dvb:/dev/dvb \
  -e TRUSTED_NETWORKS=192.168.0.0/16,10.0.0.0/8 \
  -v ./config:/config -v denpa-data:/data -v denpa-media:/media \
  -p 3000:3000 ghcr.io/danything/denpa-aio:latest
```

- エージェントの設定 (`tuners.json` / `channels.json`) は `/config`、DB は `/data`、録画は `/media` の下
  (元の TS は `raw`、エンコードしたものは `encoded`)。前のバージョンから上げるときは [config.md](config.md#置き場を変えた-前のバージョンから上げるとき)
- 本体とエージェントが組むときの合言葉 ([agent.md](agent.md)) は、入口が `/config/tls/pair-token` に無いときだけ作って両方に渡します
- `--privileged` は要りません。USB (189) と DVB (212) のデバイスを開く許可だけ渡します。デバイスはディレクトリごと見せるので、挿し直しても再起動は要りません
- 止めるときは録画の終わりを待つので、`--stop-timeout` を長くしておきます (compose の `stop_grace_period` と同じ)。
  どちらかのプロセスが落ちたらコンテナごと終わり、起動し直すのは `--restart` の役目です

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
([agent.md](agent.md#エージェントは別イメージ別プロセス))。`TUNER_AGENT_URL` には `#pair=<合言葉>` を付けます。
合言葉は chart が Secret `tuner-agent-pair` に作り、読み方は `helm install` のあとに出ます。
本体の chart はエージェントと組む合言葉を自分で作って両方に渡すので、何も書かなくて構いません
(ArgoCD などの GitOps で入れるときは、合言葉を SOPS などで別の Secret に持ち、その名前を `agent.pairSecret` に書きます。
ArgoCD はクラスタを見ずに描くので chart に作らせると値が変わり続け、Secret を同期しない設定ならそもそも作られません。
`denpa-agent` の chart も同じで `pairSecret`)。値の一覧と意味は
[charts/denpa/values.yaml](../charts/denpa/values.yaml) のコメントにあります。

#### PVC の名前を変えた (前のバージョンから上げるとき)

**chart の PVC と values のキーを `raw` / `encoded` に改めました。**

| 中身               | 前 (PVC / values のキー)                  | いま                                    |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| 元の TS            | `denpa-recorded` / `persistence.recorded` | `denpa-raw` / `persistence.raw`         |
| エンコードしたもの | `denpa-library` / `persistence.library`   | `denpa-encoded` / `persistence.encoded` |

**そのまま上げると、新しい名前の空の PVC ができます。** 古い PVC は `helm.sh/resource-policy: keep`
で残るので消えはしませんが、録画は見えなくなります。どちらかで繋ぎます。

- 古い PVC をそのまま使う: `persistence.raw.existingClaim: denpa-recorded` /
  `persistence.encoded.existingClaim: denpa-library` (denpa-agent の chart は `persistence.raw.existingClaim`)
- 名前ごと移す: アプリを止め、PV の reclaim を `Retain` にして古い PVC を消し、PV の
  `claimRef` を外してから、新しい名前の PVC を `volumeName` で同じ PV に結ぶ。中身はコピーしない

### Talos Linux に OS ごと

PT3 を挿した機械を Talos Linux の 1 台のクラスタにして、OS の設定から denpa まで 1 行で立てます
(Talos の alpha で、実機では確かめていない)。手順は [install-talos.md](install-talos.md)。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/talos/install.sh | sh -s -- --node <IP>
```

### Android の端末で動かす

チューナーを挿した Android の端末 (Android 10 以上、arm64) の 1 台で、denpa 本体とチューナーエージェントを動かせます
(実機では確かめていない)。別の機械で動かす denpa のチューナーエージェントにもできます。リリースの `denpa-<バージョン>-android-arm64.apk` を入れ、
通知の「URL をコピー」で取った `http://<端末のアドレス>:3000` を同じ LAN のブラウザで開きます。エージェントとして足すなら、「組む URL をコピー」で取った URL を denpa の `TUNER_AGENT_URL` に書きます。
手順は [install-android.md](install-android.md)。

### イメージのタグ

`latest` はリリースのたびに新しくなります。バージョンを固定するなら `2.7.0` のように書きます
([architecture.md](architecture.md#イメージのタグ))。

### 配布物を確かめる

リリースのイメージ (`denpa`・`denpa-agent`・`denpa-aio`) と、Mac・Windows 用のエージェントと denpa 本体と、Android のアプリ
(リリースに添えた `denpa-agent-…-darwin-arm64.tar.gz`・`denpa-agent-…-windows-x64.zip`・`denpa-…-darwin-arm64.tar.gz`・`denpa-…-windows-x64.zip`・`denpa-…-android-arm64.apk`) には、
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
画面をログインで守るなら OIDC の 3 つを渡します (リダイレクト URI は `https://<denpa>/login/callback`)。

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

Mac と Windows は同じ名前を `KEY=値` で `denpa.env` ([install-mac.md](install-mac.md#環境変数を足す-denpaenv)・[install-windows.md](install-windows.md#環境変数を足す-denpaenv)) に、Helm は `denpa.trustedNetworks` と
`denpa.oidcSecretName` に書きます。
**`TRUSTED_NETWORKS=0.0.0.0/0` はインターネットに向けて開くのと同じです。** 家の外に出すなら OIDC を使います。
ログインの細かいことは [auth.md](auth.md)、変数の一覧は [config.md](config.md)。

## LAN でも https で開く

**持っているドメインの名前を LAN の中のアドレスに向ければ、公開しないまま本物の証明書が
使えます** (DNS-01 なら外から繋がる必要が無い。`.arpa` のような内側だけの名前は ACME で
取れない)。ホーム画面に置けるのも全画面にできるのも https のページだけなので、PWA にも要ります。
外向きと LAN 用の 2 つの名前で出すなら、ホーム画面の名前を分けられます ([watch.md](watch.md#ホーム画面に置く))。
その名前で信頼するネットワークからログインなしで開くなら、名前を `ALLOWED_HOSTS` (か `PWA_NAMES`) に書きます
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
  Nginx Proxy Manager は「Websockets Support」を入れます。nginx は次のように書きます。

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
  先頭に付けます (`paths.ts` の `publicBase`)
