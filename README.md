# denpa

**チューナーを挿して起動すれば、そのまま使える自宅用のテレビ録画サーバ**です。
設定ファイルは1行も書きません。チューナーは種別 (地上波 / 衛星) まで自分で見分け、
PX-Q3U4 などはホストにドライバすら要りません (エージェントのイメージに同梱)。あとは
チューナーの画面でスキャンを押すだけ。Mirakurun や EDCB を別に立てて繋ぐ必要もなく、
それでいて直したいところは全部画面から変えられます。

予約は番組表から押すだけ。CM は自動で飛ばし、ライブも録画もブラウザで字幕・データ放送
つきで観られます。テレビの VLC へ飛ばすことも、落として好きなプレイヤーで観ることも
できます。メディアサーバは置きません。

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

**画面の一覧は [docs/screens.md](docs/screens.md)** (実機の絵。番組表・ルール・チューナー・設定も)。

## しくみ

部品は **チューナーエージェント** (選局) と **denpa** (番組表・予約・録画・エンコード・
配信・ライブ視聴) の2つだけです。

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ ブラウザでそのまま観る
                                                    └─→ テレビの VLC へ飛ばす / 落として好きなプレイヤーで
```

エージェントは**チャンネルを掴んで素のTSを流すだけ**で、番組表を読むのも、局を
選り分けるのも、CMを見つけるのも denpa がやります。録画は CM をチャプターにして
AV1 / H.264 の mkv に焼き、字幕は放送のまま絵で入れます。

## できること

番組表から押すほか、「ルール」にキーワードを登録すれば自動で予約します。
録れたものは自分で CM を見つけて焼き、行を押せばそのまま観られます。

### いま流れているものを観る

**「ライブ」を開くと、放送中のものがそのまま観られます。** 前回見ていた局から
開くので、テレビを点けたときと同じです。

- **放送から 1 秒ほどで観られます。** 止めた所からも見られ、追いつくときは速さを
  選べます。**放送との差はその場で出します** — 隣に置いたテレビとの差なので、
  焼き上がりから回線・手元の貯まりまで全部入りです
  ([docs/stream.md](docs/stream.md#遅延は2つある))
- **焼き方を選べます。** H.264 は**どの端末でも出る**ほう、AV1 は**軽い**ほう (宅外向け)
- **音声も字幕も放送どおり。** 二カ国語や解説放送も選べ、字幕は絵で出るので
  外字も崩れません
- **データ放送も出ます** (d ボタン)。テレビと同じ BML がそのまま動き、指で押せる
  リモコンが右に並びます。地元の天気にするには設定に郵便番号を
  ([docs/stream.md](docs/stream.md#56-データ放送の統合))

### 録画を観る

**録画一覧の行を押すと、その場で再生が始まります。** 別のアプリは要りません。
番組の中身は右に並んで出ます。

- **どこを押しても再生と一時停止**、左右の端を素早く2回で10秒戻す/送る
- **CM は自動で飛ばします** (既定で入)。**CM のコマは1枚も出しません。** 送りのボタンで手で飛ばすこともできます
- **字幕・倍速 (1〜2倍)・切り抜き** (いまの場面を字幕ごとクリップボードへ)
- **続きから始まります。** 別の端末で開いても続きます。観終わったその場で消せます

**テレビ (Android TV / Fire TV) で観るときは、テレビの VLC に飛ばします。**
VLC のリモートアクセスを有効にしてテレビを設定に登録すると、録画詳細の
「テレビで再生」から**いま開いている端末が**テレビへ直接飛ばします
(初回だけ、証明書を受け入れてテレビに出る6桁コードでペアリング)。
AV1 が再生できないテレビには、テレビごとに H.264 や生TSを渡せます。

**それ以外のプレイヤーには「再生リンクをコピー」で。** 24時間で切れる URL なので、
どのプレイヤーにでも貼れます。字幕は入れ物の中に入っているのでそのまま出ます
([docs/library.md](docs/library.md#手元のプレイヤーで観る))。

## 用意するもの

- **チューナー** — 次のどれでも、刺さっていれば自分で見つけます
  - Linux DVB の機材 (PT2/PT3、PX-S1UD など)。ドライバはホスト側に入れておく
  - **px4-userland の対応機種** (PLEX PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系など)。
    ドライバはエージェントのイメージに同梱で、**ホストには何も入れない**
    ([docs/agent.md](docs/agent.md#px-q3u4-などは-px4-userland-でカーネルドライバは入れてもらわない))
  - PX-S1UD はホストで smsusb を blacklist すれば、同梱の siano-userland でやはりホストに何も要らない
    ([docs/agent.md](docs/agent.md#px-s1ud-はカーネルが掴んでいなければ-siano-userland-で))
- **B-CASカード** と PC/SC 対応のリーダー
- **Docker** (Compose) か **Kubernetes** (Helm)。**amd64 (x86_64) と arm64 (aarch64)** の
  どちらでも動きます (イメージは両方を束ねてあり、同じタグで自分の arch のものが降ってくる)
  (**Apple Silicon の Mac** でも、[下の1行](#立てる)でエージェントと denpa が立ち上がります。
  [docs/agent.md](docs/agent.md#mac-でチューナーを使う))
- あれば **Intel の GPU** — `/dev/dri` が見えれば起動時に見つけて GPU で焼きます
  (Helm は既定で渡す。無ければソフトウェア。[docs/encode.md](docs/encode.md)「GPU で焼く」)。
  **Intel QSV は amd64 だけ**で、arm64 は VA-API かソフトウェアで焼きます

## 立てる

**Linux でも Mac でも、この1行で立ち上がってブラウザが開きます。** イメージは公開してあるので、
リポジトリを持ってくる必要はありません。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
```

- **Linux** (amd64 / arm64) — 全部 Docker Compose。`~/denpa` に compose.prod.yml を置いて起こします
- **Mac** (Apple Silicon) — チューナーに触るエージェントは Mac の上でそのまま、denpa 本体は Docker で
  ([docs/agent.md](docs/agent.md#mac-でチューナーを使う))
- **Docker は入れません。** 無ければ入れ方を言って止まります (Linux は <https://get.docker.com>、
  Mac は Docker Desktop か OrbStack)
- もう一度流せば最新のリリースへ上げ直し。`… | bash -s -- --uninstall` で止めて外します
  (録画・DB・設定は残す)。ブラウザを開かないなら `--no-open`

### Docker Compose を手で置く

```sh
mkdir denpa && cd denpa
curl -Lo compose.yml https://raw.githubusercontent.com/danything/denpa/main/compose.prod.yml
docker compose up -d
```

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

チューナーの刺さった機械にはエージェントだけ置き、本体は別の所 (別ノードや
docker compose) で動かす構成なら `oci://ghcr.io/danything/charts/denpa-agent` を
(本体側は `TUNER_AGENT_URL` でそこを指す)。**値の一覧と意味は
[charts/denpa/values.yaml](charts/denpa/values.yaml)** に全部コメントで書いてあります。

### 立てたあと

1. **開く** — <http://localhost:3000>。compose.yml の `TRUSTED_NETWORKS` には**家の中
   (プライベートネットワーク) だけ通す**初期値が書いてあります (Helm は `denpa.trustedNetworks`。
   変えるときは下の「[誰を通すか](#誰を通すか)」を読むこと)
2. **チューナーを確かめる** — 「チューナー」に、見つかったものが並んでいます。
   本数と種別 (地上波 / 衛星) が合っていれば、そのまま次へ
3. **スキャンする** — 同じ画面から。チャンネルは空で出荷しているので、これをやるまで
   番組表も空です。地上波の総当たりで**十数分**
4. **待つ** — 終われば自分で番組表を集めに行きます (**数分**)
5. **予約する** — 番組表から選ぶか、「ルール」にキーワードを登録して自動で

**うまくいかないときも「チューナー」の画面**を見てください — エージェントとカード
リーダーの状態、スキャンの結果、番組表の集まり具合が出ます。**カードリーダーが NG の
まま録ると、成功したように見えて中身がスクランブルされたまま**になります。

イメージは `latest` を指していて、リリースのたびに動きます。**版を固定したいなら `1.20.0` の
ように書けます** ([docs/architecture.md](docs/architecture.md#イメージのタグ))。

## 誰を通すか

**入る道を設定するまで、全部のアクセスを断ります** (理由つきの 403)。
入る道は2つで、どちらか (または両方) を設定します:

- **`TRUSTED_NETWORKS`** — このネットワークから来た人は何も聞かずに通します
  (例 `TRUSTED_NETWORKS=192.168.1.0/24`。テレビの VLC に資格情報を入れずに
  使わせるのもこれ)。**全部のアクセスを許可するなら `TRUSTED_NETWORKS=0.0.0.0/0`**
- **OIDC** — 画面をログインで守ります。`OIDC_ISSUER` など3つ渡すと有効になります

**公開するときの注意:**

- **`0.0.0.0/0` はインターネットに向けて開くのと同じ意味です。** 録画も設定も
  誰でも触れます。家の外に出す構成では使わず、OIDC を設定してください
- **リバースプロキシの後ろに置くなら `ADDRESS_HEADER=x-forwarded-for` を。**
  無いと接続元が全部プロキシの住所になり、`TRUSTED_NETWORKS` が誰にも当たりません
  (プロキシが無ければ何も要りません)。逆に、**プロキシを通さず直接届く経路があると
  このヘッダは詐称できる**ので、denpa へは前段経由でしか届かないことを確かめてから
- 録画の再生・ダウンロードのリンクは期限付きURL (発行から24時間で失効。作り直すと同じURLのまま延びる)
  なので、リンク単体が漏れても恒久の入口にはなりません

いずれも入れ方・理由は [docs/auth.md](docs/auth.md) に。

## 確かめきれていないこと (情報を募っています)

**手元の機材では当てられていないところです。** 動いた/動かなかったを
[Issue](https://github.com/danything/denpa/issues) で教えてもらえると、ここを埋められます。

- **px4-userland の機材 (PX-Q3U4 など) での選局と内蔵カードリーダー** (同梱の px4-userland に任せる作りですが、
  手元に筐体が無く、実機に当てていません)
- **PX-S1UD を siano-userland で掴んだときの選局** (smsusb を blacklist した場合。同梱の siano-ts に
  任せる作りですが、実機に当てていません)
- **ロゴより強い「動かない縁」が隅にある録画で、ロゴの在り処の割り出しが外れないか。**
  4局9本で測り、ロゴと縁を取り合っている回は言い切らずに自動検出へ回すように
  しました (本番と同じ取り方で外れ 10/72 → 0)。ただ、**縁のほうが強く大きいと
  止まりません**。TOKYO MX1 で窓枠を掴んだ回の録画は残っておらず、閾値を決めた
  テレ東の録画でも測り直せていません
  ([docs/encode.md](docs/encode.md#言い切れないときは出さない))
- **受信が途中で欠けた録画で、CMの境目がずれないか。** CM検出は映像のコマを数えて
  `番号 ÷ fps` で秒に直すので、途中でコマが抜けるとそこから先がずれるはずです。
  突き合わせた9本 (4局・70箇所) には欠けが無く、当てられていません
  ([docs/encode.md](docs/encode.md#チャプターを詰める量は-ss-と同じではない))

## もっと詳しく

- [docs/architecture.md](docs/architecture.md) — **なぜこの形なのか** (決めたこと・踏んだ落とし穴)
- [docs/app.md](docs/app.md) — **どこに何があるか** (ファイル・環境変数・画面・状態遷移)
- [docs/data.md](docs/data.md) — エージェントに都度聞くもの / denpa が持つもの
- [docs/development.md](docs/development.md) — **手を入れるとき** (開発環境・テスト)
- [docs/player.md](docs/player.md) — ホーム画面に置く、LAN でも https で開く
- [docs/agent.md](docs/agent.md) — チューナーを掴むところ (エージェント・取り合い・B-CAS)
- [docs/encode.md](docs/encode.md) — CM とエンコード (字幕・AV1・CM検出)
- [docs/logo.md](docs/logo.md) — 局ロゴ (番組表の PNG と CM検出用の `.lgd`)
- [docs/library.md](docs/library.md) — 録画の置き場と配り方 (テレビの VLC・再生リンク・削除・通知)
- [docs/offline.md](docs/offline.md) — 端末に落として電波の無いところで観る
- [docs/auth.md](docs/auth.md) — **誰を通すか** (OIDC でのログイン・信頼したネットワーク・期限付きのリンク)
- [docs/migrate.md](docs/migrate.md) — **EPGStation からの引き継ぎ**
- [docs/stream.md](docs/stream.md) — **ライブ視聴** (放送中のものを観る)

## 謝辞

**手を入れてくれた人** (ありがとうございます):

- [@Khronos31](https://github.com/Khronos31) — px4-userland / siano-userland で選局できなかったのを、PX-Q3U4 の実機で見つけて直してくれました (#188)

**denpa が乗っている仕事** — とくにチューナーまわりは、次の方々の仕事の上に立っています:

- [px4-userland](https://github.com/Khronos31/px4-userland) / [siano-userland](https://github.com/Khronos31/siano-userland) (@Khronos31) — PX-Q3U4 などと PX-S1UD を、ホストにドライバを入れずに使えるのはこれのおかげです。PX-MLT5PE / DTV02A-5TS-P の対応は @siketyan
- [join_logo_scp](https://github.com/yobibi/join_logo_scp) (yobibi) と chapter_exe / logoframe (tobitti0 版) — CM 検出
- [web-bml](https://github.com/otya128/web-bml) (otya128) — データ放送を描く

ほかに借りているものと出どころは [docs/licenses.md](docs/licenses.md) にあります。

## ライセンス

**AGPL-3.0-or-later** ([LICENSE](LICENSE))。denpa は**自分の家に置いて、外から使う**
ものです。ネットワーク越しに使わせる形で配るなら、そのときの中身も同じ条件で
渡せるようにしてほしい、という選び方です。

借りているものは出どころのままです。主なもの:

| | ライセンス |
| --- | --- |
| **ffmpeg** (x264 / SVT-AV1 / dav1d / Opus / libaribcaption / libva / libvpl を繋いだ自前ビルド) | GPL-2.0+ (x264 のため) ほか BSD / MIT |
| **CM 検出** — join_logo_scp・chapter_exe・logoframe・dtvindex | GPL-3.0 (join_logo_scp は正式なライセンス文書無し。「転載・改変は連絡不要」の表示に拠る) |
| **rounded-mplus-1m-arib** (字幕とデータ放送のフォント) | M+ FONT LICENSE (無制限) |
| **web-bml / es2** (npm の `web-bml`。データ放送を描く) | MIT |
| **Svelte / SvelteKit / Tailwind / daisyUI** と束に入る npm 一式 | MIT (crc-32 は Apache-2.0、ieee754 は BSD-3) |
| [patches/](patches) — ffmpeg に当てている直し (上流に投げる前提) | 当てる先と同じ |

**全部の一覧 (出どころ・何に使っているか・根拠) は [docs/licenses.md](docs/licenses.md)。**
