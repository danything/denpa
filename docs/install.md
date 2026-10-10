# 立てる

用意するもの、入れ方 (1行・Compose・1コンテナ・Helm)、立てたあとの手順、前段 (リバースプロキシ) の後ろに置くとき。
Mac と Windows の入れ方の中身は [agent.md](agent.md#mac-でチューナーを使う) に。

## 用意するもの

- **チューナー** — 挿してあれば自動で見つけ、種別 (地上波 / 衛星) も見分けます
  - Linux DVB の機材 (PT2/PT3、PX-BCUD、PX-S1UD など)。ドライバはホストに入れておく
  - **px4-userland の対応機種** (PLEX PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系など)。
    ドライバはエージェントのイメージに入っているので、ホストには何も入れない
    ([agent.md](agent.md#px-q3u4-などは-px4-userland-でカーネルドライバは入れてもらわない))
  - PX-S1UD はホストで smsusb を blacklist しておけば、同梱の siano-userland で動く (ホストにドライバは要らない)
    ([agent.md](agent.md#px-s1ud-はカーネルが掴んでいなければ-siano-userland-で))
  - PX-W3U3 は **試験的** に asicen-userland で受ける用意だけある。上流のリリース待ちで、まだイメージに入らない
    ([agent.md](agent.md#px-w3u3-は-asicen-userland-で-試験的上流のリリース待ち))
- **B-CASカード** と PC/SC 対応のカードリーダー (px4-userland の機材は内蔵リーダーでもよい)
- **Docker** (Compose) か **Kubernetes** (Helm)。amd64 と arm64 のどちらでも動きます
  (イメージは両方を同じタグにまとめてある)。Apple Silicon の Mac と x64 の Windows でも、[1行](#1行で入れる)で立ちます
- あれば **Intel の GPU** — `/dev/dri` が見えれば起動時に見つけて GPU で焼き、無ければソフトウェアで焼きます
  (Helm は既定で渡す)。QSV は amd64 だけで、arm64 は VA-API かソフトウェア ([encode.md](encode.md#gpu-で焼く-intel-qsv--va-api))

## 1行で入れる

**イメージは公開してあるので、clone は要りません。** 立ち上がるとブラウザが開きます。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex   # Windows (x64)
```

- **Linux** (amd64 / arm64) — 全部 Docker Compose。`~/denpa` に compose.prod.yml を `compose.yml` として置いて起動します
- **Mac** (Apple Silicon) — エージェントは Mac の上で直接、denpa 本体は Docker ([agent.md](agent.md#mac-でチューナーを使う))
- **Windows** (x64) — エージェントは Windows の上で直接、denpa 本体は WSL のコンテナ (`wslc`)。Docker Desktop は要りません。
  チューナーは siano-userland の機材 (PX-S1UD など) だけ ([agent.md](agent.md#windows-でチューナーを使う))
- **Docker・WSL は入れません。** 無ければ入れ方を示して止まります (Linux は <https://get.docker.com>、
  Mac は Docker Desktop か OrbStack、Windows は `wsl --update`)
- **入口は [genkan](https://github.com/danything/genkan)** (ホスト名で振り分けるリバースプロキシ。Linux・Mac)。
  動いていればそれを使い、無ければ 80 と 443 が空いているときだけ `~/genkan` に入れて <http://denpa.localhost> で開きます。
  入れられなければ <http://localhost:3000>。`denpa.localhost` はそのマシンでしか引けないので、LAN のほかの機器
  (テレビ・スマホ) からは `http://<IP>:3000` で開きます。Windows はいつも <http://localhost:3000>
- 置き場は `~/denpa` (`DENPA_HOME`)。`compose.yml` は更新のたびに上書きするので、
  **変えたいことは同じ場所の `compose.override.yml` に書きます** (Compose が重ねて読み、install.sh は触らない)。
  Windows は `~/denpa/denpa.env`
- もう一度流すと最新のリリースに上がります。`… | bash -s -- --uninstall` で止めて外します
  (`~/denpa`・録画・DB は残す)。ブラウザを開かないなら `--no-open`。Windows は `-Uninstall` / `-NoOpen`
  (渡し方は install.ps1 の頭)

### Docker Compose を手で置く

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
  -e TRUSTED_NETWORKS=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12 \
  -v ./config:/config -v denpa-data:/data -v denpa-media:/media \
  -p 3000:3000 ghcr.io/danything/denpa-aio:latest
```

- エージェントの設定 (`tuners.json` / `channels.json`) は `/config`、DB は `/data`、録画は `/media` の下
  (生TS は `raw`、焼いたものは `encoded`)。前の版から上げるときは [app.md](app.md#置き場を変えた-前の版から上げるとき)
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

`latest` はリリースのたびに新しくなります。版を固定するなら `1.20.0` のように書きます
([architecture.md](architecture.md#イメージのタグ))。

## 立てたあと

1. **開く** — <http://denpa.localhost> (genkan を入れたとき) か <http://localhost:3000>。
   compose の `TRUSTED_NETWORKS` (Helm は `denpa.trustedNetworks`) の初期値は家の中 (私設網) だけを通す値です。
   変えるときは [auth.md](auth.md)
2. **チューナーを確かめる** — 「チューナー」の画面に、見つかったものの本数と種別 (地上波 / 衛星) が並びます
3. **スキャンする** — 同じ画面から。BS と CS は全国で同じなので、衛星を受けられるチューナーがあれば
   最初から局が入っています。地上波はスキャンするまで番組表も空です (総当たりで十数分)
4. **待つ** — スキャンが終わると番組表を自動で集めます (数分)
5. **予約する** — 番組表から選ぶか、「ルール」にキーワードを登録して自動で

うまくいかないときも「チューナー」の画面を見ます。エージェントとカードリーダーの状態、スキャンの結果、
番組表の集まり具合が出ます。**カードリーダーが NG のまま録ると、成功したように見えても中身はスクランブルされたままです。**

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
  再生リンクや OIDC に渡す絶対 URL にだけ、前段が付ける `X-Forwarded-Prefix` (Home Assistant は `X-Ingress-Path`) を
  頭に付けます (`paths.ts` の `publicBase`)
