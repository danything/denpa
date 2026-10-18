# 環境変数

**環境変数にするのは、外から差し替える理由があるものだけです** (相手の場所と、テストで詰めたい間隔)。
それ以外の値は `src/lib/server/config.ts` に直に書いてあります。画面から変えるものは設定画面
(`src/lib/server/settings.ts`。何があるかは [app.md の画面](app.md#画面)の `/settings` の行)。

ふつう書くのは、既定値では決められないもの (誰を通すか・前段・OIDC・PWA の名前) だけです。
Helm では `charts/denpa/values.yaml` のキーで渡します。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `TUNER_AGENT_URL` | `http://tuner-agent:25252` | チューナーエージェント。選局もカードも解除もここ1つ |
| `DENPA_DB` | `/data/denpa.db` | SQLite の置き場。局ロゴと CM検出のために覚えたロゴもこの隣 (`logos/`) |
| `MEDIA_DIR` | `/media` | 録画の置き場の親。元のTSは `raw`、エンコードしたものは `encoded` に分けて置く。エージェントも同じ変数を見る |
| `RAW_DIR` | `$MEDIA_DIR/raw` | 元のTSの作業領域。別のディスクに分けたいときだけ |
| `ENCODED_DIR` | `$MEDIA_DIR/encoded` | エンコード済みの置き場。ここから配る。別のディスクに分けたいときだけ |
| `FFMPEG` / `FFPROBE` | `/usr/local/bin/...` | 開発時は偽物に差し替える |
| `MPEG2_DIR` | `/opt/denpa/mpeg2` | ライブを変換せずに見るときにブラウザへ配る MPEG-2 と AAC のデコーダ (WASM) の置き場。イメージの `mpeg2wasm` 段が置く。無ければこの経路は使えず、エンコードしたものに戻る ([stream.md](stream.md#放送そのままmpeg-2を送る)) |
| `DENPA_VERSION` | `dev` | 動いている版。リリースのイメージにだけ入る (リリース時に main のイメージへ 1 層足す。`.github/release.Dockerfile`)。`dev` (develop・手元) なら新しい版の通知を出さない |
| `DENPA_GITHUB_API` | `https://api.github.com/repos/danything/denpa` | 新しい版を見に行く先 (`releases/latest`)。試験では偽物を指す |
| `UPDATE_CHECK_INTERVAL` | 1時間 | 新しい版を見に行く間隔 (ms) |
| `ENCODE_CONCURRENCY` | `1` | 録画エンコードの同時実行数。同梱の compose と chart は `2` にしてある |
| `HW_DEVICES` | `/dev/dri/renderD*` | GPU のデバイスを探すパターン。当たったデバイスを全部試し、QSV / VA-API が初期化できたものでエンコードする ([encode.md](encode.md)「GPU でエンコードする」) |
| `HW_PROBE_TIMEOUT` | `20000` | GPU の試しのエンコード1本に待つ上限(ms) |
| `ENCODE_MAX_ATTEMPTS` | `5` | 1つのエンコードを試す上限。超えたら failed にして後ろを進める (プロセスごと落とす毒ジョブでキューを塞がないため) |
| `START_MARGIN` / `END_MARGIN` | `10000` / `15000` | 録画の前後マージン(ms)。延長には EIT[p/f] で追従する |
| `SCHEDULER_TICK` | `5000` | 予約チェックの間隔(ms) |
| `RECONCILE_INTERVAL` | `300000` | 保存先の実体とDBを突き合わせる間隔(ms)。ディスク残量の見張りも同じ周期 |
| `DISK_LOW_THRESHOLD` | `21474836480` | 保存先の空きがこれ(バイト)を下回ったら通知する。既定は 20GB。`0` で見張らない |
| `AGENT_DOWN_GRACE` | `180000` | チューナー(エージェント)に繋がらない状態がこれ(ms)続いたら通知する。一瞬の切れでは鳴らさない |
| `EPG_COLLECT_INTERVAL` | `1800000` | 番組表を集め直す局を選び直す間隔(ms) |
| `EPG_CHANNEL_INTERVAL` | `21600000` | 同じチャンネルを集め直すまでの間(ms) |
| `EPG_CHANNEL_TIMEOUT` | `600000` | 1チャンネルを開いておく上限(ms)。普段は EIT が揃った時点で閉じる |
| `EPG_SWEEP_SETTLE` | `60000` | 初回に衛星の全局ぶんを1中継で読むとき、新しい局が出てこなくなってから閉じるまで(ms)。`EPG_CHANNEL_TIMEOUT` より十分短くする (全局が揃うのに約6分かかる) |
| `EPG_MIN_COVERAGE` | `259200000` | 番組表がここまで埋まっていない局は周期を待たずに集め直す(ms) |
| `EPG_CHANNEL_RETRY` | `7200000` | 集めに行った直後は、どれだけ薄く見えても行き直さない下限(ms)。EIT が来ない局を毎周回選ばないため |
| `CHANNEL_SYNC_INTERVAL` | `60000` | 局だけを取り直す間隔(ms)。スキャンの結果はここで届く |
| `SERVICE_FORGET_AFTER` | `1800000` | 局を見かけなくなってから持ち物を片付けるまで(ms)。1回の欠けでは片付けない |
| `RULE_RETRACT_GRACE` | `3600000` | 条件から外れた予約を引っ込めなくなる、放送開始までの余裕(ms) |
| `CM_CUT_MARGIN` | `0.8` | CMを実カットするとき、境目にキーフレームが無ければ CM 側へ寄せてよい長さ(秒) |
| `BML_DNS` | `1.1.1.1,8.8.8.8` | データ放送の双方向で名前を引く DNS。家庭の DNS フィルタが局のドメインを 0.0.0.0 に落とすことがあるので、素の DNS を名指しする。空なら OS の設定どおり |
| `SHUTDOWN_WAIT` | `21600000` | 止められたとき、録画が終わるまで待つ上限(ms)。`0` で待たない。エージェントも同じ変数を見る |
| `OIDC_ISSUER` | (空) | OIDC の発行元。ここを含む3つが揃うと OIDC が有効になる ([auth.md](auth.md)) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | (空) | アプリ登録のIDと秘密 |
| `OIDC_GROUP` | (空) | このグループにいる人だけ通す。空なら入れた人は全員 |
| `TRUSTED_NETWORKS` | (空) | CIDR (IPv4・IPv6) のカンマ区切り。ここから来たら認証を掛けない (前段があるなら `TRUSTED_PROXIES` も要る) |
| `TRUSTED_PROXIES` | (空) | 前段 (リバースプロキシ) のアドレス。CIDR (IPv4・IPv6) のカンマ区切り。直の相手がここに当たるときだけ `X-Forwarded-For` を右から辿り、前段でない最初のアドレスを接続元にする (`src/lib/server/address.ts`)。前段があるのに空だと `TRUSTED_NETWORKS` が誰にも当たらない ([auth.md](auth.md#前段の後ろに置くとき-trusted_proxies)) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 待ち受けるポートとアドレス (adapter-bun が読む) |
| `BODY_SIZE_LIMIT` | `512K` | 受け取るリクエストの本文の上限 (adapter-bun が読む。超えると 413) |
| `ADDRESS_HEADER` | — | 読みません (廃止。`TRUSTED_PROXIES` を使う)。設定してあれば起動時に知らせる。`server.js` が adapter-bun 向けに `x-denpa-remote` へ固定する |
| `PROTOCOL_HEADER` | — | 選べません。 `server.js` が常に `x-forwarded-proto` に固定します |
| `OIDC_SESSION_TTL` | `2592000000` | ログインの有効期間(ms)。既定30日 |
| `PWA_NAMES` | (空) | `ホスト名=表示名` のカンマ区切り。ホーム画面に置いたときの名前を、来た名前ごとに変える ([watch.md](watch.md#ホーム画面に置く)) |
| `EPGSTATION_RECORDED_DIR` | `/epgstation-recorded` | 引き継ぎ元の録画置き場をマウントした場所 ([migrate.md](migrate.md)) |
| `EPGSTATION_DB_HOST` / `_PORT` | `db` / `3306` | 引き継ぎ元の MariaDB |
| `EPGSTATION_DB_USER` / `_PASSWORD` / `_NAME` | `root` / `epgstation` / `epgstation` | 〃 |
| `DENPA_AUTOSTART` | `1` | `1` か `true` のときだけ常駐処理を動かす。`0` などで止める |

## 録画のダウンロードを無くした (前の版から上げるとき)

**録画をファイルとして外へ持ち出す機能はやめた** (理由は [library.md](library.md#観るのはブラウザで))。

- 録画の詳細 (「その他…」) と番組表の詳細から、ダウンロードのボタンが無くなった
- `/api/recordings/<id>/file` は `?download=1` を読まなくなり、添付 (`Content-Disposition`) を付けない。
  ブラウザ・テレビのアプリでの再生と、端末に保存 (denpa の中だけで観る) はこれまでどおり

## 再生リンクをやめた (前の版から上げるとき)

**「再生リンクをコピー」と、それが作っていた期限付きの URL (`/api/recordings/<id>/file?token=…`) をやめた。**
外部のプレイヤーには対応しないので、ログインせずに録画を開ける URL を出し続ける理由が無くなった。

- **出したリンクは、上げた時点で開けなくなる** (期限内でも)。控えのテーブル (`share_links`) は、上げるときの
  マイグレーションで消える (`drizzle/0011_drop-share-links.sql`)
- 画面からの再生は、URL にトークンを付けず、画面と同じ資格 (信頼したネットワークか、
  ログインの控えの Cookie) でファイルのエンドポイントから取得する
- リンクを作る API (`POST /api/recordings/<id>/share`) は無くなった
- ファイルのエンドポイントを資格なしで呼んだときの答えが、403 (text/plain) から、ほかの API と同じ 401 の JSON に
  なった (ログイン方法を何も設定していない denpa は、これまでどおり 403)
- テレビのアプリ (denpa-tv) はアクセストークンで開くので、何もしなくてよい

## 接続元の読み方を変えた (前の版から上げるとき)

**`ADDRESS_HEADER` を読まなくなった。** 前段 (リバースプロキシ) の後ろに置いているなら、前段の
アドレスを `TRUSTED_PROXIES` に書く (CIDR のカンマ区切り。chart は `denpa.trustedProxies`)。
**古い名前を読み替える仕組みは持たない** (`ADDRESS_HEADER` が残っていたら、起動時に1行知らせる)。

- 前は `ADDRESS_HEADER=x-forwarded-for` を渡すと、adapter-node が**誰から来た**
  `X-Forwarded-For` でも右端を信じていた。denpa のポート (:3000) へ前段を通らずに届く経路があると、
  ヘッダを付けるだけで `TRUSTED_NETWORKS` を名乗れた。前段を2段重ねると `XFF_DEPTH` も要った
- いまは入口 (`server.js`) が、直の相手が `TRUSTED_PROXIES` の中のときだけ `X-Forwarded-For` を読み、
  右から前段を飛ばして最初の前段でないアドレスを接続元にする (nginx の `set_real_ip_from` +
  `real_ip_recursive on` と同じ)。段数を数える必要はない
- **置き換えないまま上げると、安全側に倒れる。** 前段越しの接続元が前段のアドレスになり、
  `TRUSTED_NETWORKS` から来ていた人にもログインを求める (OIDC が無ければ断る)。開きはしない
- 前段が無い構成 (compose の既定・Windows のインストーラ・`denpa-aio`) は何もしなくてよい。
  Linux・Mac のインストーラは前に genkan (Caddy) を立てるが、genkan の住所は既定の
  `TRUSTED_NETWORKS` に入り、私設網の外は genkan が断るので、こちらも何もしなくてよい
- 前段のアドレスの例: Docker の compose で同じネットワークにいるなら `172.16.0.0/12`、Kubernetes の
  Pod や hostNetwork の Gateway (Cilium の Envoy など) なら Pod のネットワーク (k3s の既定なら `10.42.0.0/16`)
- `TRUSTED_NETWORKS` も IPv6 を CIDR で書けるようになった (前は書いたとおりの一致だけ)

## 置き場を変えた (前の版から上げるとき)

既定の置き場を、中身ごとに1つの名前にそろえた。**古い名前を読み替える仕組みは持たない**ので、
既定に頼って繋いでいた環境は、上げるときに繋ぐ先 (マウント先) を書き換える。ボリュームや PVC の
中身はそのまま使える (名前を変えるのは繋ぐ先だけ)。

| 中身 | 前 | いま |
| --- | --- | --- |
| DB・局ロゴ | `/app/data` | `/data` |
| 元のTS (本体) | `/app/recorded` (`RECORDED_DIR`) | `/media/raw` (`RAW_DIR`) |
| 元のTS (エージェント) | `/denpa-recorded` (`RECORDED_DIR`) | `/media/raw` (`RAW_DIR`。本体と同じ) |
| エンコードしたもの | `/library` (`LIBRARY_DIR`) | `/media/encoded` (`ENCODED_DIR`) |
| エージェントの設定 | `/app-config` | `/config` |

- `RECORDED_DIR` / `LIBRARY_DIR` は読まない。置き場を変えていたなら `RAW_DIR` / `ENCODED_DIR` に
  書き直すか、親の `MEDIA_DIR` 1つにまとめる (本体とエージェントの両方が見る)
- **DB の中の録画ファイルの場所は、起動時のマイグレーションで置き場からの相対に直る**
  (`drizzle/0002_relative-media-paths.sql`。元のTS はファイル名、エンコードしたものは `シリーズ/ファイル`)。
  絶対パスで持っていた頃は、置き場を変えると録画が全部辿れなくなった。以後は置き場をどこへ
  移しても DB は触らずに済む (`schema.ts` の `mediaPath`)
- **上げる前に DB を控えておく** (マイグレーションは行を書き換える)。前の置き場の外を指していた
  絶対パスの行も、ファイル名 (エンコードしたものは最後の2段) だけが残って新しい置き場の下として引かれる。
  置き場の外に録画を置いていたなら、先に置き場へ寄せる
- `RECORDED_DIR` / `LIBRARY_DIR` が残っていたら、denpa 本体は起動時に記録で知らせる (読みはしない。エージェントは何も言わない)
- このリポジトリの compose・chart・`denpa-aio`・Mac / Windows のインストーラは一緒に直してある。
  Mac / Windows はインストーラを流し直すとエージェントの変数 (`RAW_DIR`) が書き直る

## Helm の PVC の名前も置き場にそろえた

**chart の PVC と values のキーを `raw` / `encoded` に改めた**(2026-10-05)。中身の名前
(`/media/raw` と `/media/encoded`)と PVC の名前が食い違っていたため。

| 中身 | 前 (PVC / values のキー) | いま |
| --- | --- | --- |
| 元のTS | `denpa-recorded` / `persistence.recorded` | `denpa-raw` / `persistence.raw` |
| エンコードしたもの | `denpa-library` / `persistence.library` | `denpa-encoded` / `persistence.encoded` |

**そのまま上げると、新しい名前の空の PVC ができる。** 古い PVC は `helm.sh/resource-policy: keep`
で残るので消えはしないが、録画は見えなくなる。どちらかで繋ぐ:

- **古い PVC をそのまま使う**: `persistence.raw.existingClaim: denpa-recorded` /
  `persistence.encoded.existingClaim: denpa-library`(denpa-agent の chart は
  `persistence.raw.existingClaim`)
- **名前ごと移す**: アプリを止め、PV の reclaim を `Retain` にして古い PVC を消し、PV の
  `claimRef` を外してから、新しい名前の PVC を `volumeName` で同じ PV に結ぶ。中身はコピーしない

compose の名前付きボリューム (`denpa-recorded` / `denpa-library`) は**変えていない**。
