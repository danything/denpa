# 構成と設計

**「なぜそうしたか」を書く場所。** 迷ったところ、踏んだ落とし穴、選ばなかった案。
全体像 (入れ替え・イメージのタグ・クラスタの前提) はここに置き、機能ごとの話は
それぞれの文書にあります (一覧は [README](../README.md#もっと詳しく))。

コードの置き場や設定名の一覧はここには書きません (app.md・config.md と二重に持つと必ず片方が古くなる。話に要る名前だけ出す)。

## 全体

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ ブラウザでそのまま観る
                                                    └─→ テレビのアプリ (denpa-tv)
```

メディアサーバは置きません。エンコードしたもの (AV1/H.264 + Opus の mkv) はブラウザが
そのまま読むので `/watch` で観られ、テレビのアプリへは denpa がファイルを配ります。
ブラウザが読めない元のTS (MPEG-2) や違うコーデックは、denpa がその場で詰め替え・変換して流すか、
ブラウザが WebAssembly でデコードします ([library.md](library.md#何で観るかはサーバが出せるものから画面が選ぶ))。
外部のプレイヤーには対応しません。

**境界は「電波を受けるところ」と「中身を読むところ」で切ってあります。** エージェントは
チャンネルを選局して素の TS を流すだけで、NIT も SDT も EIT も読みません。局の選り分けも、
番組表の組み立ても、ロゴの取得も denpa です ([agent.md](agent.md))。

## 入れ替えと録画

ArgoCD が同期すると Pod が差し替わります。録画中に来ても困らないように、
**denpa は SIGTERM を受けても録画が終わるまで待ってから止まります**
(`SHUTDOWN_WAIT`、既定6時間)。録画していなければすぐ止まるので、普段の入れ替えは変わりません。

TSは追記で開き、次の起動で `recoverOrphanedRecordings` が続きから録り直すので、
落ちても丸ごとは失いません。それでも待つのは、入れ替わるまでの十数秒は
どうやっても落ちるからです。ArgoCD の同期は待てますが、放送は待ちません。

すぐ入れ替えたいときは `SHUTDOWN_WAIT=0` にすると「落ちて、続きから録り直す」になります。
Kubernetes の `terminationGracePeriodSeconds` と docker compose の
`stop_grace_period` は `SHUTDOWN_WAIT` より長くしておくこと。短いと待っている
途中で SIGKILL されます。

**待っている間も画面は開けます。** ここは2箇所で落ちていました
(実機では、録画中に同期が来て34分間ずっと画面だけ開けなかった)。

1. **adapter が SIGTERM を受けたその場で listen を閉じる** (adapter-bun は `server.stop()`)。
   止まれの合図は `takeOverSignals` でこちらが受け取り、先に入っていた後始末は外します。
   閉じるのは本当に止まる直前 (`process.exit`) だけです。

    **引き取りは1回では足りません。** adapter が合図を登録するのは `build/index.js` の
    いちばん最後で、こちらはその手前 (`hooks.server.ts` はアプリの読み込みで走る) なので、
    最初の引き取りでは外すものがまだ無い。そのままだとプロセスは生きたままポートだけ閉じます。
    入口の `server.js` が `build/index.js` を読み終えたところで、もう一度引き取らせます。
    2度目の合図でも落ちないようにしてあります (`once` で受けていた頃は、2回目のデプロイで録画の途中でも終わっていた)。

2. **Kubernetes は `deletionTimestamp` が付いた Pod を Service から外す。**
   Service に `publishNotReadyAddresses: true` を付けると、止まりかけの Pod にも回ります。
   readinessProbe は無く、`strategy: Recreate` で新旧の Pod が並ぶこともないので、副作用はありません。

### 待っている間も、始まる録画は始めます

始めないでいた頃は、デプロイの最中に始まった番組の頭が **9分42秒ぶん欠けて**いました
(`server/scheduler.ts` に実測)。始めればそのぶん待ちが伸びますが、`SHUTDOWN_WAIT` が歯止めになります。

### エージェントも録画が終わるまで待ちます

TS を流しているのはエージェントなので、そちらが先に消えれば使っていたストリームごと切れます
(実機では、エージェントの Pod を入れ替えただけで30分番組が丸ごと失敗した)。
エージェントも `SHUTDOWN_WAIT` を見て、録画が終わるまで待ちます。番組表・ロゴ・スキャンは
取り直せばいいので待ちません (`use` が `rec` で始まるものが録画)。

**止まれの合図はエージェント自身が受け取ります** (`Program.cs` の `Drain`)。既定の受け取り役に
任せると、その場で Kestrel が開いている応答への書き込みを止めます。`takeOverSignals` と同じ理由です。

### それでも切れたときは取り直します

電源やネットワークで切れることはあります。読んでいる最中に例外が飛んだときも、EOF と同じように取り直して
終了時刻まで録り続けます (`recorder.ts`)。TSは追記なので、落ちるのは切れていた数秒だけです。

### 隙間はイメージの取得時間だった

新旧の Pod を並べられないので、入れ替えの隙間はどうやっても空きます。実機で測ると、
ほとんどがイメージの取得 (13.6秒) でした。そこで、マニフェストを当てる前にイメージだけ引いておく Job を
ArgoCD の PreSync フックに置いています (`denpa-prepull`。土台は distroless で `/bin/true` も無いので、
`bun --version` で終わる)。隙間は起動そのものだけになります。

### 録画そのものは引き継がない

引き継ぐには新旧のPodが同時にいる必要がありますが、denpa は1つのSQLiteに書き、スケジューラもEPG取得も
エンコード待ち行列も抱えているので、2つ動くと全部が二重になります。
録画をエージェント側に持たせれば denpa の入れ替えと録画が切り離れますが、
番組追従・スクランブルの復号・保存名の付け方まであちらへ移すことになり、
「エージェントは中身を読まない」という切り分けが崩れます。**この方式は選びません。**

### イメージのタグ

| タグ         | いつ動くか                                             | 誰が指しているか                                                                           |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `develop`    | main へ入るたび                                        | `deploy/application.yaml` の `helm.valuesObject` (この構成。入れ替えの合図は `imageMarks`) |
| `latest`     | GitHub でリリースを作ったときだけ                      | `compose.prod.yml` (入れて使う人)                                                          |
| `1.20`       | その系列でリリースを作るたび (1.20.1 を出せばそちらへ) | 版を決めて使う人                                                                           |
| `1.20.0`     | 動かない                                               | 固定して使う人・戻したいとき                                                               |
| `sha-<12桁>` | 動かない。中身ごとに1つ                                | 中身のコミットから辿るとき                                                                 |

**どのタグも amd64 と arm64 を束ねた索引 (multi-arch manifest) を指します。** CI は
arch ごとにその arch のランナー (amd64 は `ubuntu-latest`、arm64 は `ubuntu-24.04-arm`) で
組んで digest だけで push し、最後に両方を束ねた索引へ名前を付けます
(`.github/workflows/build-and-deploy.yml`)。QEMU で arm64 を組むと ffmpeg と Native AOT が
何倍も掛かるので使いません。片方の arch が落ちたら名前は付けません (片方だけの
`develop` が出ていくより、前のものが残るほうがいい)。中身の違いは Intel の GPU の部品 (QSV と
VA-API のドライバ) だけで、Debian では amd64 にしか無いので arm64 のイメージには入れていません
([encode.md](encode.md#gpu-でエンコードする-intel-qsv--va-api))。

`denpa-aio` (本体とエージェントを1つにしたもの) も同じ名前で出ます。組み直さず、束ねた2つを
写すだけです (`.github/aio.Dockerfile`)。main では `develop` と `<denpa の sha>-<agent の sha>`、
リリースでは版の名前と `latest` を貼ります。

**版の名前は、入れた人が版を固定して戻せるように貼ります** (git のタグ `v1.20.0` から `v` を落としたもの)。

**`develop` は動くタグなので、マニフェストは変わりません。** そのままだと ArgoCD には
何も変わっていないように見えるので、CI は `deploy/application.yaml` の `imageMarks` に
ビルドした中身のコミットを書き戻し、chart がそれを Pod の注釈 (`denpa.doany.io/denpa-image`) にします。
注釈が変われば Pod が入れ替わり、`imagePullPolicy: Always` が新しい `develop` を引きます
(`IfNotPresent` だと、古い `develop` がノードに残っているかぎり黙ってそれで上がる。
引き替えに、GHCR に繋がらないと Pod が起動しません)。

リリースを作ると、ビルドし直さずにそのコミットの `sha-` へ版と `latest` を貼り足します
(`.github/workflows/release.yml`)。試したものとリリースしたものを別にしないためです。
貼り足すときも両方の arch のままです。

**試し版 (prerelease) には `latest` を貼りません** (`compose.prod.yml` が指しているので、
入れて使っている人のところへ降ってしまう)。`x.y.z` の形式になっていないタグ (`nightly` など) には
版の名前も貼りません。

## ライブ視聴

**denpa 自身が配ります** (`/live`)。外のメディアサーバにも IPTV 向けのプレイリストにも
任せていません。視聴・追っかけ録画・チューナーの取り合いを1箇所で決めたいからです。
チューナーを取り合う相手 (録画・番組表・ロゴ・スキャン) が全部 denpa 側にあるので、
視聴だけ外に出すと優先度の決め方が2箇所に割れます。

任せる先もありません。エージェントは局も番組表も知らないので、IPTV 向けの
プレイリストと番組表 (m3u + XMLTV) を出せる相手がいません。

映像・音声・字幕・データ放送・双方向 (通信系コンテンツ) まで入っています。
どこまで入っているか、エンコード方式・遅延の詰め方・WebSocket の作りは [stream.md](stream.md) にあります。

録画済みのものをテレビで観るには、テレビのアプリ ([denpa-tv](https://github.com/danything/denpa-tv)) を使います
([library.md](library.md#テレビのアプリ))。

## クラスタ側の前提条件

**入れ方は Helm chart** ([charts/denpa](../charts/denpa)。エージェントだけ置くなら
[charts/denpa-agent](../charts/denpa-agent))。このリポジトリ自身の本番は ArgoCD が
[deploy/application.yaml](../deploy/application.yaml) の Application から同じ chart を当てていて、
値はそこの `helm.valuesObject` にあります (chart の使い方の実例として読めます。なぜそう置くかは
ファイルの頭のコメント)。クラスタの初期構築や共通アドオンは別のリポジトリです。chart を当てる前に以下が要ります。

- **StorageClass** — `persistence.storageClassName` (空ならクラスタの既定)。PVC を消させない設定は
  `persistence.protectFromPruning` (values.yaml に理由つき)
- **Gateway API の Gateway か Ingress** — chart の `httpRoute.parentRefs` / `ingress` が指す先。証明書は
  Gateway 側のリスナーが持ちます
- **DNS** — denpa の名前が Gateway のアドレスを指すこと
- **チューナードライバ** — エージェントは `privileged: true` かつ `/dev/bus`・`/dev/dvb` を
  hostPath でマウントするので、DVB の機材はノード側にドライバが読み込まれていること。
  PX-Q3U4 など px4-userland の対応機種と、smsusb を blacklist した PX-S1UD はノードに
  何も要らない (イメージ同梱のユーザー空間ドライバが `/dev/bus/usb` を使う。
  [tuner-px4.md](tuner-px4.md))
- **GHCR** — `ghcr.io/danything/denpa-agent` と `.../denpa` を pull できること

## 画面で動いてよいもの (CSP)

**画面の HTML には Content-Security-Policy を付けています** (設定は `vite.config.ts` の
`csp`、SvelteKit が毎回付ける)。[auth.md](auth.md) は「誰を通すか」ですが、ここは「通した人の画面で、
**誰が書いたスクリプトを動かすか**」です。

**狙いは放送が書いたスクリプト。** データ放送のエンジン (`src/lib/bml/`) は BML の
`onclick` などを DOM に写さず、自前の VM で動かします (描く要素に付くのは `style` と画像の
`src`・`alt` だけ)。それでも写し漏れがあったとき、放送の文字列が **denpa の origin で本物の
JS として動き**、ログインの控えで API を呼べることになるので、「放送のものを本物の JS として
動かさない」最後の砦として CSP でも止めます。

| 指令                       | 値                       | 理由                                                                                                                                                                      |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script-src`               | `'self'` + nonce         | 自分の束 (`_app/`。データ放送のエンジンの遅延読み込みも) と、SvelteKit の起動・後から流すデータの `<script>` (nonce)。**`'unsafe-inline'` と `'unsafe-eval'` は入れない** |
| `script-src-attr`          | `'none'`                 | `onclick="…"` などの属性のハンドラを止める (上の穴そのもの)                                                                                                               |
| `style-src`                | `'self' 'unsafe-inline'` | 下の「スタイルは止めない」                                                                                                                                                |
| `img-src`                  | `'self' data: blob:`     | 局ロゴ・ポスターは自分。データ放送の画像は作り直して blob:、DRCS (外字) は canvas から data:                                                                              |
| `font-src`                 | `'self' data: blob:`     | Denpa Font は自分 (`/api/font/denpa-font.woff2`)。DRCS は FontFace にバイト列で渡すので URL ではない                                                                      |
| `media-src`                | `'self' blob:`           | 録画は自分。ライブの MSE と端末に保存した録画は blob:                                                                                                                     |
| `connect-src`              | `'self'`                 | fetch・SSE・データ放送の双方向の中継 (`/api/bml/…`)・ライブの WebSocket。`'self'` は同じ host の `ws:` / `wss:` も含む                                                    |
| `worker-src`               | `'self'`                 | 変換せずに観る経路の worker (`src/lib/raw/worker.ts`) と PWA の ServiceWorker                                                                                             |
| `object-src`               | `'none'`                 | 使わない。BML の `<object>` はエンジンが画像 (`<img>`) か映像の場所の目印にするので読み込まない                                                                           |
| `frame-src`                | `'self'`                 | Hybridcast のアプリを入れる iframe (`/api/bml/hybridcast`) だけ。中身は sandbox で使い捨てのオリジンになり、denpa には触れない ([stream.md](stream.md#hybridcast))        |
| `base-uri` / `form-action` | `'self'`                 | `<base>` とフォームの送り先は自分だけ                                                                                                                                     |
| `default-src`              | `'self'`                 | 上に無いもの (マニフェストなど)                                                                                                                                           |

**画面の移動は関わりません。** OIDC のログイン (`/login` が Entra へ 302)・
Hybridcast (別のタブで開く)・更新のお知らせのリンクは移動なので、上のどれにも掛かりません。
フォームの送り先 (`form-action 'self'`) は自分だけで、送ったあとに外へ回すフォームはありません
(ログアウトは `/login/out` へ戻すだけ。期限切れの POST はリダイレクトせず 401)。
`frame-ancestors` は「denpa を枠に入れて使う」構成を止めるかどうかの別の話なので、
ここでは決めていません。

**WebSocket を `'self'` で通すのは CSP3 の決まり**で、今のブラウザ (Chrome・Edge・Firefox・Safari)
は同じ host の `ws:` / `wss:` を `'self'` に含めます。CSP3 より前の作りの古いブラウザ (数年前の Safari など) では
ライブが繋がりません。`ws:` / `wss:` を足せば通りますが、どこへでも繋げるようになるので足していません。

### nonce にする (hash ではなく)

**設定の画面 (録画・受信) は、load から Promise を返して後から流しています**
(SvelteKit のストリーミング)。流れてくる `<script>` は頭 (ヘッダ) を送ったあとに組まれるので、
hash を頭に載せられず、hash の方式だと止まります。`app.html` の色当てのスクリプトも
`nonce="%sveltekit.nonce%"` で通しています。

nonce は毎回変わるので、**画面の HTML は 304 になりません** (中身の指紋が毎回変わる)。
HTML は小さく、重いもの (`_app/immutable/`) は永く持たせたままなので困りません
(`hooks.server.ts` の `finish`)。

### スタイルは止めない

`style-src` には `'unsafe-inline'` を残しています。その場で書くスタイルが多いためです。
サーバで組んだ HTML の `style` 属性 (Svelte の `style:` と、観る画面の映像の箱などに直に書いたもの) と、
`+layout.svelte` の @font-face の `<style>`。属性のスタイルは nonce では通せず、hash で通すには
`'unsafe-hashes'` と1つずつの hash が要るので見合いません。データ放送のエンジンは
`element.style` (CSSOM) で書くので、これには頼っていません (CSSOM からの書き込みは CSP に掛からない)。

**CSS からできることは、スクリプトよりずっと少ない。** 見た目を変えることと、
上の `img-src` / `font-src` の範囲での読み込みまでです (外へは出られない)。denpa の DOM に
CSS で抜き出して困る秘密 (属性に入った鍵など) はありません。

**この「外へは出られない」は `img-src` / `font-src` を自分・data:・blob: に絞っているから**
成り立っています。外のサーバの画像や字を許すと、BML の CSS (属性セレクタ + `url()`) で
画面の中身を外へ送れるようになるので、そのときはスタイルも絞り直します。

### 増やすとき

新しく読み込み元を足したら (外のサーバの画像・iframe など) ここの表と `vite.config.ts` を一緒に
直します。止められたものは開発者ツールのコンソールに `Refused to …` と出ます。
E2E (`tests/e2e/35-csp.spec.ts`) は主な画面を回って違反が1つも出ないこと、
BML の `onclick` を押しても動かないことを見ています。
