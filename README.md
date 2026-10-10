# denpa

**チューナーを挿して起動すれば、そのまま使える自宅用のテレビ録画サーバ**です。
設定ファイルは1行も書きません。チューナーは種別 (地上波 / 衛星) まで自動で見分けます。
PX-Q3U4 などはドライバがエージェントのイメージに入っているので、ホストには何も入れません。
あとはチューナーの画面でスキャンを押すだけです。Mirakurun や EDCB を別に立てる必要はなく、
変えたい設定は全部画面から変えられます。

予約は番組表から押すだけ。CM は自動で飛ばし、ライブも録画もブラウザで字幕・データ放送
つきで観られます。テレビは専用のアプリ ([denpa-tv](https://github.com/danything/denpa-tv)) で、
落として好きなプレイヤーで観ることもできます。メディアサーバも要りません。

<p align="center">
  <img src="docs/images/home-watch-anim.webp" alt="録画の行を押すと、そのまま観る画面へ" width="720">
</p>

<table>
  <tr>
    <td align="center"><a href="docs/screens.md#予約と録画"><img src="docs/images/dashboard.webp" alt="予約と録画" width="380"></a><br><sub><b>予約と録画</b> — サムネ付き。押せばその場で観る</sub></td>
    <td align="center"><a href="docs/screens.md#ライブ"><img src="docs/images/live.webp" alt="ライブ" width="380"></a><br><sub><b>ライブ</b> — 字幕もデータ放送も。止めれば追っかけ</sub></td>
    <td align="center"><a href="docs/screens.md#録画を観る"><img src="docs/images/watch.webp" alt="録画を観る" width="380"></a><br><sub><b>観る</b> — 放送どおりの字幕、CMは自動で飛ばす</sub></td>
  </tr>
</table>

画面の一覧は [docs/screens.md](docs/screens.md) にあります (実機の画面。番組表・ルール・チューナー・設定も)。

## しくみ

部品は **チューナーエージェント** (選局) と **denpa** (番組表・予約・録画・エンコード・
配信・ライブ視聴) の2つだけです。

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ ブラウザでそのまま観る
                                                    └─→ テレビのアプリ (denpa-tv) / 落として好きなプレイヤーで
```

エージェントは**チャンネルを掴んで素のTSを流すだけ**です。番組表を読むのも、局を
選り分けるのも、CMを見つけるのも denpa がやります。録画は CM をチャプターにして
AV1 / H.264 の mkv に焼き、字幕は放送のまま絵で入れます。

## できること

番組表から押すほか、「ルール」にキーワードを登録すれば自動で予約します。
録画は CM を自動で見つけてから焼き、行を押せばそのまま観られます。

### いま流れているものを観る

**「ライブ」を開くと、放送中のものがそのまま観られます。** 前回見ていた局から
開くので、テレビを点けたときと同じです。

- **放送から 1 秒ほどで観られます。** 止めた所から続きを観られ、追いつくときの速さも
  選べます。放送との差は画面に出します。隣に置いたテレビとの差にあたる値で、
  焼く時間から回線・手元のバッファまで全部含みます
  ([docs/stream.md](docs/stream.md#遅延は2つある))
- **焼き方を選べます。** H.264 はどの端末でも再生でき、AV1 は軽い (宅外向け)
- **音声も字幕も放送どおり。** 二カ国語や解説放送も選べ、字幕は絵で出るので
  外字も崩れません
- **データ放送も出ます** (d ボタン)。テレビと同じ BML がそのまま動き、指で押せる
  リモコンが右に並びます。地元の天気を出すには、設定に郵便番号を入れます
  ([docs/stream.md](docs/stream.md#56-データ放送の統合))

### 録画を観る

**録画一覧の行を押すと、その場で再生が始まります。** 別のアプリは要りません。
番組の中身は右に並んで出ます。

- **マウスはどこを押しても再生/一時停止** (指は1回で操作列の出し入れ)。左右の端をすばやく2回押すと10秒戻す/送る
- **CM は自動で飛ばします** (既定で入)。CM のコマは1枚も出しません。送りボタンで手動でも飛ばせます
- **字幕・倍速 (1〜2倍)・切り抜き** (いまの場面を字幕ごと PNG に。スマホは共有シートから写真へ、PC は保存してクリップボードにも)
- **続きから再生します。** 別の端末で開いても続きから。観終わったらその場で消せます

**テレビ (Android TV / Fire TV) では、専用のアプリ [denpa-tv](https://github.com/danything/denpa-tv) で観ます。**
ライブと録画、続きから・CM 飛ばし・低遅延のライブ。テレビに出る QR をスマホで読めば繋がります
(家の外からは OIDC でログインして、アプリの鍵を発行)。

**ほかのプレイヤーでは「再生リンクをコピー」を使います。** 24時間有効の URL で、
どのプレイヤーにも貼れます。字幕は mkv の中に入っているのでそのまま出ます
([docs/library.md](docs/library.md#手元のプレイヤーで観る))。

## 用意するもの

- **チューナー** — 次のどれでも、挿してあれば自動で見つけます
  - Linux DVB の機材 (PT2/PT3、PX-S1UD など)。ドライバはホストに入れておく
  - **px4-userland の対応機種** (PLEX PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系など)。
    ドライバはエージェントのイメージに入っているので、ホストには何も入れない
    ([docs/agent.md](docs/agent.md#px-q3u4-などは-px4-userland-でカーネルドライバは入れてもらわない))
  - PX-S1UD も、ホストで smsusb を blacklist しておけば同梱の siano-userland で動き、ホストにドライバは要らない
    ([docs/agent.md](docs/agent.md#px-s1ud-はカーネルが掴んでいなければ-siano-userland-で))
- **B-CASカード** と PC/SC 対応のカードリーダー
- **Docker** (Compose) か **Kubernetes** (Helm)。amd64 (x86_64) と arm64 (aarch64) の
  どちらでも動きます。イメージは両方を同じタグにまとめてあり、自分のアーキテクチャのものが降ってきます。
  Apple Silicon の Mac と x64 の Windows でも、[下の1行](#立てる)でエージェントと denpa が立ち上がります
  ([docs/agent.md](docs/agent.md#mac-でチューナーを使う))
- あれば **Intel の GPU** — `/dev/dri` が見えれば起動時に見つけて GPU で焼き、無ければソフトウェアで焼きます
  (Helm は既定で渡す。[docs/encode.md](docs/encode.md#gpu-で焼く-intel-qsv--va-api))。
  Intel QSV は amd64 だけで、arm64 は VA-API かソフトウェアです

## 立てる

**Linux でも Mac でも、この1行で立ち上がってブラウザが開きます。** イメージは公開してあるので、
リポジトリの clone は要りません。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
```

- **Linux** (amd64 / arm64) — 全部 Docker Compose で動かします。`~/denpa` に compose.prod.yml を置いて起動します
- **Mac** (Apple Silicon) — チューナーに触るエージェントは Mac の上で直接、denpa 本体は Docker で動かします
  ([docs/agent.md](docs/agent.md#mac-でチューナーを使う))
- **Windows** (x64) は PowerShell で `irm https://raw.githubusercontent.com/danything/denpa/main/install.ps1 | iex`。
  エージェントは Windows の上で直接、denpa 本体は WSL のコンテナ (`wslc`) で動かします。**Docker Desktop は要りません**
  (`wsl --update` で入る)。チューナーは PX-S1UD など siano-userland の機材だけで、ドライバを WinUSB にします
  ([docs/agent.md](docs/agent.md#windows-でチューナーを使う))
- **Docker・WSL は入れません。** 無ければ入れ方を示して止まります (Linux は <https://get.docker.com>、
  Mac は Docker Desktop か OrbStack、Windows は `wsl --update`)
- **入口は [genkan](https://github.com/danything/genkan)** (ホスト名で振り分けるリバースプロキシ。Linux・Mac)。
  動いていればそれを使います。無ければ 80 と 443 が空いているときだけ `~/genkan` に入れ、
  <http://denpa.localhost> で開きます。ポートが埋まっていれば入れず、<http://localhost:3000> で開きます。
  `denpa.localhost` はそのマシンでしか開けないので、LAN のほかの機器 (テレビ・スマホ) からは
  `http://<IP>:3000` で開きます
- 置き場は `~/denpa` (`DENPA_HOME`)。Linux・Mac では `compose.yml` を更新のたびに上書きするので、
  **変えたいことは同じ場所の `compose.override.yml` に書きます** (Compose が重ねて読み、install.sh は触らない)
- もう一度流すと最新のリリースに上がります。`… | bash -s -- --uninstall` で止めて外します
  (`~/denpa`・録画・DB は残す)。ブラウザを開かないなら `--no-open`
- Windows は <http://localhost:3000> で開き、変えたい環境変数は `~/denpa/denpa.env` に書きます。
  止めて外すのは `-Uninstall`、ブラウザを開かないなら `-NoOpen` (渡し方は install.ps1 の頭)

### Docker Compose を手で置く

```sh
mkdir denpa && cd denpa
curl -Lo compose.yml https://raw.githubusercontent.com/danything/denpa/main/compose.prod.yml
docker compose up -d
```

### 1つのコンテナで (`denpa-aio`)

本体とチューナーエージェントを1つのコンテナにまとめたイメージもあります。
チューナーを挿した機械でそのまま全部動かすとき (NAS や、ほかの仕組みに載せるとき) 向けです。
中身は上の2つのイメージと同じで、分けるかまとめるかだけが違います。

```sh
docker run -d --name denpa --restart unless-stopped --stop-timeout 21900 \
  --cap-add SYS_RESOURCE \
  --device-cgroup-rule 'c 189:* rmw' --device-cgroup-rule 'c 212:* rmw' \
  -v /dev/bus/usb:/dev/bus/usb -v /dev/dvb:/dev/dvb \
  -e TRUSTED_NETWORKS=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12 \
  -v ./config:/config -v denpa-data:/data -v denpa-media:/media \
  -p 3000:3000 ghcr.io/danything/denpa-aio:latest
```

- 置き場は既定のまま: エージェントの設定 (`tuners.json` / `channels.json`) は `/config`、DB は `/data`、
  録画は `/media` の下 (生TS は `raw`、焼いたものは `encoded`)。前の版から上げるときは
  [docs/app.md](docs/app.md#置き場を変えた-前の版から上げるとき) を見る
- `--privileged` は要りません。USB (189) と DVB (212) のデバイスを開く許可と、pipe を広げる
  `SYS_RESOURCE` だけ渡します。デバイスはディレクトリごと見せるので、挿し直しても再起動は要りません
- 止めるときは両方に伝え、録画の終わりを待ちます (`--stop-timeout` を長くしておく。compose の `stop_grace_period` と同じ)。
  どちらかが落ちたらコンテナごと終わるので、起こし直しは `--restart` に任せます

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

チューナーを挿した機械にはエージェントだけを置き、本体を別の所 (別ノードや
docker compose) で動かすなら `oci://ghcr.io/danything/charts/denpa-agent` を使います
(本体側は `TUNER_AGENT_URL` でそこを指す)。値の一覧と意味は
[charts/denpa/values.yaml](charts/denpa/values.yaml) にコメントで全部書いてあります。

### 立てたあと

1. **開く** — <http://denpa.localhost> (genkan を入れたとき) か <http://localhost:3000>。
   compose.yml の `TRUSTED_NETWORKS` の初期値は、家の中 (プライベートネットワーク) だけを通す値です
   (Helm は `denpa.trustedNetworks`)。変えるときは下の「[誰を通すか](#誰を通すか)」を読んでください
2. **チューナーを確かめる** — 「チューナー」の画面に、見つかったものが並んでいます。
   本数と種別 (地上波 / 衛星) が合っていれば次へ
3. **スキャンする** — 同じ画面から。BS と CS は全国で同じなので、衛星を受けられる
   チューナーがあれば最初から局が入っています。地上波は地域で違うので、スキャンするまで
   番組表も空です。地上波の総当たりで十数分
4. **待つ** — スキャンが終わると、番組表を自動で集めます (数分)
5. **予約する** — 番組表から選ぶか、「ルール」にキーワードを登録して自動で

うまくいかないときも「チューナー」の画面を見てください。エージェントとカード
リーダーの状態、スキャンの結果、番組表の集まり具合が出ます。**カードリーダーが NG の
まま録画すると、成功したように見えても中身はスクランブルされたままです。**

イメージのタグは `latest` で、リリースのたびに新しくなります。版を固定したいなら `1.20.0` の
ように書きます ([docs/architecture.md](docs/architecture.md#イメージのタグ))。

前段で `/denpa` のような接頭辞の下に置いても動きます (Home Assistant の Ingress など)。
接頭辞は denpa に教えません。再生リンクや OIDC に渡す URL にだけ、前段が付ける
`X-Forwarded-Prefix` (Home Assistant は `X-Ingress-Path`) を頭に付けます。

## 誰を通すか

**通し方を設定するまで、すべてのアクセスを断ります** (理由つきの 403)。
通し方は次の2つで、どちらか (または両方) を設定します。

- **`TRUSTED_NETWORKS`** — このネットワークからのアクセスはログインなしで通します
  (例 `TRUSTED_NETWORKS=192.168.1.0/24`。テレビのアプリやプレイヤーに資格情報を入れずに
  使わせるのもこれ)。すべて許可するなら `TRUSTED_NETWORKS=0.0.0.0/0`
- **OIDC** — 画面をログインで守ります。`OIDC_ISSUER` など3つを渡すと有効になります

**公開するときの注意:**

- **`0.0.0.0/0` はインターネットに向けて開くのと同じです。** 録画も設定も
  誰でも触れます。家の外に出す構成では使わず、OIDC を設定してください
- **リバースプロキシの後ろに置くなら、プロキシのアドレスを `TRUSTED_PROXIES` に設定します**
  (CIDR のカンマ区切り。例 `TRUSTED_PROXIES=172.16.0.0/12` や `TRUSTED_PROXIES=10.42.0.0/16`)。
  ここから来た接続だけ `X-Forwarded-For` を読み、本当の接続元を決めます。無いと接続元がすべて
  プロキシのアドレスになり、`TRUSTED_NETWORKS` が誰にも当たりません (プロキシが無ければ要りません)。
  ほかのアドレスから届いた `X-Forwarded-For` は読まないので、プロキシを通らずに届く経路があっても
  詐称はできません。プロキシを2段重ねるなら両方のアドレスを入れます
- **前の版で `ADDRESS_HEADER=x-forwarded-for` を設定していたなら、`TRUSTED_PROXIES` に置き換えてください。**
  `ADDRESS_HEADER` はもう読みません (起動時に1行知らせます)。置き換えるまでは接続元がプロキシの
  アドレスになり、`TRUSTED_NETWORKS` から来ていた人にもログインを求めるか断ります
  ([docs/app.md](docs/app.md#接続元の読み方を変えた-前の版から上げるとき))
- **リバースプロキシには、`Host` をそのまま渡すことと WebSocket を通すことが要ります。**
  `Host` が書き換わると設定の保存などの POST が `403 Cross-site POST form submissions are forbidden`
  で断られ、WebSocket が通らないとライブが「繋がりませんでした」になります。Caddy・Traefik・
  Envoy (Gateway API) は何もしなくても満たします。nginx は自分で書きます
  (denpa 側には nginx のアドレスを `TRUSTED_PROXIES` に入れておく):

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

  Nginx Proxy Manager は「Websockets Support」を入れてください
- 録画の再生・ダウンロードのリンクは期限付きの URL です (発行から24時間で失効。作り直すと
  同じ URL のまま期限が延びる)。リンクが漏れても、ずっと使える入口にはなりません

設定のしかたと理由は [docs/auth.md](docs/auth.md) にあります。

## 確かめきれていないこと (情報を募っています)

**手元の機材では確かめられていないところです。** 動いた/動かなかったを
[Issue](https://github.com/danything/denpa/issues) で教えてもらえると、ここを埋められます。

- **px4-userland の機材 (PX-Q3U4 など) での選局と内蔵カードリーダー** (同梱の px4-userland に任せていますが、
  手元に実機が無く試せていません)
- **PX-S1UD を siano-userland で掴んだときの選局** (smsusb を blacklist した場合。同梱の siano-ts に
  任せていますが、実機で試せていません)
- **ロゴと同じくらい毎コマ動かない縁が隅にある録画で、ロゴの位置の割り出しが外れないか。**
  実機の 16 本 (12局) では全部ロゴを当てましたが、ロゴか縁か決めきれない回は覚えずに
  無音検出へ落とすだけで、縁のほうを覚えてしまうと防げません (画面で捨てて覚え直す)。
  TOKYO MX1 で窓枠を掴んだ回の録画は残っておらず、試せていません
  ([docs/encode.md](docs/encode.md#在り処の割り出し))

## もっと詳しく

- [docs/architecture.md](docs/architecture.md) — **なぜこの形なのか** (決めたこと・踏んだ落とし穴)
- [docs/app.md](docs/app.md) — **どこに何があるか** (ファイル・環境変数・画面・状態遷移)
- [docs/data.md](docs/data.md) — エージェントに都度聞くもの / denpa が持つもの
- [docs/development.md](docs/development.md) — **手を入れるとき** (開発環境・テスト)
- [docs/player.md](docs/player.md) — ホーム画面に置く、LAN でも https で開く
- [docs/agent.md](docs/agent.md) — チューナーを掴むところ (エージェント・取り合い・B-CAS)
- [docs/encode.md](docs/encode.md) — CM とエンコード (字幕・AV1・CM検出)
- [docs/logo.md](docs/logo.md) — 局ロゴ (番組表の PNG と CM検出用に覚えたロゴ)
- [docs/library.md](docs/library.md) — 録画の置き場と配り方 (テレビのアプリ・再生リンク・削除・通知)
- [docs/offline.md](docs/offline.md) — 端末に落として電波の無いところで観る
- [docs/auth.md](docs/auth.md) — **誰を通すか** (OIDC でのログイン・信頼したネットワーク・期限付きのリンク)
- [docs/migrate.md](docs/migrate.md) — **EPGStation からの引き継ぎ**
- [docs/stream.md](docs/stream.md) — **ライブ視聴** (放送中のものを観る)
- [docs/api.md](docs/api.md) — **外から使う口** (局・録画の一覧、ライブを HTTP で。Home Assistant やスクリプト向け)

## 謝辞

**手を入れてくれた人** (ありがとうございます):

- [@Khronos31](https://github.com/Khronos31) — px4-userland / siano-userland で選局できなかったのを、PX-Q3U4 の実機で見つけて直してくれました (#188)。ほかにも不具合を報告してくれました (#195 #376 #377)
- [@unlimish](https://github.com/unlimish) — ライブ・追っかけ・観る画面に小窓 (PiP) を足してくれました (#431)。非力な機材で複数のライブを観るときの詰まりを実測つきで報告してくれ、ライブを GPU で焼く道ができました (#417)

**土台にしている仕事** — とくにチューナーまわりは、次の方々の仕事に支えられています:

- [px4-userland](https://github.com/Khronos31/px4-userland) / [siano-userland](https://github.com/Khronos31/siano-userland) (@Khronos31) — PX-Q3U4 などと PX-S1UD を、ホストにドライバを入れずに使えるのはこれのおかげです。PX-MLT5PE / DTV02A-5TS-P の対応は @siketyan
- [web-bml](https://github.com/otya128/web-bml) (otya128) — データ放送を描く

ほかに借りているものと出どころは [docs/licenses.md](docs/licenses.md) にあります。

## ライセンス

**AGPL-3.0-or-later** ([LICENSE](LICENSE))。denpa は自分の家に置いて外から使うものなので、
ネットワーク越しに使わせる形で配るなら、その中身も同じ条件で渡せるようにしてほしい、
という理由で選んでいます。

借りているもののライセンスは元のままです。主なもの:

| | ライセンス |
| --- | --- |
| **ffmpeg** (x264 / SVT-AV1 / dav1d / Opus / libaribcaption / libva / libvpl を繋いだ自前ビルド) | GPL-2.0+ (x264 のため) ほか BSD / MIT |
| **rounded-mplus-1m-arib** (字幕とデータ放送のフォント) | M+ FONT LICENSE (無制限) |
| **web-bml / es2** (npm の `web-bml`。データ放送を描く) | MIT |
| **Svelte / SvelteKit / Blades / Bits UI** と束に入る npm 一式 | MIT (drizzle-orm と crc-32 は Apache-2.0) |
| **Lucide** (アイコン。組むときに使うぶんだけ埋め込む) | ISC |
| [patches/](patches) — ffmpeg と libaribcaption に当てている直し (上流に投げる前提) | 当てる先と同じ |

**全部の一覧 (出どころ・何に使っているか・根拠) は [docs/licenses.md](docs/licenses.md)。**
