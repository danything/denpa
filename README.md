# denpa

テレビを録って観るためのもの。**チューナーエージェント(選局)** と
**denpa(番組表・予約・録画・エンコード・配信・ライブ視聴)** の2つだけで、
メディアサーバは置きません。

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ ブラウザでそのまま観る
                                                    └─→ テレビの VLC へ飛ばす / 落として好きなプレイヤーで
```

エージェントは**チャンネルを掴んで素のTSを流すだけ**です。番組表を読むのも、
局を選り分けるのも、CMを見つけるのも denpa がやります。

<p align="center">
  <img src="docs/images/guide-anim.webp" alt="番組表から予約する" width="720">
</p>

番組表から押すだけで予約。録った番組はブラウザでそのまま観るか、テレビの VLC へ
飛ばすか、落として好きなプレイヤーで。**画面の一覧は [docs/screens.md](docs/screens.md)。**

## 用意するもの

- **チューナー** — Linux DVB (PT2/PT3、PX-S1UD など)。ドライバはホスト側に入れておく
- **B-CASカード** と PC/SC 対応のリーダー
- **Docker** (Compose) か **Kubernetes** (Helm)

## 立てる

**Docker Compose** か **Helm** のどちらか。イメージは公開してあるので、
リポジトリを持ってくる必要はありません。

### Docker Compose

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
  --set ingress.enabled=true --set 'ingress.hosts[0]=denpa.example.home'
```

チューナーの刺さった機械にはエージェントだけ置き、本体は別の所 (別ノードや
docker compose) で動かす構成なら `oci://ghcr.io/danything/charts/denpa-agent` を
(本体側は `TUNER_AGENT_URL` でそこを指す)。**値の一覧と意味は
[charts/denpa/values.yaml](charts/denpa/values.yaml)** に全部コメントで書いてあります。

### 立てたあと

1. **開く** — <http://localhost:3000>。誰を通すかは `TRUSTED_NETWORKS` で決めます —
   compose.yml には**家の中 (プライベートネットワーク) だけ通す**初期値が書いてあります
   (Helm は `denpa.trustedNetworks`)。設定を消すと全部のアクセスを断り、全部開けるなら
   `0.0.0.0/0` (下の「誰を通すか」の注意を読むこと)
2. **チューナーを確かめる** — 「チューナー」に、見つかったものが並んでいます。
   本数と種別 (地上波 / 衛星) が合っていれば、そのまま次へ
3. **スキャンする** — 同じ画面から。チャンネルは空で出荷しているので、これをやるまで
   番組表も空です。地上波の総当たりで**十数分**
4. **待つ** — 終われば自分で番組表を集めに行きます (**数分**)
5. **予約する** — 番組表から選ぶか、「ルール」にキーワードを登録して自動で

**設定ファイルを書く必要はありません。** チューナーは自動で見つけて種別まで判別し、
直すところがあっても「チューナー」の画面から書けます。**うまくいかないときも同じ画面**
を見てください — エージェントとカードリーダーの状態、スキャンの結果、番組表の集まり
具合が出ます。**カードリーダーが NG のまま録ると、成功したように見えて中身が
スクランブルされたまま**になります。

指しているのは `latest` で、リリースのたびに動きます。**版を固定したいなら `0.9.5` の
ように書けます** ([docs/architecture.md](docs/architecture.md#像のタグ))。

## いま流れているものを観る

**「ライブ」を開くと、放送中のものがそのまま観られます。** 前回見ていた局から
開くので、テレビを点けたときと同じです。

- **遅延は 0.5〜0.7 秒。** 止めた所からも見られ、追いつくときは速さを選べます
- **焼き方を選べます。** H.264 は**どの端末でも出る**ほう、AV1 は**軽い**ほう (宅外向け)
- **音声も字幕も放送どおり。** 二カ国語や解説放送も選べ、字幕は絵で出るので
  外字も崩れません
- **データ放送も出ます** (d ボタン)。テレビと同じ BML がそのまま動き、指で押せる
  リモコンが右に並びます。地元の天気にするには設定に郵便番号を
  ([docs/stream.md](docs/stream.md#56-データ放送の統合))

## 録画を観る

**録画一覧の行を押すと、その場で再生が始まります。** 別のアプリは要りません。
番組の中身は右に並んで出ます。

- **どこを押しても再生と一時停止**、左右の端を素早く2回で10秒戻す/送る
- **CM 飛ばし。** CM はチャプターで入っているので、送りのボタンで飛ばせます
- **字幕・倍速 (1〜2倍)・切り抜き** (いまの場面を字幕ごとクリップボードへ)
- **続きから始まります。** 別の端末で開いても続きます。観終わったその場で消せます

**テレビ (Android TV / Fire TV) で観るときは、テレビの VLC に飛ばします。**
VLC のリモートアクセスを有効にしてテレビを設定に登録すると、録画詳細の
「テレビで再生」から**いま開いている端末が**テレビへ直接飛ばします
(初回だけ、証明書を受け入れてテレビに出る6桁コードでペアリング)。
AV1 が再生できないテレビには、テレビごとに H.264 や生TSを渡せます。「再生リンクをコピー」(24時間で切れるURL) で、どのプレイヤーに
でも貼れます。字幕は入れ物の中に入っているのでそのまま出ます
([docs/library.md](docs/library.md#手元のプレイヤーで観る))。

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
  無いと接続元が全部プロキシの住所になり、`TRUSTED_NETWORKS` が誰にも当たりません。
  逆に、**プロキシを通さず直接届く経路があるとこのヘッダは詐称できる**ので、
  denpa へは前段経由でしか届かないことを確かめてから設定します
- 録画の再生・ダウンロードのリンクは期限付きURL (使わなくなって24時間で失効)
  なので、リンク単体が漏れても恒久の入口にはなりません

いずれも入れ方・理由は [docs/auth.md](docs/auth.md) に。

## 確かめきれていないこと (情報を募っています)

**手元の機材では当てられていないところです。** 動いた/動かなかったを
[Issue](https://github.com/danything/denpa/issues) で教えてもらえると、ここを埋められます。

- **`px4_drv` を chardev (`/dev/px4video*`) で使うチューナーでの選局** (コードは
  ありますが、値は資料から取ったものです)
- **CM検出がどれくらい当たるか**の集計と、**局ロゴの学習に要る最短の尺**

## もっと詳しく

- [docs/screens.md](docs/screens.md) — **画面の一覧** (実機の絵)
- [docs/architecture.md](docs/architecture.md) — **なぜこの形なのか** (決めたこと・踏んだ落とし穴)
- [docs/app.md](docs/app.md) — **どこに何があるか** (ファイル・環境変数・画面・状態遷移)
- [docs/data.md](docs/data.md) — エージェントに都度聞くもの / denpa が持つもの
- [docs/development.md](docs/development.md) — **手を入れるとき** (開発環境・テスト)
- [docs/player.md](docs/player.md) — ホーム画面に置く、LAN でも https で開く
- [docs/agent.md](docs/agent.md) — チューナーを掴むところ (エージェント・取り合い・B-CAS)
- [docs/encode.md](docs/encode.md) — CM とエンコード (字幕・AV1・CM検出)
- [docs/auth.md](docs/auth.md) — **誰を通すか** (OIDC でのログイン・信頼したネットワーク・署名リンク)
- [docs/migrate.md](docs/migrate.md) — **EPGStation からの引き継ぎ**
- [docs/stream.md](docs/stream.md) — **ライブ視聴** (放送中のものを観る)

## ライセンス

**AGPL-3.0-or-later** ([LICENSE](LICENSE))。denpa は**自分の家に置いて、外から使う**
ものです。ネットワーク越しに使わせる形で配るなら、そのときの中身も同じ条件で
渡せるようにしてほしい、という選び方です。

抱えているものは出どころのままです:

| | |
| --- | --- |
| [src/lib/vendor/web-bml](src/lib/vendor/web-bml) | MIT ([LICENSE](src/lib/vendor/web-bml/LICENSE))。データ放送を描くところ |
| [patches/](patches) | ffmpeg に当てている直し。**上流に投げるつもりのものだけ** (LGPL/GPL) |
| 像に入れるもの | ffmpeg (GPL)・libaribcaption (MIT)・join_logo_scp 一式・`rounded-mplus-1m-arib` (SIL OFL)。焼き方は [Dockerfile](Dockerfile) に |
