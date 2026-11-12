# 環境変数

**環境変数にするのは、外から差し替える理由があるものだけです** (相手の場所と、テストで詰めたい間隔)。
それ以外の値は `src/lib/server/config.ts` に直に書いてあり、画面から変えるものは設定にあります
(`src/lib/server/settings.ts`。[app.md の画面](app.md#画面)の `/settings` の行)。
ふつう書くのは、既定値では決められないもの (誰を通すか・前段・OIDC・PWA の名前) だけです。
Helm では `charts/denpa/values.yaml` のキーで渡します。チューナーエージェントの変数は[下](#チューナーエージェント)。

| 変数                                    | 既定値                                         | 説明                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TUNER_AGENT_URL`                       | `https://tuner-agent:25252`                    | チューナーエージェント。選局もカードも復号もここ 1 つ。`https://` で書き、初めて組むときは後ろに `#pair=<合言葉>` を付ける (`#` から後ろは送らない。[agent.md](agent.md#denpa-とは-tls-で組む))                                                                                                                                    |
| `DENPA_DB`                              | `/data/denpa.db`                               | SQLite の置き場。局ロゴと CM 検出のために覚えたロゴもこの隣 (`logos/`)。別の機械へ移すときの書き出しと取り込みの作業場所も隣 (`transfer/`。[migrate.md](migrate.md#別の機械へ移す))。ニコニコとの連携のトークンを開く鍵も隣 (`niconico.key`)。エージェントと組むための denpa の鍵と証明書、覚えたエージェントの証明書も隣 (`tls/`) |
| `MEDIA_DIR`                             | `/media`                                       | 録画の置き場の親。元の TS は `raw`、エンコードしたものは `encoded` に分けて置く。エージェントも同じ変数を見る                                                                                                                                                                                                                      |
| `RAW_DIR`                               | `$MEDIA_DIR/raw`                               | 元の TS の作業領域。別のディスクへ移すときは `ENCODED_DIR` と同じく、マウントを付け替える                                                                                                                                                                                                                                          |
| `ENCODED_DIR`                           | `$MEDIA_DIR/encoded`                           | エンコード済みの置き場。ここから配る。録画を入れたあとに別のディスクへ移すなら、これは変えずにマウントを付け替える ([library.md](library.md#置き場を別のディスクに移す))。切り抜きの画像もこの下 (`clips/`) に置く                                                                                                                 |
| `FFMPEG` / `FFPROBE`                    | `/usr/local/bin/...`                           | 開発時は偽物に差し替える。Mac と Windows はインストーラが、Android はアプリが配布物の中を指す                                                                                                                                                                                                                                      |
| `MPEG2_DIR`                             | `/opt/denpa/mpeg2`                             | ブラウザへ配る MPEG-2・AAC・Opus のデコーダ (WASM) の置き場。変換せずに観るライブと録画、互換モードの音で使う。イメージの `mpeg2wasm` 段が置き、Mac と Windows はインストーラが、Android はアプリが配布物の中を指す。無ければこの方式は使えず、エンコードしたものに戻る ([stream.md](stream.md#放送そのままmpeg-2を送る))          |
| `FONT_DIR`                              | `/usr/share/denpa-font`                        | データ放送・字幕を描く字 (Denpa Font) の置き場。`/api/font/` が配る。イメージの `denpa-font` 段が置き、Mac は install.sh、Windows は install.ps1、Android はアプリが配布物の中を指す。無ければ 404 を返し、画面は端末の字で描く                                                                                                    |
| `DENPA_VERSION`                         | `dev`                                          | 動いているバージョン。リリースのイメージ (`.github/release.Dockerfile`) と、Mac・Windows のインストーラが書く起動スクリプト、Android のリリースの APK にだけ入る。`dev` なら新しいバージョンの通知を出さない                                                                                                                       |
| `DENPA_GITHUB_API`                      | `https://api.github.com/repos/danything/denpa` | 新しいバージョンを確かめる先 (`releases/latest`)。テストでは偽物を指す                                                                                                                                                                                                                                                             |
| `DENPA_HUB`                             | `https://dh.doany.io`                          | ニコニコの OAuth を中継する denpa-hub。ニコニコとの連携の入口、トークンの更新、公式の実況の接続先の受け取りに使う ([architecture.md](architecture.md#ニコニコとの連携-denpa-hub))。テストでは偽物を指す                                                                                                                            |
| `UPDATE_CHECK_INTERVAL`                 | `3600000`                                      | 新しいバージョンを確かめる間隔(ms)                                                                                                                                                                                                                                                                                                 |
| `ENCODE_CONCURRENCY`                    | `2`                                            | 録ったあとのエンコードを同時に走らせる本数。ジョブではなく ffmpeg の本数で数える (コーデックごとに 1 本。[encode.md](encode.md#同時に走る本数は-ffmpeg-の本数で数える))                                                                                                                                                            |
| `ENCODE_MAX_ATTEMPTS`                   | `5`                                            | 1 つのエンコードのジョブを取り出す上限。超えたら failed にして後ろを進める (プロセスごと落とすジョブでキューを塞がないため)。1 回の実行の中の ffmpeg の起こし直しは数えない                                                                                                                                                        |
| `HW_DEVICES`                            | `/dev/dri/renderD*`                            | Linux だけ。GPU のデバイスを探すパターン。当たったデバイスを全部試し、VA-API が初期化できたものでエンコードする。NVIDIA の GPU は `NVIDIA_DIR` で別に探す ([encode.md](encode.md#gpu-でエンコードする-va-api))                                                                                                                     |
| `RKMPP_DEVICE`                          | `/dev/mpp_service`                             | Linux だけ。Rockchip MPP のデバイス。在れば h264_rkmpp・hevc_rkmpp を試す ([encode.md](encode.md#rockchip-rk3588-でエンコードする))。MPP は決まった場所を自分で開くので、変えるのはテストで偽のデバイスを置くときだけ                                                                                                              |
| `NVIDIA_DIR`                            | `/dev`                                         | Linux だけ。NVIDIA の GPU のデバイスファイル (`nvidia0`・`nvidia1` …) を探すフォルダ。在れば NVENC を試す ([encode.md](encode.md#nvidia-でエンコードする))。ffmpeg は GPU を番号で受けるので、変えるのはテストで偽のデバイスを置くときだけ                                                                                         |
| `HW_PROBE_TIMEOUT`                      | `20000`                                        | GPU の試しのエンコード 1 本に待つ上限(ms)                                                                                                                                                                                                                                                                                          |
| `START_MARGIN` / `END_MARGIN`           | `10000` / `15000`                              | 録画の前後マージン(ms)。延長には EIT[p/f] で追従する                                                                                                                                                                                                                                                                               |
| `SCHEDULER_TICK`                        | `5000`                                         | 予約チェックの間隔(ms)                                                                                                                                                                                                                                                                                                             |
| `RECONCILE_INTERVAL`                    | `300000`                                       | 保存先の実体と DB を突き合わせる間隔(ms)。ディスク残量の確認と、古い履歴・ログインの控え・ペアリングコードなどの片付けも同じ周期                                                                                                                                                                                                   |
| `DISK_LOW_THRESHOLD`                    | `21474836480`                                  | 保存先の空きがこれ(バイト)を下回ったら通知する。既定は 20GB。`0` で確かめない。EPGStation からの引き継ぎも、このぶんを残して取り込めるかを先に確かめる ([migrate.md](migrate.md#録画-apirecordedapivideosid))                                                                                                                      |
| `AGENT_DOWN_GRACE`                      | `180000`                                       | チューナー(エージェント)に繋がらない状態がこれ(ms)続いたら通知する                                                                                                                                                                                                                                                                 |
| `EPG_COLLECT_INTERVAL`                  | `1800000`                                      | 番組表を集め直す局を選び直す間隔(ms)                                                                                                                                                                                                                                                                                               |
| `EPG_CHANNEL_INTERVAL`                  | `21600000`                                     | 同じチャンネルを集め直すまでの間(ms)                                                                                                                                                                                                                                                                                               |
| `EPG_CHANNEL_TIMEOUT`                   | `600000`                                       | 1 チャンネルを開いておく上限(ms)。普段は EIT が揃った時点で閉じる                                                                                                                                                                                                                                                                  |
| `EPG_SWEEP_SETTLE`                      | `60000`                                        | 衛星の全局ぶんを 1 中継で読むとき (BS の初回と CS)、新しい局が出てこなくなってから閉じるまで(ms)。`EPG_CHANNEL_TIMEOUT` より十分短くする                                                                                                                                                                                           |
| `EPG_MIN_COVERAGE`                      | `259200000`                                    | 番組表がここまで埋まっていない局は周期を待たずに集め直す(ms)                                                                                                                                                                                                                                                                       |
| `EPG_CHANNEL_RETRY`                     | `7200000`                                      | 集めに行った直後は、どれだけ薄く見えても行き直さない下限(ms)。EIT が来ない局を毎周回選ばないため                                                                                                                                                                                                                                   |
| `CHANNEL_SYNC_INTERVAL`                 | `60000`                                        | 局だけを取り直す間隔(ms)。スキャンの結果はここで届く                                                                                                                                                                                                                                                                               |
| `SERVICE_FORGET_AFTER`                  | `1800000`                                      | 局を見かけなくなってから番組表と予約を片付けるまで(ms)。1 回の欠けでは片付けない                                                                                                                                                                                                                                                   |
| `RULE_RETRACT_GRACE`                    | `3600000`                                      | 条件から外れた予約を引っ込めなくなる、放送開始までの余裕(ms)                                                                                                                                                                                                                                                                       |
| `BML_DNS`                               | `1.1.1.1,8.8.8.8`                              | データ放送の双方向で名前を引く DNS。家庭の DNS フィルタが局のドメインを 0.0.0.0 に落とすことがあるため。空なら OS の設定どおり                                                                                                                                                                                                     |
| `SHUTDOWN_WAIT`                         | `21600000`                                     | 止められたとき、録画が終わるまで待つ上限(ms)。`0` で待たない。エージェントも同じ変数を見る                                                                                                                                                                                                                                         |
| `OIDC_ISSUER`                           | (空)                                           | OIDC の発行元。`OIDC_CLIENT_ID`・`OIDC_CLIENT_SECRET` と 3 つ揃うと OIDC が有効になる ([auth.md](auth.md#oidc-でのログイン))                                                                                                                                                                                                       |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | (空)                                           | アプリ登録の ID とシークレット                                                                                                                                                                                                                                                                                                     |
| `OIDC_GROUP`                            | (空)                                           | このグループかロールを持つ人だけ通す。空なら入れた人は全員                                                                                                                                                                                                                                                                         |
| `OIDC_SESSION_TTL`                      | `2592000000`                                   | ログインの有効期間(ms)。既定 30 日                                                                                                                                                                                                                                                                                                 |
| `TRUSTED_NETWORKS`                      | (空)                                           | CIDR (IPv4・IPv6) のカンマ区切り。ここから知っている名前 (`ALLOWED_HOSTS`) で来たら認証を掛けない ([auth.md](auth.md#ネットワークの中なら何も聞かない))                                                                                                                                                                            |
| `TRUSTED_PROXIES`                       | (空)                                           | 前段 (リバースプロキシ) のアドレス。CIDR のカンマ区切り。入口の `server.js` が読む。前段があるのに空だと `TRUSTED_NETWORKS` が誰にも当たらない ([auth.md](auth.md#前段の後ろに置くとき-trusted_proxies))                                                                                                                           |
| `ALLOWED_HOSTS`                         | (空)                                           | 信頼するネットワークからログインなしで開いてよい名前のカンマ区切り。先頭にドットでその下の名前全部。IP の直書き・`.local` などは書かなくても通る ([auth.md](auth.md#ログインなしで開ける名前-allowed_hosts))                                                                                                                       |
| `HOST_HEADER`                           | (空)                                           | 名前を読むヘッダ (adapter-bun が読む。空なら `Host`)。前段が名前を別のヘッダで渡すときだけ書く。書くと、`ALLOWED_HOSTS` の確かめは `Host` とこのヘッダの両方に掛かる                                                                                                                                                               |
| `PORT` / `HOST`                         | `3000` / `0.0.0.0`                             | 待ち受けるポートとアドレス (adapter-bun が読む)                                                                                                                                                                                                                                                                                    |
| `BODY_SIZE_LIMIT`                       | `512K`                                         | 受け取るリクエストの本文の上限 (adapter-bun が読む。超えると 413)。別の機械へ移すときの取り込みは 256 KiB ずつ送るので、`256K` より小さくしない                                                                                                                                                                                    |
| `PWA_NAMES`                             | (空)                                           | `ホスト名=表示名` のカンマ区切り。ホーム画面に置いたときの名前を、来た名前ごとに変える ([watch.md](watch.md#ホーム画面に置く))                                                                                                                                                                                                     |
| `DENPA_AUTOSTART`                       | `1`                                            | 空・`1`・`true` なら常駐処理を動かす。ほかの値 (`0` など) で番組表の取得・スケジューラ・エンコーダなどを止める (単体テスト用。GPU の確認・ライブのエンドポイント・異常終了した録画の回収・新しいバージョンの確認は動かす)                                                                                                          |

`ADDRESS_HEADER` と `PROTOCOL_HEADER` は読みません。`server.js` が adapter-bun 向けにそれぞれ `x-denpa-remote` と
`x-forwarded-proto` に固定します (`ADDRESS_HEADER` が設定してあれば起動時に 1 行知らせる)。

## チューナーエージェント

エージェント (`agent/`) が読む変数です。ふつうは何も書きません。

| 変数                                                                          | 既定値                                                                                                                                              | 説明                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_PORT`                                                                  | `25252`                                                                                                                                             | 待ち受けるポート                                                                                                                                                                                                                                 |
| `AGENT_HOST`                                                                  | 全部のインターフェース                                                                                                                              | 待ち受けるアドレス (IP アドレス)。Mac の `install.sh` は同じ Mac の denpa と組むとき、Android のアプリは同じ端末の denpa と組むとき `127.0.0.1` にする。組んだ denpa しか通さないが、届く範囲も絞る ([agent.md](agent.md#denpa-とは-tls-で組む)) |
| `AGENT_PAIR_TOKEN`                                                            | (空。`tls/pair-token` に作る)                                                                                                                       | denpa と組むときの合言葉。denpa の `TUNER_AGENT_URL` の `#pair=` と同じ値。compose・Helm は両方に同じ値を渡す。空ならエージェントが `tuners.json` の隣の `tls/pair-token` に作る ([agent.md](agent.md#denpa-とは-tls-で組む))                    |
| `TUNERS_FILE` / `CHANNELS_FILE`                                               | `/config/tuners.json` / `/config/channels.json` (Mac・Windows と、`USB_BROKER` があるときは `$DENPA_HOME/config/`。`DENPA_HOME` の既定は `~/denpa`) | チューナーとチャンネルの設定 ([agent.md](agent.md#設定はファイルに分ける))                                                                                                                                                                       |
| `MEDIA_DIR` / `RAW_DIR`                                                       | denpa と同じ                                                                                                                                        | 元の TS の置き場                                                                                                                                                                                                                                 |
| `SHUTDOWN_WAIT`                                                               | denpa と同じ                                                                                                                                        | 止められたとき、録画が終わるまで待つ上限(ms)。待っている間にもう一度止めると、待たずに止まる ([agent.md](agent.md#止められたら録画が終わるまで待つ))                                                                                             |
| `DENPA_VERSION`                                                               | denpa と同じ                                                                                                                                        | 動いているバージョン (Linux のイメージだけ。Mac と Windows の実行ファイルは中に持つ。About.cs)                                                                                                                                                   |
| `CARD_URL`                                                                    | (空)                                                                                                                                                | 手元にカードが無い拠点だけ。鍵を貰う先 (配る側の `CARD_SHARE_PORT`)                                                                                                                                                                              |
| `CARD_SHARE_PORT` / `CARD_SHARE_NETWORKS` / `CARD_TTL` / `CARD_SHARE_MAX_RTT` | 配らない                                                                                                                                            | 鍵を配る拠点の決まり。既定と書ける範囲は [agent.md](agent.md#鍵を配るのは-lan-の中だけ)                                                                                                                                                          |
| `ASICEN_USERLAND_DIR` / `ASICEN_FIRMWARE` / `ASICEN_RUNTIME_DIR`              | イメージの既定                                                                                                                                      | asicen-userland の置き場とファームウェアとソケットの置き場 (Linux のイメージだけ。[tuners.md](tuners.md#px-w3u3-など-asicen-userland試験的))                                                                                                     |
| `SIANO_FIRMWARE`                                                              | (空)                                                                                                                                                | PX-S1UD などの Siano の機材に送るファームウェアのファイル。空なら、エージェントに同梱している `isdbt_rio.inp` を使う ([tuner-px-s1ud.md](tuner-px-s1ud.md#設定))。前のバージョンにあった `SIANO_USERLAND_DIR` は読まない                         |
| `USB_BROKER`                                                                  | (空)                                                                                                                                                | Android のアプリから USB の機材の fd を受け取るソケットのパス。アプリが渡す。あれば sysfs を読まず、受け取った機材だけを使う ([agent.md](agent.md#android-でアプリから-usb-を受け取る))                                                          |
| `FAKE_TUNE`                                                                   | (空)                                                                                                                                                | 偽の選局。適合テストだけが使う                                                                                                                                                                                                                   |

## px4-userland を外した (前のバージョンから上げるとき)

**PLEX・e-Better の IT930x の機材は、どれもエージェントが USB を直に持つようになり、px4-userland (px4d) は同梱も起動もしなくなりました** ([tuner-it930x.md](tuner-it930x.md))。

- **`px4:` の受信機は `it930x:` に書き換えるか、自動検出に戻す。** 設定に `px4:<筐体の番号>:<受信機>` で残っているチューナーは、対応していないデバイスとして断られ、選局に使われない。
  設定の「受信」の「チューナー」で、その行の「⋯」の「デバイス」を `it930x:<USB のポート>:<受信機>` に書き換えるか、「自動検出に戻す」を押す (書いた内容が全部消える)。
  受信機の番号は `px4:` のときと同じ。PX-Q3 系は、`px4:` の受信機 0〜3 が 1 つ目の USB デバイスの 0〜3、4〜7 が 2 つ目の USB デバイスの 0〜3 になる。
  USB のポートは `denpa-agent --it930x-probe` (エージェントを止めてから流す) の出力にある
- 内蔵カードリーダーの名前が変わる (「PLEX PX-Q3U4 4-1 Card Reader」のような名前)。前のリーダーの「使う」を外していたなら、新しいリーダーでもう一度外す
- Mac と Windows のインストーラは、上げるときに前のバージョンが置いた px4-userland (Windows は `%ProgramFiles%\denpa\px4-userland`、Mac は `/Library/Application Support/denpa/px4-userland`) と、
  px4d のソケットの置き場 (Windows の `C:\denpa-run`、Mac の `/Library/Application Support/denpa/run`) を消す。Linux のイメージには、もう `/opt/px4-userland` は入っていない
- エージェントは `it930x-firmware.bin` を `tuners.json` の隣に書き出さなくなった (ファームウェアは実行ファイルから機材へ直に送る)。前のバージョンが書いた `/config/it930x-firmware.bin` (Mac・Windows は `~/denpa/config/it930x-firmware.bin`) は、手で消してよい
- `PX4_USERLAND_DIR` / `PX4_RUNTIME_DIR` / `PX4_FIRMWARE` は読まない

## エージェントとの通信を TLS にした (前のバージョンから上げるとき)

**denpa とエージェントは HTTPS で繋ぎ、エージェントは合言葉で組んだ denpa にしか答えなくなりました** ([agent.md](agent.md#denpa-とは-tls-で組む))。
平文の HTTP は残していないので、denpa とエージェントは同じバージョンに上げます。

- `TUNER_AGENT_URL` は `https://` で書き、`#pair=<合言葉>` を付ける。`http://` のままだと、エージェントを呼ぶたびにエラーになる
- compose.prod.yml を写して使っているなら、新しいものに置き換え、同じ場所の `.env` に `AGENT_PAIR_TOKEN` を作る
  ([作り方](install.md#docker-compose-を手で置く))。無いと compose は止まる
- Linux・Mac・Windows のインストーラは流し直せば合言葉を作って両方に渡す。`denpa-aio` と Helm の `charts/denpa` は何もしなくてよい。
  エージェントだけ別に置いたとき (`charts/denpa-agent`・`--agent-only`・`-AgentOnly`) は、インストーラか `helm install` のあとに出る URL を denpa の `TUNER_AGENT_URL` に書く
- エージェントの `AGENT_ALLOWED_HOSTS` は読まない (組んだ denpa しか通さないので要らなくなった)

## 接続元の読み方を変えた (前のバージョンから上げるとき)

**`ADDRESS_HEADER` を読まなくなりました。** 前段 (リバースプロキシ) の後ろに置いているなら、前段の
アドレスを `TRUSTED_PROXIES` に書きます (chart は `denpa.trustedProxies`)。古い名前を読み替える仕組みは持ちません。
決め方と書き方の例は [auth.md](auth.md#前段の後ろに置くとき-trusted_proxies) にあります。

- 前は `ADDRESS_HEADER=x-forwarded-for` を渡すと、**誰から来た** `X-Forwarded-For` でも右端を信じていた。
  denpa のポートへ前段を通らずに届く経路があると、ヘッダを付けるだけで `TRUSTED_NETWORKS` を名乗れた。
  いまは段数 (前の `XFF_DEPTH`) も数えなくてよい
- **置き換えないまま上げると**、前段越しの接続元が前段のアドレスになる。前段のアドレスが `TRUSTED_NETWORKS` に
  入っていなければ、`TRUSTED_NETWORKS` から来ていた人にもログインを求める (OIDC が無ければ断る)。
  入っていると前段越しの全員が通るので、起動時に警告を出す ([下記](#信頼するネットワークを絞った-前のバージョンから上げるとき))
- 前段が無い構成 (compose の既定・Mac と Windows のインストーラ・`denpa-aio`) は何もしなくてよい。
  Linux のインストーラが前に立てる genkan (Caddy) は、下の「信頼するネットワークを絞った」を見る

## 信頼するネットワークを絞った (前のバージョンから上げるとき)

**既定の `TRUSTED_NETWORKS` から Docker のネットワーク (`172.16.0.0/12`) を外し、信頼するネットワークから
ログインなしで通すのを、知っている名前で来たときだけにしました** ([auth.md](auth.md#ログインなしで開ける名前-allowed_hosts))。
前段を同じネットワークに置いて `TRUSTED_PROXIES` を書き忘れると全員が通ってしまうことと、DNS リバインディングで
LAN の人のブラウザから読み書きされることを防ぐためです。

- **外で引ける名前 (自分のドメイン・Tailscale の `.ts.net` など) を LAN の IP に向けて、ログインなしで開いているなら、
  `ALLOWED_HOSTS` に足す。** 足さないと、OIDC があればログインを求められ、無ければ 403 になる。`PWA_NAMES` に
  書いた名前と、Helm の `httpRoute.hostnames`・`ingress.hosts` の名前はそのまま通る。IP の直書き・
  `.local`・`.lan` などの名前も何もしなくてよい
- compose の既定は `192.168.0.0/16,10.0.0.0/8` になった。前の compose を写して使っているなら、`172.16.0.0/12` を
  消すのを勧める (残したままで前段がいなければ開きはしないが、起動時に警告が出る)。
  Docker を動かしているマシンのブラウザから `localhost:3000` で入っていたなら、`http://<そのマシンの IP>:3000` で開く
- **Linux のインストーラで genkan (`http://denpa.localhost`) を使っているなら、install.sh を流し直す。**
  compose.override.yml には触らないので、足す行 (`TRUSTED_PROXIES` と genkan のゲートウェイ) を画面に出す。
  新しく入れるときは install.sh が書く
- Windows のインストーラは、`denpa.env` が無いときだけ作る。前に作った `denpa.env` の `172.16.0.0/12` は消してよい
  (この PC のブラウザはループバック、LAN の機器は本当の IP で届くので要らない)

## 置き場を変えた (前のバージョンから上げるとき)

既定の置き場を、中身ごとに 1 つの名前にそろえました。**古い名前を読み替える仕組みは持たない**ので、
既定のまま使っていた環境は、上げるときにマウント先を書き換えます。ボリュームや PVC の中身はそのまま使えます。

| 中身                   | 前                                 | いま                                 |
| ---------------------- | ---------------------------------- | ------------------------------------ |
| DB・局ロゴ             | `/app/data`                        | `/data`                              |
| 元の TS (本体)         | `/app/recorded` (`RECORDED_DIR`)   | `/media/raw` (`RAW_DIR`)             |
| 元の TS (エージェント) | `/denpa-recorded` (`RECORDED_DIR`) | `/media/raw` (`RAW_DIR`。本体と同じ) |
| エンコードしたもの     | `/library` (`LIBRARY_DIR`)         | `/media/encoded` (`ENCODED_DIR`)     |
| エージェントの設定     | `/app-config`                      | `/config`                            |

- `RECORDED_DIR` / `LIBRARY_DIR` は読まない (残っていたら本体が起動時に記録で知らせる)。置き場を変えていたなら
  `RAW_DIR` / `ENCODED_DIR` に書き直すか、親の `MEDIA_DIR` 1 つにまとめる (本体とエージェントの両方が見る)
- **DB の中の録画ファイルの場所は、起動時のマイグレーションで置き場からの相対に直る**
  (`drizzle/0002_relative-media-paths.sql`。元の TS はファイル名、エンコードしたものは `シリーズ/ファイル`)。
  以後は置き場をどこへ移しても DB は触らずに済む (`schema.ts` の `mediaPath`)
- **上げる前に DB を控えておく** (マイグレーションは行を書き換える)。置き場の外を指していた行も、
  ファイル名 (エンコードしたものは最後の 2 段) だけが残って新しい置き場の下として引かれる。
  置き場の外に録画を置いていたなら、先に置き場へ寄せる
- このリポジトリの compose・chart・`denpa-aio`・Mac / Windows のインストーラは一緒に直してある。
  Mac / Windows はインストーラを流し直すとエージェントの変数 (`RAW_DIR`) が書き直る
- Helm は PVC の名前も変えた ([install.md](install.md#pvc-の名前を変えた-前のバージョンから上げるとき))
