# 環境変数

**環境変数にするのは、外から差し替える理由があるものだけです** (相手の場所と、テストで詰めたい間隔)。
それ以外の値は `src/lib/server/config.ts` に直に書いてあり、画面から変えるものは設定にあります
(`src/lib/server/settings.ts`。[app.md の画面](app.md#画面)の `/settings` の行)。
ふつう書くのは、既定値では決められないもの (誰を通すか・前段・OIDC・PWA の名前) だけです。
Helm では `charts/denpa/values.yaml` のキーで渡します。チューナーエージェントの変数は[下](#チューナーエージェント)。

| 変数                                         | 既定値                                         | 説明                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TUNER_AGENT_URL`                            | `http://tuner-agent:25252`                     | チューナーエージェント。選局もカードも復号もここ1つ                                                                                                                                                                        |
| `DENPA_DB`                                   | `/data/denpa.db`                               | SQLite の置き場。局ロゴと CM検出のために覚えたロゴもこの隣 (`logos/`)                                                                                                                                                      |
| `MEDIA_DIR`                                  | `/media`                                       | 録画の置き場の親。元のTSは `raw`、エンコードしたものは `encoded` に分けて置く。エージェントも同じ変数を見る                                                                                                                |
| `RAW_DIR`                                    | `$MEDIA_DIR/raw`                               | 元のTSの作業領域。別のディスクへ移すときは `ENCODED_DIR` と同じく、マウントを付け替える                                                                                                                                    |
| `ENCODED_DIR`                                | `$MEDIA_DIR/encoded`                           | エンコード済みの置き場。ここから配る。録画を入れたあとに別のディスクへ移すなら、これは変えずにマウントを付け替える ([library.md](library.md#置き場を別のディスクに移す))                                                   |
| `FFMPEG` / `FFPROBE`                         | `/usr/local/bin/...`                           | 開発時は偽物に差し替える                                                                                                                                                                                                   |
| `MPEG2_DIR`                                  | `/opt/denpa/mpeg2`                             | ライブを変換せずに見るときにブラウザへ配る MPEG-2 と AAC のデコーダ (WASM) の置き場。イメージの `mpeg2wasm` 段が置く。無ければこの方式は使えず、エンコードしたものに戻る ([stream.md](stream.md#放送そのままmpeg-2を送る)) |
| `DENPA_VERSION`                              | `dev`                                          | 動いているバージョン。リリースのイメージにだけ入る (`.github/release.Dockerfile`)。`dev` なら新しいバージョンの通知を出さない                                                                                              |
| `DENPA_GITHUB_API`                           | `https://api.github.com/repos/danything/denpa` | 新しいバージョンを確かめる先 (`releases/latest`)。試験では偽物を指す                                                                                                                                                       |
| `UPDATE_CHECK_INTERVAL`                      | `3600000`                                      | 新しいバージョンを確かめる間隔(ms)                                                                                                                                                                                         |
| `ENCODE_CONCURRENCY`                         | `2`                                            | 録画エンコードの同時実行数                                                                                                                                                                                                 |
| `ENCODE_MAX_ATTEMPTS`                        | `5`                                            | 1つのエンコードを試す上限。超えたら failed にして後ろを進める (プロセスごと落とすジョブでキューを塞がないため)                                                                                                             |
| `HW_DEVICES`                                 | `/dev/dri/renderD*`                            | GPU のデバイスを探すパターン。当たったデバイスを全部試し、QSV / VA-API が初期化できたものでエンコードする ([encode.md](encode.md#gpu-でエンコードする-intel-qsv--va-api))                                                  |
| `HW_PROBE_TIMEOUT`                           | `20000`                                        | GPU の試しのエンコード1本に待つ上限(ms)                                                                                                                                                                                    |
| `START_MARGIN` / `END_MARGIN`                | `10000` / `15000`                              | 録画の前後マージン(ms)。延長には EIT[p/f] で追従する                                                                                                                                                                       |
| `SCHEDULER_TICK`                             | `5000`                                         | 予約チェックの間隔(ms)                                                                                                                                                                                                     |
| `RECONCILE_INTERVAL`                         | `300000`                                       | 保存先の実体とDBを突き合わせる間隔(ms)。ディスク残量の確認も同じ周期                                                                                                                                                       |
| `DISK_LOW_THRESHOLD`                         | `21474836480`                                  | 保存先の空きがこれ(バイト)を下回ったら通知する。既定は 20GB。`0` で確かめない                                                                                                                                              |
| `AGENT_DOWN_GRACE`                           | `180000`                                       | チューナー(エージェント)に繋がらない状態がこれ(ms)続いたら通知する                                                                                                                                                         |
| `EPG_COLLECT_INTERVAL`                       | `1800000`                                      | 番組表を集め直す局を選び直す間隔(ms)                                                                                                                                                                                       |
| `EPG_CHANNEL_INTERVAL`                       | `21600000`                                     | 同じチャンネルを集め直すまでの間(ms)                                                                                                                                                                                       |
| `EPG_CHANNEL_TIMEOUT`                        | `600000`                                       | 1チャンネルを開いておく上限(ms)。普段は EIT が揃った時点で閉じる                                                                                                                                                           |
| `EPG_SWEEP_SETTLE`                           | `60000`                                        | 初回に衛星の全局ぶんを1中継で読むとき、新しい局が出てこなくなってから閉じるまで(ms)。`EPG_CHANNEL_TIMEOUT` より十分短くする                                                                                                |
| `EPG_MIN_COVERAGE`                           | `259200000`                                    | 番組表がここまで埋まっていない局は周期を待たずに集め直す(ms)                                                                                                                                                               |
| `EPG_CHANNEL_RETRY`                          | `7200000`                                      | 集めに行った直後は、どれだけ薄く見えても行き直さない下限(ms)。EIT が来ない局を毎周回選ばないため                                                                                                                           |
| `CHANNEL_SYNC_INTERVAL`                      | `60000`                                        | 局だけを取り直す間隔(ms)。スキャンの結果はここで届く                                                                                                                                                                       |
| `SERVICE_FORGET_AFTER`                       | `1800000`                                      | 局を見かけなくなってから番組表と予約を片付けるまで(ms)。1回の欠けでは片付けない                                                                                                                                            |
| `RULE_RETRACT_GRACE`                         | `3600000`                                      | 条件から外れた予約を引っ込めなくなる、放送開始までの余裕(ms)                                                                                                                                                               |
| `CM_CUT_MARGIN`                              | `0.8`                                          | CMを実カットするとき、境目にキーフレームが無ければ CM 側へ寄せてよい長さ(秒)                                                                                                                                               |
| `BML_DNS`                                    | `1.1.1.1,8.8.8.8`                              | データ放送の双方向で名前を引く DNS。家庭の DNS フィルタが局のドメインを 0.0.0.0 に落とすことがあるため。空なら OS の設定どおり                                                                                             |
| `SHUTDOWN_WAIT`                              | `21600000`                                     | 止められたとき、録画が終わるまで待つ上限(ms)。`0` で待たない。エージェントも同じ変数を見る                                                                                                                                 |
| `OIDC_ISSUER`                                | (空)                                           | OIDC の発行元。`OIDC_CLIENT_ID`・`OIDC_CLIENT_SECRET` と3つ揃うと OIDC が有効になる ([auth.md](auth.md#oidc-でのログイン))                                                                                                 |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`      | (空)                                           | アプリ登録のIDとシークレット                                                                                                                                                                                               |
| `OIDC_GROUP`                                 | (空)                                           | このグループかロールを持つ人だけ通す。空なら入れた人は全員                                                                                                                                                                 |
| `OIDC_SESSION_TTL`                           | `2592000000`                                   | ログインの有効期間(ms)。既定30日                                                                                                                                                                                           |
| `TRUSTED_NETWORKS`                           | (空)                                           | CIDR (IPv4・IPv6) のカンマ区切り。ここから来たら認証を掛けない ([auth.md](auth.md#ネットワークの中なら何も聞かない))                                                                                                       |
| `TRUSTED_PROXIES`                            | (空)                                           | 前段 (リバースプロキシ) のアドレス。CIDR のカンマ区切り。入口の `server.js` が読む。前段があるのに空だと `TRUSTED_NETWORKS` が誰にも当たらない ([auth.md](auth.md#前段の後ろに置くとき-trusted_proxies))                   |
| `PORT` / `HOST`                              | `3000` / `0.0.0.0`                             | 待ち受けるポートとアドレス (adapter-bun が読む)                                                                                                                                                                            |
| `BODY_SIZE_LIMIT`                            | `512K`                                         | 受け取るリクエストの本文の上限 (adapter-bun が読む。超えると 413)                                                                                                                                                          |
| `PWA_NAMES`                                  | (空)                                           | `ホスト名=表示名` のカンマ区切り。ホーム画面に置いたときの名前を、来た名前ごとに変える ([watch.md](watch.md#ホーム画面に置く))                                                                                             |
| `EPGSTATION_RECORDED_DIR`                    | `/epgstation-recorded`                         | 引き継ぎ元の録画置き場をマウントした場所 ([migrate.md](migrate.md))                                                                                                                                                        |
| `EPGSTATION_DB_HOST` / `_PORT`               | `db` / `3306`                                  | 引き継ぎ元の MariaDB                                                                                                                                                                                                       |
| `EPGSTATION_DB_USER` / `_PASSWORD` / `_NAME` | `root` / `epgstation` / `epgstation`           | 〃                                                                                                                                                                                                                         |
| `DENPA_AUTOSTART`                            | `1`                                            | `1` か `true` のときだけ常駐処理を動かす。`0` などで止める                                                                                                                                                                 |

`ADDRESS_HEADER` と `PROTOCOL_HEADER` は読みません。`server.js` が adapter-bun 向けにそれぞれ `x-denpa-remote` と
`x-forwarded-proto` に固定します (`ADDRESS_HEADER` が設定してあれば起動時に1行知らせる)。

## チューナーエージェント

エージェント (`agent/`) が読む変数です。ふつうは何も書きません。

| 変数                                                                                                                                                               | 既定値                                          | 説明                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_PORT`                                                                                                                                                       | `25252`                                         | 待ち受けるポート                                                                                                                                                 |
| `TUNERS_FILE` / `CHANNELS_FILE`                                                                                                                                    | `/config/tuners.json` / `/config/channels.json` | チューナーとチャンネルの設定 ([agent.md](agent.md#設定は2つのファイルに分ける))                                                                                  |
| `MEDIA_DIR` / `RAW_DIR`                                                                                                                                            | denpa と同じ                                    | 元のTSの置き場                                                                                                                                                   |
| `SHUTDOWN_WAIT`                                                                                                                                                    | denpa と同じ                                    | 止められたとき、録画が終わるまで待つ上限(ms)                                                                                                                     |
| `CARD_URL`                                                                                                                                                         | (空)                                            | 手元にカードが無い拠点だけ。鍵を貰う先 (配る側の `CARD_SHARE_PORT`)                                                                                              |
| `CARD_SHARE_PORT` / `CARD_SHARE_NETWORKS` / `CARD_TTL` / `CARD_SHARE_MAX_RTT`                                                                                      | 配らない                                        | 鍵を配る拠点の決まり。既定と書ける範囲は [agent.md](agent.md#鍵を配るのは-lan-の中だけ)                                                                          |
| `PX4_USERLAND_DIR` / `PX4_FIRMWARE` / `PX4_RUNTIME_DIR`・`SIANO_USERLAND_DIR` / `SIANO_FIRMWARE`・`ASICEN_USERLAND_DIR` / `ASICEN_FIRMWARE` / `ASICEN_RUNTIME_DIR` | イメージの既定                                  | 同梱のドライバの置き場。書き換えるのは Mac の `install.sh` と Windows の `install.ps1` (`PX4_*`・`SIANO_*`。Windows の `PX4_RUNTIME_DIR` は `C:\denpa-run`) だけ |
| `FAKE_TUNE`                                                                                                                                                        | (空)                                            | 偽の選局。適合テストだけが使う                                                                                                                                   |

## 録画のダウンロードを無くした (前のバージョンから上げるとき)

**録画をファイルとして外へ持ち出す機能はやめました** (理由は [library.md](library.md#観るのはブラウザで))。
録画の詳細と番組表の詳細からダウンロードのボタンが無くなり、`/api/recordings/<id>/file` は `?download=1` を読まず、
添付 (`Content-Disposition`) も付けません。ブラウザ・テレビのアプリでの再生と、端末に保存はこれまでどおりです。

## 再生リンクをやめた (前のバージョンから上げるとき)

**「再生リンクをコピー」と、それが作っていた期限付きの URL (`/api/recordings/<id>/file?token=…`) をやめました。**
外部のプレイヤーには対応しないので、ログインせずに録画を開ける URL を出す理由が無くなりました。

- **出したリンクは、上げた時点で開けなくなる** (期限内でも)。テーブル (`share_links`) はマイグレーションで消える
  (`drizzle/0011_drop-share-links.sql`)。リンクを作る API (`POST /api/recordings/<id>/share`) も無くなった
- 画面からの再生は、画面と同じ資格 (信頼したネットワークか、ログインの Cookie) でファイルのエンドポイントから取得する
- ファイルのエンドポイントを資格なしで呼んだときの答えが、403 (text/plain) から、ほかの API と同じ 401 の JSON に
  なった (ログイン方法を何も設定していない denpa は、これまでどおり 403)
- テレビのアプリ (denpa-tv) はアクセストークンで開くので、何もしなくてよい

## 接続元の読み方を変えた (前のバージョンから上げるとき)

**`ADDRESS_HEADER` を読まなくなりました。** 前段 (リバースプロキシ) の後ろに置いているなら、前段の
アドレスを `TRUSTED_PROXIES` に書きます (chart は `denpa.trustedProxies`)。古い名前を読み替える仕組みは持ちません。
決め方と書き方の例は [auth.md](auth.md#前段の後ろに置くとき-trusted_proxies) にあります。

- 前は `ADDRESS_HEADER=x-forwarded-for` を渡すと、**誰から来た** `X-Forwarded-For` でも右端を信じていた。
  denpa のポートへ前段を通らずに届く経路があると、ヘッダを付けるだけで `TRUSTED_NETWORKS` を名乗れた。
  いまは段数 (前の `XFF_DEPTH`) も数えなくてよい
- **置き換えないまま上げると、安全側に倒れる。** 前段越しの接続元が前段のアドレスになり、
  `TRUSTED_NETWORKS` から来ていた人にもログインを求める (OIDC が無ければ断る)。開きはしない
- 前段が無い構成 (compose の既定・Windows のインストーラ・`denpa-aio`) は何もしなくてよい。
  Linux・Mac のインストーラは前に genkan (Caddy) を立てるが、genkan のアドレスは既定の
  `TRUSTED_NETWORKS` に入り、私設網の外は genkan が断るので、こちらも何もしなくてよい

## 置き場を変えた (前のバージョンから上げるとき)

既定の置き場を、中身ごとに1つの名前にそろえました。**古い名前を読み替える仕組みは持たない**ので、
既定のまま使っていた環境は、上げるときにマウント先を書き換えます。ボリュームや PVC の中身はそのまま使えます。

| 中身                  | 前                                 | いま                                 |
| --------------------- | ---------------------------------- | ------------------------------------ |
| DB・局ロゴ            | `/app/data`                        | `/data`                              |
| 元のTS (本体)         | `/app/recorded` (`RECORDED_DIR`)   | `/media/raw` (`RAW_DIR`)             |
| 元のTS (エージェント) | `/denpa-recorded` (`RECORDED_DIR`) | `/media/raw` (`RAW_DIR`。本体と同じ) |
| エンコードしたもの    | `/library` (`LIBRARY_DIR`)         | `/media/encoded` (`ENCODED_DIR`)     |
| エージェントの設定    | `/app-config`                      | `/config`                            |

- `RECORDED_DIR` / `LIBRARY_DIR` は読まない (残っていたら本体が起動時に記録で知らせる)。置き場を変えていたなら
  `RAW_DIR` / `ENCODED_DIR` に書き直すか、親の `MEDIA_DIR` 1つにまとめる (本体とエージェントの両方が見る)
- **DB の中の録画ファイルの場所は、起動時のマイグレーションで置き場からの相対に直る**
  (`drizzle/0002_relative-media-paths.sql`。元のTS はファイル名、エンコードしたものは `シリーズ/ファイル`)。
  以後は置き場をどこへ移しても DB は触らずに済む (`schema.ts` の `mediaPath`)
- **上げる前に DB を控えておく** (マイグレーションは行を書き換える)。置き場の外を指していた行も、
  ファイル名 (エンコードしたものは最後の2段) だけが残って新しい置き場の下として引かれる。
  置き場の外に録画を置いていたなら、先に置き場へ寄せる
- このリポジトリの compose・chart・`denpa-aio`・Mac / Windows のインストーラは一緒に直してある。
  Mac / Windows はインストーラを流し直すとエージェントの変数 (`RAW_DIR`) が書き直る

## Helm の PVC の名前も置き場にそろえた

**chart の PVC と values のキーを `raw` / `encoded` に改めました。**

| 中身               | 前 (PVC / values のキー)                  | いま                                    |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| 元のTS             | `denpa-recorded` / `persistence.recorded` | `denpa-raw` / `persistence.raw`         |
| エンコードしたもの | `denpa-library` / `persistence.library`   | `denpa-encoded` / `persistence.encoded` |

**そのまま上げると、新しい名前の空の PVC ができます。** 古い PVC は `helm.sh/resource-policy: keep`
で残るので消えはしませんが、録画は見えなくなります。どちらかで繋ぎます。

- **古い PVC をそのまま使う**: `persistence.raw.existingClaim: denpa-recorded` /
  `persistence.encoded.existingClaim: denpa-library`(denpa-agent の chart は `persistence.raw.existingClaim`)
- **名前ごと移す**: アプリを止め、PV の reclaim を `Retain` にして古い PVC を消し、PV の
  `claimRef` を外してから、新しい名前の PVC を `volumeName` で同じ PV に結ぶ。中身はコピーしない

compose の名前付きボリューム (`denpa-recorded` / `denpa-library`) は変えていません。
