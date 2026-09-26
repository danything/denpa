# 構成と設計

**「なぜそうしたか」を書く場所。** 迷ったところ、踏んだ落とし穴、選ばなかった案。
全体像はここに置き、**機能ごとの話はそれぞれの文書**にあります。

| 探しもの | 見る場所 |
| --- | --- |
| 入れ方・使い方 | [README](../README.md) |
| **全体像・入れ替え・クラスタ前提** (ここ) | この文書 |
| チューナーを掴むところ (エージェント・取り合い・相乗り・B-CAS) | [agent.md](agent.md) |
| CM とエンコード (字幕・AV1・CM検出・コマ数) | [encode.md](encode.md) |
| 局ロゴ (番組表用の PNG と CM検出用の `.lgd`) | [logo.md](logo.md) |
| 録画の置き場と配り方 (保存先・認証・削除・通知) | [library.md](library.md) |
| エージェントに聞くもの / denpa が持つもの (番組表・スキャン・予約) | [data.md](data.md) |
| どこに何があるか (ファイル・環境変数・画面・DB) | [app.md](app.md) |
| 誰を通すか (OIDC・信頼したネットワーク・期限付きのリンク) | [auth.md](auth.md) |
| EPGStation からの引き継ぎ | [migrate.md](migrate.md) |
| ライブ視聴 (放送中のものを観る。**映像・音声・字幕・データ放送が入っています**) | [stream.md](stream.md) |

コードの置き場や設定名はここには書きません (app.md と二重に持つと必ず片方が古くなる)。

## 全体

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ ブラウザでそのまま観る
                                                    └─→ テレビの VLC へ飛ばす / 落として好きなプレイヤーで
```

メディアサーバは置きません。焼いたもの (AV1/H.264 + Opus の mkv) はブラウザが
そのまま読むので `/watch` で観られ、テレビや外のプレイヤーへは denpa がファイルを
そのまま配ります。読めないのは生TS (MPEG-2) だけで、それは追っかけ再生の道で観ます。

**境界は「電波を掴むところ」と「中身を読むところ」で切ってあります。** エージェントは
チャンネルを掴んで素の TS を流すだけで、NIT も SDT も EIT も解きません。局を選り分ける
のも、番組表を組み立てるのも、ロゴを拾うのも denpa です ([agent.md](agent.md))。

## 入れ替えと録画

ArgoCD が同期すると Pod が差し替わります。録画中に来ても困らないように、
**denpa は SIGTERM を受けても録画が終わるまで居座ってから止まります**
(`SHUTDOWN_WAIT`、既定6時間)。待っている間も、始まる録画は始めます
(下の「居座っている間も」)。

TSは追記で開いていて、次の起動で `recoverOrphanedRecordings` が続きから録り直すので、
落ちても丸ごと失うことはありません。それでも居座るのは、**入れ替わるまでの
十数秒はどうやっても落ちる**からです。ArgoCD の同期は待てますが、放送は待ちません。

**待っている間も画面は開けます。** ここは2箇所で落ちていました。

1. **adapter-node が SIGTERM を受けたその場で listen を閉じる。** 居座っている間、
   Pod の中からも `127.0.0.1:3000` が拒否される状態でした。止まれの合図は
   `takeOverSignals` でこちらが受け取り、先に入っていた後始末は外します。
   閉じるのは本当に止まる直前 (`process.exit`) だけです。

   **引き取りは1回では足りません。** あちらが登録するのは `build/index.js` の
   いちばん最後で、こちらはその手前 (`hooks.server.ts` はアプリの読み込みで走る)
   なので、最初の引き取りでは外すものがまだ無い。そのまま置くと両方が
   登録された状態になり、プロセスは生きたままポートだけ閉じます。実機で
   `/proc/net/tcp` に listen が1つも無く、前段が「no available server」を
   返しているのに、番組表は集まり続けている状態を確認しました。
   `setImmediate` でもう一度引き取り直します。

   **2度目の合図でも落ちないようにします。** `once` で受けていた頃は、1度目で
   自分の後始末が外れて誰も聞いていない状態になり、デプロイがもう一度走ると
   Node の既定どおり録画の途中でも終わっていました。
2. **Kubernetes は `deletionTimestamp` が付いた Pod を Service から外す。**
   EndpointSlice には住所が残りますが `ready:false` / `terminating:true` になり、
   kube-proxy が回さなくなります。Service に `publishNotReadyAddresses: true` を
   付けると `ready:true` に戻ります。この Deployment に readinessProbe は無く、
   `strategy: Recreate` で新旧の Pod が並ぶこともないので、副作用はありません。

実機では、録画中に同期が来て**34分間ずっと画面だけ開けない**状態になりました
(Pod は生きていて録画も無事)。

### 居座っている間も、始まる録画は始めます

始めないでいた頃は、居座りの間に始まる番組の頭が丸ごと落ちていました。
実機では、デプロイの最中に始まった番組が **9分42秒ぶん欠けて**います
(`server/scheduler.ts` に実測)。始めればそのぶん居座りが伸びますが、
`SHUTDOWN_WAIT` が歯止めになります。

録画していないときは即座に止まるので、普段の入れ替えはこれまでどおりです。
すぐ入れ替えたいときは `SHUTDOWN_WAIT=0` にすると、以前と同じ「落ちて、
続きから録り直す」に戻ります。

Kubernetes の `terminationGracePeriodSeconds` と docker compose の
`stop_grace_period` を `SHUTDOWN_WAIT` より長くしておくこと。短いと待っている
途中で SIGKILL され、居座った意味が無くなります。

### エージェントも同じように居座ります

**denpa だけが待っても足りません。** TS を流しているのはエージェントなので、
そちらが先に消えれば掴んでいたストリームごと切れます。実機で**エージェントの
Pod を入れ替えただけで、始まって10秒の30分番組が丸ごと失敗**しました。

エージェントも `SHUTDOWN_WAIT` (既定6時間) を見て、**録画が終わるまで居座ります**。
待つのは録画だけで、番組表・ロゴ・スキャンは切れたら取り直せばいいので待ちません
(何に使っているかは denpa が渡す `use` で分かる。`rec` で始まるものが録画)。

**止まれの合図はエージェント自身が受け取ります** (`Drain`)。既定の受け取り役に
任せると、その場でホストが畳みに入って Kestrel が開いている応答への書き込みを
止めます。実測で、合図の直後からバイトが1つも進まなくなりました。denpa 側で
`takeOverSignals` をやっているのと同じ理由です。

### それでも切れたときは掴み直します

居座りは「こちらから止めるとき」の話で、**電源やネットワークで切れることは
あります**。読んでいる最中に例外が飛んだときも、EOF と同じように掴み直して
終了時刻まで録り続けます (`recorder.ts`)。ここを外へ抜けさせていた頃は、
繋ぎが切れた瞬間に録画そのものが失敗になっていました。

TSは追記なので、掴み直したぶんは後ろに繋がります。落ちるのは切れていた数秒だけです。

### 隙間はイメージの取得時間だった

新旧の Pod を並べられないので、入れ替えの隙間はどうやっても空きます。実機で
その中身を測ると、**ほとんどがイメージの取得**でした。

```text
ScalingReplicaSet (旧Podを削除) → Pulling → Pulled 13.6秒 → Started → bun 起動
```

そこで、**マニフェストを当てる前にイメージだけ引いておく** Job を ArgoCD の
PreSync フックに置いています (`denpa-prepull`、中身は `/bin/true`)。
これで入れ替えのときにはノードの手元にあり、隙間は起動そのものだけになります。

### 録画そのものは引き継がない

引き継ぐには新旧のPodが同時に居る必要がありますが、denpa は1本のSQLiteに書き、スケジューラもEPG取得も
エンコード待ち行列も抱えているので、2つ動くと全部が二重になります
(どちらが主かを決める仕組みが別途要る)。
録画をエージェント側に持たせる道もあります。そうすれば denpa の入れ替えと
録画が切り離れますが、番組追従・スクランブル解除・保存名の付け方まであちらへ
移すことになり、「エージェントは中身を読まない」という切り分けが崩れます。
**この道は選びません。**

### イメージのタグ

| タグ | いつ動くか | 誰が指しているか |
| --- | --- | --- |
| `develop` | **main へ入るたび** | `deploy/application.yaml` の `helm.valuesObject` (この構成。入れ替えの合図は `imageMarks`) |
| `latest` | **GitHub でリリースを作ったときだけ** | `compose.prod.yml` (入れて使う人) |
| `1.20` | その系列でリリースを作るたび (1.20.1 を出せばそちらへ) | 版を決めて使う人 |
| `1.20.0` | **動かない** | 固定して使う人・戻したいとき |
| `sha-<12桁>` | 動かない。中身ごとに1つ | 中身のコミットから辿るとき |

**どのタグも amd64 と arm64 を束ねた索引 (multi-arch manifest) を指します。** CI は
arch ごとにその arch のランナー (amd64 は `ubuntu-latest`、arm64 は `ubuntu-24.04-arm`) で
組んで digest だけで push し、最後に両方を束ねた索引へ名前を付けます
(`.github/workflows/build-and-deploy.yml`)。QEMU で arm64 を組むと ffmpeg と Native AOT が
何倍も掛かるので使いません。**片方の arch が落ちたら名前は付けない。** 片方だけの
`develop` が出ていくより、前のものが残るほうがいい。違いは Intel の QSV だけで、
Debian では amd64 にしか無いので arm64 のイメージには入れていません
([encode.md](encode.md#gpu-で焼く-intel-qsv--va-api))。

**版の名前は、入れた人が版を固定して戻せるように貼ります** (`latest` と `sha-…` だけでは
「いま動いているもの」か中身のコミットしか指せない)。git のタグ (`v1.20.0`) から
`v` を落としたものです。

**`develop` は動くタグなので、マニフェストは変わりません。** そのままだと ArgoCD には
「何も変わっていない」ように見えて古い Pod が残るので、CI は Pod の注釈
(`denpa.doany.io/denpa-image`) に焼いた中身のコミットを書き戻します。注釈が
変われば Pod が入れ替わり、`imagePullPolicy: Always` が新しい `develop` を引きます。

**`Always` にしているのは、動くタグだからです。** `IfNotPresent` だと、古い
`develop` がノードに残っているかぎり黙ってそれで上がります。引き替えに、
**GHCR に繋がらないと Pod が起動しません**。

`sha-` のタグはリリースのときの目印にも使っています。リリースを作ると、
**焼き直さずに** そのコミットの `sha-` へ版と `latest` を貼り足します
(`.github/workflows/release.yml`)。試したものとリリースしたものが別にならないように。
貼り足すときも両方の arch のままです。エージェントは索引ごと写し、denpa は版の ENV を
足す層を土台の索引にある arch の数だけ作ります (RUN が無いので1台のランナーで済む)。

**試し版 (prerelease) には `latest` を貼りません。** `compose.prod.yml` が指して
いるのがそれなので、貼ると入れて使っている人のところへ降ってしまいます。
`x.y.z` の形をしていないタグ (`nightly` など) には版の名前も貼りません。版だと
思って固定されてしまうため。

## ライブ視聴

**denpa 自身が配ります** (`/live`)。外のメディアサーバにも IPTV 向けのプレイリストにも
任せていません。要点は「視聴・追っかけ録画・チューナーの取り合いを1箇所で決めたい」で、
チューナーを取り合う相手 (録画・番組表・ロゴ・スキャン) が全部 denpa 側に居る以上、
視聴だけ外に出すと優先度の決め方が2箇所に割れます。

任せる先もありません。IPTV 向けのプレイリストと番組表 (m3u + XMLTV) を
出せる相手が居ないからです。エージェントは局も番組表も知りません。

**映像・音声・字幕・データ放送・双方向 (通信系コンテンツ) まで入っています。**
どこまで入っているか、焼き方・遅延の詰め方・WebSocket の作りは [stream.md](stream.md) にあります。

録画済みのものを手元のプレイヤーで観るには、URL を渡して再生させます。テレビの VLC へ
飛ばすか、期限付きの再生リンクを貼るかです ([library.md](library.md#手元のプレイヤーで観る))。

## クラスタ側の前提条件

**入れ方は Helm chart** ([charts/denpa](../charts/denpa)。エージェントだけ置くなら
[charts/denpa-agent](../charts/denpa-agent))。この家の本番は ArgoCD が
[deploy/application.yaml](../deploy/application.yaml) を見て、同じ chart にそこの
`helm.valuesObject` (インライン) を重ねて当てています。chart の使い方の実例として
読めます。bootstrap の ApplicationSet は `deploy/` を「素のマニフェストの置き場」として
読む (置き場の設定は `deploy/argocd.yaml`) ので、そこには Application (chart を指す) と、
chart に持たないこの家の事情だけを素のまま置いています。事情とは InfisicalSecret
(Infisical から Secret を作る) と Namespace (PSA を privileged にするラベル。名前空間
そのものは `CreateNamespace` が作る) の2つです。値を別ファイルにしないのも同じ理由 (kind が無いので
ApplicationSet が読めない)。

このリポジトリには `denpa` namespace のアプリ本体しか入っていません。クラスタの初期構築や
共通アドオンは別の bootstrap リポジトリ側です。適用前に以下が要ります。

- **StorageClass `local-path-retain`** — `reclaimPolicy: Retain` の local-path
- **Gateway API の Gateway** — chart の `httpRoute.parentRefs` が指す先。証明書は
  Gateway 側のリスナーが持ちます
- **ArgoCD** — 上の ApplicationSet が `deploy/argocd.yaml` を見て Application を拾います
- **DNS** — `dp.doany.io` が Gateway の外部IPを指すこと。
  LAN 用の `dp.l.doany.io` は `*.l.doany.io` の書き換えで内側のIPへ
- **チューナードライバ** — エージェントは `privileged: true` かつ `/dev/bus`・`/dev/dvb` を
  hostPath でマウントするので、DVB の機材はノード側にドライバが読み込まれていること。
  PX-Q3U4 など px4-userland の対応機種と、smsusb を blacklist した PX-S1UD はノードに
  何も要らない (イメージ同梱のユーザー空間ドライバが `/dev/bus/usb` を掴む。
  [agent.md](agent.md#px-q3u4-などは-px4-userland-でカーネルドライバは入れてもらわない))
- **GHCR** — `ghcr.io/danything/denpa-agent` と `.../denpa` を pull できること
