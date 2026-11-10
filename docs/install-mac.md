# Mac に入れる

**Apple Silicon の Mac なら、ターミナルの 1 行で denpa ごと立ち上がってブラウザが開きます** (入口の `install.sh` は Linux と同じで、OS を見て振り分ける)。
Mac は管理者で流すので `sudo` を付け、パスワードを聞かれたら入れます。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | sudo bash
```

引数は `… | sudo bash -s -- --uninstall` のように渡します (`--no-open` ブラウザを開かない / `--uninstall` 止めて外す / `--agent-only` エージェントだけ)。

**denpa 本体もエージェントも、Mac の上でそのまま動かします。** Docker Desktop・OrbStack・コンテナは使いません。
本体はリリースに添えた `denpa-<バージョン>-darwin-arm64.tar.gz` (bun・アプリ・ffmpeg・字・ブラウザへ配るデコーダ) で、
エージェントは `denpa-agent-<バージョン>-darwin-arm64.tar.gz` (.NET の実行ファイル。[メニューバーのアプリ](#メニューバーのアプリ)も入っている) です。どちらも同じバージョンを入れます。

1. **エージェント**: LaunchDaemon (`/Library/LaunchDaemons/io.github.danything.denpa-agent.plist`) に root で載せます。
   Mac の起動時に起動し、落ちたら起動し直し、止めるときは録画の終わりを待ちます (launchd に強制終了されないよう、待ちの上限を 6 時間より長くしてある)
2. **denpa 本体**: 同じく LaunchDaemon (`io.github.danything.denpa.plist`) に root で載せ、`denpa.sh` が `bun server.js` を起こします。
   答えたらブラウザで開きます

**LaunchDaemon は root で動くので、誰もログインしていなくても録画でき、外から観られます。** そのために sudo で流します
(sudo を付けなければ、install.sh がそう言って止まる)。

- **要るのは macOS だけです。** Homebrew も要りません。px4-userland / siano-userland の Mac 用は libusb を中に抱え、
  同梱の ffmpeg も macOS に最初からあるものにしか繋ぎません
- **Developer ID の署名と公証はしていません。** curl で取ったファイルには「インターネットから来た」印 (隔離) が付かないので、
  Gatekeeper に止められません。ブラウザで落とした tar.gz を手で渡したとき (`DENPA_AGENT_TARBALL` など) は、install.sh が印を外します。
  ffmpeg とエージェントは ad-hoc 署名 (`codesign -s -`)、bun は Oven の署名のままです
- 2 つが組むときの合言葉 ([agent.md](agent.md)) はエージェント自身の置き場 (`~/denpa/config/tls/pair-token`) に無いときだけ作り、エージェントはそこから読み
  (手で `denpa-agent --pair` を流しても同じ URL が出る)、denpa には `TUNER_AGENT_URL` (`https://127.0.0.1:25252#pair=<合言葉>`) で渡します。上げ直しても変えません
- エージェントは本体と同じ Mac なので、ループバックでだけ待ち受けます (`AGENT_HOST=127.0.0.1`)
- genkan (`http://denpa.localhost`) には繋ぎません。この Mac からは <http://localhost:3000>、LAN のほかの機器からは `http://<Mac の名前>.local:3000` で開きます
- 本体とエージェントの tar.gz は、出所の証明でも確かめられます ([配布物を確かめる](install.md#配布物を確かめる))

| 置き場                                     | 中身                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/Library/Application Support/denpa/`      | エージェントとメニューバーのアプリ (`bin/`)・px4-userland・siano-userland・本体 (`server/`)・px4d のソケットの置き場 (`run/`。root だけ) |
| `/Library/Application Support/denpa/data/` | DB (`denpa.db`) と、その隣の局ロゴ・鍵・本体の環境変数 `denpa.env`・本体を起こす `denpa.sh` (エージェントと組む合言葉が入る)。root だけ  |
| `/Library/LaunchDaemons/`                  | `io.github.danything.denpa.plist`・`io.github.danything.denpa-agent.plist`                                                               |
| `/Library/LaunchAgents/`                   | `io.github.danything.denpa-tray.plist` (メニューバーのアプリをログインしたら起こす)                                                      |
| `/Library/Logs/denpa/`                     | ログ (`denpa.log` は本体、`denpa-agent.log` はエージェント。回さずに足していく)                                                          |
| `~/denpa/config/` (`DENPA_HOME`)           | エージェントの `tuners.json` / `channels.json`・`tls/` (`tls/pair-token` は組むときの合言葉)                                             |
| `~/Movies/denpa/recorded`                  | 元の TS (`RAW_DIR`。エージェントと本体の両方が使う)                                                                                      |
| `~/Movies/denpa/library`                   | 出来上がった録画 (`ENCODED_DIR`。Finder から見える)                                                                                      |

`~` は sudo を流した人のホームです。`data/` を root だけのものにしてあるのは、root で動くものの環境変数と合言葉を、ほかの人やほかのプログラムに
読ませたり書き換えさせたりしないためです (`/Library/LaunchDaemons` の plist はだれでも読めるので、合言葉は書かない)。

**録画はその人のものとして扱えます。** 本体は umask 002 で動き、macOS では新しいファイルが置いたフォルダのグループ (`staff`) を継ぐので、
root が書いた録画も Finder から消したり動かしたりできます。`~/Movies` はその人しか開けないので、ほかの人からは見えません。

- もう一度流せば上げ直し (本体もエージェントも最新のリリースへ)。録画中なら、本体とエージェントが録画の終わりを待ってから入れ替わります
- 消すときは `… | sudo bash -s -- --uninstall`。LaunchDaemon・プログラムを外し、DB と `denpa.env`・エージェントの設定・録画・ログは残して、消し方を言います
- denpa 本体は別の機械で動かし、Mac にはエージェントだけ置くなら `… | sudo bash -s -- --agent-only`。
  denpa の `TUNER_AGENT_URL` には、install.sh が最後に出す `https://<Mac の名前>.local:25252#pair=<合言葉>` を書きます
  ([別の所に置く](agent.md#エージェントは別イメージ別プロセス)のと同じ構成)。このときエージェントは全部のインターフェースで待ち受けます。
  エージェントが応答するのは合言葉で組んだ denpa だけです ([agent.md](agent.md))
- 手元でビルドした tar.gz を入れるとき (開発と CI) は、`DENPA_AGENT_TARBALL`・`DENPA_SERVER_TARBALL` に絶対パスを書き、`sudo -E` で環境変数を渡します

LaunchDaemon の環境変数は、コンテナ既定の置き場を Mac の置き場に向け直すものです。エージェントは
`AGENT_PORT` (25252 のまま) `AGENT_HOST` `TUNERS_FILE` `CHANNELS_FILE` `PX4_USERLAND_DIR` `PX4_RUNTIME_DIR` `SIANO_USERLAND_DIR` `SIANO_FIRMWARE` `RAW_DIR`
で、本体は `denpa.sh` が `DENPA_DB`・`RAW_DIR`・`ENCODED_DIR`・`FFMPEG`・`FFPROBE`・`MPEG2_DIR`・`FONT_DIR`・`TUNER_AGENT_URL`・`PORT`・`DENPA_VERSION` を決めます。
`PX4_RUNTIME_DIR` を `/Library/Application Support/denpa/run` と短くしているのは、px4d の制御ソケットのパスが macOS では 104 バイトまでだからです。
px4d は、持ち主が自分 (root) でほかの人が書けないフォルダしか使わないので、install.sh が root の 700 で作ります。
IT930x のファームウェアはエージェントに同梱しているので、install.sh は置きません。

## メニューバーのアプリ

**ログインすると、メニューバーに denpa のアイコン (`denpa-tray`) が出ます。** install.sh が `/Library/LaunchAgents` に載せるので、
この Mac の誰がログインしても出ます。同じ Mac の denpa の `/api/health` を 10 秒ごとに呼び、その答えを出すだけです。

- denpa が答えれば電波塔のアイコン、答えなければ斜線の入ったアイコンになります。新しいバージョン (denpa が GitHub の最新のリリースと見比べたもの) があると、
  アイコンの横に「更新」と出ます。**更新は勝手には始めません**
- メニューは、バージョンと録画・エンコードの本数の 1 行・「denpa を開く」・新しいバージョンがあるときだけの「v2.31.0 に更新…」・「終了」です
- 「終了」で消したアイコンは、次のログインでまた出ます。`--agent-only` では載せません (出すのは本体の様子なので)。外すと LaunchAgent も消します

**「v2.31.0 に更新…」を選ぶと、入れたときと同じ install.sh の 1 行をターミナルで流します** (`--no-open` 付き。sudo のパスワードはターミナルで聞く)。

- 録画中・エンコード中なら、流す前に確かめます。録画中なら、install.sh が録画の終わりを待ってから入れ替えます。
  エンコード中なら中断し、更新のあとで最初からやり直します
- ターミナルに進み具合が出ます。録画を待つ間も、そこで待ちます。失敗したら、Enter を押すまで閉じません
- 入れ替える前にメニューバーのアプリも止め、入れ終えたら起動し直します (ほかの人のものは次のログインで新しくなる)

## 環境変数を足す (`denpa.env`)

**本体の環境変数は `/Library/Application Support/denpa/data/denpa.env` に `KEY=値` で書きます** (変数の一覧は [config.md](config.md))。
install.sh は無いときだけ雛形 (`TZ`・`ENCODE_CONCURRENCY`・`TRUSTED_NETWORKS`) を作り、あとは触りません。
root でないと書けないので、`sudo nano "/Library/Application Support/denpa/data/denpa.env"` のように開きます。`#` で始まる行は読みません。

- **直したら、install.sh を流し直すか、Mac を再起動します。** `denpa.sh` が本体を起こすたびに読み直すので、
  `sudo launchctl kickstart -k system/io.github.danything.denpa` でも効きます (録画中は流さないこと)
- 置き場 (`DENPA_DB`・`RAW_DIR`・`ENCODED_DIR`)・ffmpeg・字とデコーダの置き場・エージェントの宛先 (`TUNER_AGENT_URL`)・`DENPA_VERSION` は
  install.sh が `denpa.sh` で決め、`denpa.env` に書いても効きません
- `TRUSTED_NETWORKS` の雛形は `127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8` です。`127.0.0.0/8` と `::1/128` はこの Mac のブラウザです。
  この Mac で cloudflared のような前段を動かすときは、前段越しの人もループバックから来たように見えるので、ループバックを外して OIDC を使います
  ([auth.md](auth.md#前段の後ろに置くとき-trusted_proxies))

## スリープ

**録画・ライブ視聴・エンコードの間は、本体が Mac をスリープさせません** (IOKit の `PreventUserIdleSystemSleep`。src/lib/server/awake.ts)。
止めるのは操作が無いことで眠るのだけで、画面は消えてかまいません。蓋を閉じる・メニューの「スリープ」は止めません。
録画を始める 5 分前からもスリープさせません。`pmset -g assertions` に `denpa: recording, live viewing or encoding` として出ます (pmset が ASCII でない名前を出さないので英語)。

**次の録画の 3 分前に、スリープから起こします。** 本体が IOKit の `IOPMSchedulePowerEvent` で起こす予約を 1 つ置き、
次の録画が変わるたびに置き直します (録画が無ければ取り消す)。予約は `pmset -g sched` に `denpa` の名前で出ます。
置くには root が要るので、本体は root の LaunchDaemon で動かしています。

- 予約は OS が覚えていて、本体が起き直しても残ります。そこで置いた時刻を `data/wake-at` に書き、置き直すときと起き直したときに前のものを取り消します。
  本体が止まるとき (上げ直す・外す・再起動する) にも取り消し、起き直したら置き直します
- 電源が切れている Mac は起こしません。シャットダウンしたら録画は始まりません
- 録画した番組を観ている間 (ライブでない再生) は、スリープを止めません。省エネルギーの設定の時間で眠ることがあります

**外からいつも観るなら、この Mac をスリープしない設定にします** (システム設定の「エネルギー」で「ディスプレイがオフのときに自動でスリープさせない」をオン)。
スリープしている Mac は外からの要求を受けられないので、観ようとしても繋がりません (Wake-on-LAN で起こす作りはありません)。

## 前のバージョン (本体が Docker) から上げる

**前のバージョンは denpa 本体を Docker (Docker Desktop・OrbStack) で、エージェントをログインしたら起こす LaunchAgent で動かしていました。**
`~/denpa/compose.yml` (install.sh が置いた印の付いたもの) があれば、上げるときに install.sh が次のことを 1 度だけします。

1. `docker compose down` で本体のコンテナを畳む (録画中なら、コンテナの stop_grace_period で終わるまで待つ。古いエージェントはこの間も動かしておく)
2. Docker のボリューム `denpa_denpa-data` の中身 (DB・局ロゴ・鍵) を `/Library/Application Support/denpa/data` に写す。
   `docker run … alpine tar` で書き出し、Mac の `tar` で開く (持ち主は root にする)
3. `~/denpa/compose.yml` を外す。**ボリュームは消さずに残す** (確かめたら `docker volume rm denpa_denpa-data` で消してよい)
4. 古いエージェント (`~/Library/LaunchAgents/io.github.danything.denpa-agent.plist`) を止めて外し、前の置き場
   (`~/Library/Application Support/denpa-agent`・`~/Library/Caches/denpa-agent`) を消す

**このときだけ Docker が動いている必要があります** (DB がボリュームの中にあるため)。動かなければ、install.sh は何も変えずに止まり、
Docker Desktop か OrbStack を起こすよう言います。途中で止まっても、流し直せば続きから進みます (写した DB があれば写し直さない)。
写したあとは Docker は要りません。

- 録画のフォルダ (`~/Movies/denpa`)・エージェントの設定 (`~/denpa/config`)・組むときの合言葉は同じ場所のまま使います。
  本体の鍵も DB と一緒に移るので、組み直しは要りません
- `compose.override.yml` は読みません。`environment` に書き足したものがあれば、`denpa.env` に `KEY=値` の形で書き直します (install.sh がそう言う)。
  genkan への登録は要らなくなります (genkan はほかのプロジェクトのために残す)
- `~/denpa/.env` (Docker の本体に合言葉を渡していたもの) は使いません。要らなければ消してかまいません
- 前のバージョンで `--no-docker` (エージェントだけ) で入れていたなら、`--agent-only` で流し直します。古い LaunchAgent は同じく外します

## 別の機械へ移す

**別の機械 (Linux の Docker Compose や Kubernetes) へ移すとき**は、設定の「連携」の「denpa を別の機械へ移す」で書き出します。
ブラウザのダウンロードとして落ちてきます。録画のフォルダ (`~/Movies/denpa/library`・`~/Movies/denpa/recorded`) は自分で写します
([migrate.md](migrate.md#別の機械へ移す))。

## Linux と違うところ

- **チューナーは px4-userland と siano-userland の機材と PX-MLT5 系・Sony CECH-ZD1 J・PIXELA PIX-DT295 (試験的) だけ。** macOS には DVB が無いので、
  PT2/PT3 のような PCI の機材は使えません。PX-MLT5 系 ([tuners.md](tuners.md#px-mlt5-系)) と CECH-ZD1 J と PIX-DT295 はエージェントが IOKit で USB を直に持ちます (カーネルの拡張は要りません。
  Mac の実機ではまだ確かめていません)
- **カードリーダー**: px4-userland の内蔵リーダーはそのまま (px4d に問い合わせる)。PX-MLT5 系の内蔵リーダーと CECH-ZD1 J の差し込み口もエージェントが直に読みます。USB のリーダーは
  usbfs を直接扱えないので、**macOS 標準の PC/SC (PCSC.framework) 越し**に扱います
  (`Pcsc.cs`)。`denpa-agent --card` はそのリーダーを並べます ([読めないとき](#カードが読めないとき))。動いている間はリーダーを
  排他で使うので、他のアプリはカードを使えません
- **エンコードは Apple の VideoToolbox (H.264・H.265) を使えれば使い、使えなければソフトウェアで** (SVT-AV1・x264)。
  起動時の試しのエンコードで決めます ([encode.md](encode.md#mac-でエンコードする))。AV1 はソフトウェアだけです
- pipe を広げられない (`F_SETPIPE_SZ` が無い) ので、siano-ts から受けるバッファは Linux より浅い
  (px4d から受けるバッファは pipe を使わないので、Linux と同じ 8MB)
- エンコードの進み具合は、エンコードできたコマ数から出します。Linux のように ffmpeg の読み位置 (`/proc`) は読めないので、
  尺が測れなかった録画は割合が動きません (出来上がりは変わらない)
- **Apple Silicon だけ** (Intel Mac 用の px4-userland / siano-userland が無い)

## 確かめたこと

- **CI** (test.yml の `server-macos`・`agent-macos`): 配布物の ffmpeg で denpa が使う経路を流し、VideoToolbox のエンコーダが組み込まれて
  denpa が渡すオプションを持つこと、通れば放送に似せた素材をエンコードできること (ランナーでは通る)、試しのエンコードが落ちればソフトウェアに戻ることを見る。
  進み具合を fd 3 で受け、スリープを止める呼び出しが `pmset -g assertions` に、起こす予約が `pmset -g sched` に出て取り消せることを見る。
  本体を `bun server.js` で起こして画面・字・デコーダが返ることを見る。install.sh で本体ごと入れて root の LaunchDaemon で動き、
  本体がエージェントと組むところまで。Docker の本体からの移行は偽の docker で流す (`tests/install-mac-migrate.sh`)。メニューバーのアプリは、組んで起こして落ちないこと・
  LaunchAgent に載ること・上げ直すと動いているものを止めること・外すと消えることまで
- **Mac の実機でチューナーとカードを繋いで確かめたのは、以前の方式 (ファームウェアを入れる方式) の PIX-DT295 の報告 (#2218) だけです** ([tuners.md](tuners.md#pixela-pix-dt295-試験的))。それも前のバージョン
  (エージェントがユーザーの LaunchAgent) のときのものです
- **まだ確かめていないこと**: root の LaunchDaemon で動くエージェントから USB の機材とカードリーダー (PC/SC) を使えるか、VideoToolbox で
  エンコードした録画の画質と大きさ、スリープから起こす予約で録画が始まるか、実機の Docker からの移行、メニューバーのアプリの見た目と、
  そこからターミナルで更新する流れ。実機で当てるのは
  `sudo "/Library/Application Support/denpa/bin/denpa-agent" --card` など (下の手順でエージェントを止めてから)

## カードが読めないとき

**macOS の標準の CCID ドライバ (Apple のもの) では、B-CAS カードに繋がらないリーダーがあります。**
IDBridge CT30 で、従来のドライバ (ifd-ccid) に切り替えたら読めるようになった、という報告があります
(こちらの実機では確かめていません)。切り替えはシステムの設定なので、エージェントもインストーラも勝手には変えません。

```sh
# 従来のドライバに切り替える。カードを挿したままリーダーを抜き差しすると効く (サービスの再起動だけでは効かない)
sudo defaults write /Library/Preferences/com.apple.security.smartcard useIFDCCID -bool yes
# 標準のドライバに戻す
sudo defaults write /Library/Preferences/com.apple.security.smartcard useIFDCCID -bool no
```

ほかのスマートカード (仕事の IC カードなど) の動きも変わりうるので、読めなかったときだけ切り替えてください。
今どちらのドライバかは `denpa-agent --card` のリーダーの一覧のあと (「CCID ドライバ: …」の行) と、denpa の設定の「その他」→「バージョンと環境」の「CCID ドライバ」に出ます。

**なぜ読めないか (推測)。** B-CAS カードは specific mode で、ATR の直後から TA1 の速さで通信します。
Gemalto PC Twin の系統のリーダー (IDBridge CT30 もこの系統) はそれを自分では読まず、ドライバが速さを
設定する必要があります (Linux のエージェントはそうしている。`Ccid.cs`)。従来のドライバはこれをしますが、
Apple のドライバはソースが公開されておらず、ここが違うのかは確かめられていません。Sequoia で
「Gemplus USB SmartCard Reader」が Apple のドライバだと `Card is unresponsive` になり、従来のドライバで直った、
という報告もあります ([Ludovic Rousseau's blog](https://blog.apdu.fr/posts/2024/10/macos-sequoia-and-smart-cards-status/))。
Apple のドライバには速さの設定 (`AllowAlternativeFiDi`。`man SmartCardServices`) もありますが、これは速さを
カードと決め直すカード (negotiable mode) 向けで、B-CAS のような specific mode のカードには効かない見込みです。

繋がらないときは、ログの PC/SC のエラー番号 (`0x8010…`) と `denpa-agent --card` の出力を
[Issue](https://github.com/danything/denpa/issues) に貼ってもらえると、ドライバを切り替えずに読めるようにできるかを調べられます。

### CECH-ZD1 J の差し込み口が読めないとき

**CECH-ZD1 J の差し込み口は PC/SC も CCID ドライバも通りません。** エージェントが IOKit で CECH-ZD1 J を開き、
中の USB ブリッジを通してカードと通信します ([tuners.md](tuners.md#sony-cech-zd1-j))。上のドライバの切り替えは関係ありません。
カードを読む前にチューナーと同じく CECH-ZD1 J を開くので、**映像も映らないなら、カードより先に開くところで止まっています。**
Mac の実機ではまだ確かめていません。

切り分けは `denpa-agent --card` で。動いているエージェントが CECH-ZD1 J を開いたままにしているので、先に止め、終わったら戻します。

```sh
# エージェントを止める。録画中は録画の終わりを待ってから止まる (止まるまでは --card が CECH-ZD1 J を開けない)
sudo launchctl bootout system/io.github.danything.denpa-agent
# リーダーを全部並べる。CECH-ZD1 J は「内蔵 Sony CECH-ZD1 J <ポート> Internal Card Reader: …」の行
# (OS に見えていなければ「Sony CECH-ZD1 J: 見つかりません」)。動いているときと同じく root で
sudo /Library/Application\ Support/denpa/bin/denpa-agent --card
# その CECH-ZD1 J の差し込み口だけを開いて、ATR とカードの番号と、かかったミリ秒を出す (ほかのリーダーには触らない)
sudo /Library/Application\ Support/denpa/bin/denpa-agent --card zd1j:<ポート>
# エージェントを戻す
sudo launchctl bootstrap system /Library/LaunchDaemons/io.github.danything.denpa-agent.plist
```

開けないときは、エージェントのログ (`/Library/Logs/denpa/denpa-agent.log`。設定の「その他」→「ログ」でも見られる) に
`[Sony CECH-ZD1 J <ポート>] 開けません (…ところで): …` の行が、どこで止まったか (USB を開く・ブリッジを起動する・コア 1 との
bulk の経路を用意する) 付きで出ます。開けたときは `開きました` の行と、初めて開いたときに端点の一覧
(`usb <ポート>: EP 0x81 bulk …`) が出ます。これらの行と `--card` の出力を、設定の「その他」→「ログ」の「Issue にする」で
送ってもらえると調べられます。
