# 外から使う口 (API)

画面の外のもの (Home Assistant の連携・スクリプト・VLC・録画ソフト) 向けの口です。
**JSON の形は保ちます。** 足すことはあっても、名前を変えたり消したりはしません。

- **入り方は画面と同じです** ([下記](#入り方))。`TRUSTED_NETWORKS` に入っている相手はそのまま通ります
  (家の LAN の Home Assistant や Cast 端末)。それ以外はログインか、アプリの鍵が要ります
- **URL は denpa の根からの相対で返します** (`api/services/…`)。denpa を開いている URL に足して使います。
  前段の接頭辞 (`/denpa/` など) の下で動かしていても、そのまま解けます

## 局の一覧 `GET /api/services`

テレビと同じ並び (地上波 → BS → CS、リモコン番号順)。

```json
[{ "id": 3227310008, "type": "GR", "name": "TOKYO MX", "remoteControlKey": 9,
   "logo": "api/services/3227310008/logo", "live": "api/services/3227310008/live",
   "now": { "title": "ニュース", "startAt": 1790000000000, "endAt": 1790001800000 } }]
```

- `logo` は局ロゴをまだ拾えていなければ `null`
- `now` はいま放送中の番組 (時刻は epoch ms)。番組表に無ければ `null`

## ライブ `GET /api/services/<id>/live`

流し続けます。閉じれば止まり、誰も見ていなければチューナーを返します (画面のライブと同じ取り合い。
同じ局・同じ形を誰かが見ていれば相乗りします)。

| `codec` | 中身 | Content-Type | 向いている相手 |
|---|---|---|---|
| (なし) / `h264` | H.264 / AAC の fragmented MP4 | `video/mp4` | Cast・テレビ・古い VLC (いちばん広く再生できる) |
| `av1` | AV1 / Opus の fragmented MP4 | `video/mp4` | AV1 を解ける新しい端末 |
| `raw` | 焼かずに1局に絞っただけの TS (MPEG-2) | `video/mp2t` | VLC・ffplay・録画ソフト (いちばん軽い) |

`?audio=only` で音声だけ (AAC の fragmented MP4、`audio/mp4`)。画面の無いスピーカーへの Cast 向け。
映像を焼かないので軽い。録画の `audio` と同じ書き方です。`codec` と一緒に渡すと、`audio=only` が勝ちます。

## 録画の一覧 `GET /api/recordings`

観られるもの (録り終えて、ファイルがあるもの) を新しい順に。`?limit=` と `?offset=` で区切れます。

```json
[{ "id": 12, "title": "番組 第1話", "name": "[新]番組 第1話[字]",
   "serviceId": 3227310008, "serviceName": "TOKYO MX",
   "startAt": 1790000000000, "endAt": 1790001800000, "durationMs": 1800000, "resumeMs": 754000,
   "poster": "api/recordings/12/poster",
   "files": [
     { "source": "encoded", "codec": "av1",   "url": "api/recordings/12/file?source=encoded" },
     { "source": "alt",     "codec": "h264",  "url": "api/recordings/12/file?source=alt" },
     { "source": "ts",      "codec": "mpeg2", "url": "api/recordings/12/file?source=ts" }],
   "audio": "api/recordings/12/file?audio=only" }]
```

- 時刻は UNIX ミリ秒。`title` は記号 (`[字]` など) を落とした名前、`name` は放送のままの名前
- `files` は出せるものだけ。**どれを開くかは呼ぶ側が決めます** (Cast なら `h264`、新しいテレビなら `av1`)。
  焼いたものは Matroska (`video/x-matroska`)、生は TS (`video/mp2t`)。Range に応じます
- `audio` は主音声だけを AAC (ADTS、`audio/aac`) で流します。画面の無いスピーカーへの Cast 向け。
  `source` と一緒に渡せば、元にするファイルを選べます
- `resumeMs` は続きから観る位置 (画面の「続き」と同じもの)。観ていない・観終えたものは `null`

## 観た位置 `POST /api/recordings/<id>/resume`

本文は `{ "at": 秒, "length": 尺の秒 }` (`length` は分からなければ省く)。画面と同じく、頭の少しと
末尾の 30 秒は「覚えない」(消す) 扱いです。答えは `{ "resume": 覚えた秒 または null, "edge": 30 }`。
15 秒おきくらいに送れば、ほかの端末 (画面・ほかのテレビ) でも続きから観られます

## 入り方

| 相手 | 入り方 |
|---|---|
| 信頼するネットワーク (`TRUSTED_NETWORKS`) の中 | 何も要りません |
| アプリ (テレビなど) | `Authorization: Bearer denpa_…` (下のペアリングで受け取る鍵)。どこから来ても通ります |
| ブラウザ | OIDC のログイン (Cookie) |

**資格の無い API の呼び出しには、いつも同じ 401 の JSON を返します** (`{"error":"unauthorized"}`、
`WWW-Authenticate: Bearer`)。ログイン画面の HTML へは回しません。アプリは鍵なしでまず API を叩き、
これが返ったときだけペアリングに進めばよい (信頼するネットワークの中なら通るので、ペアリングは要らない)。
止めた・知らない鍵を出したときは `{"error":"invalid_token"}` の 401 で、信頼するネットワークの中でも
通しません (ペアリングし直しの合図)。仕組みと守りは [auth.md](auth.md#アプリのペアリング)。

## ペアリング `POST /api/device/code` → `POST /api/device/token`

OAuth のデバイス認可 (RFC 8628) と同じ形です。どちらも資格は要りません。

`POST /api/device/code` (本文 `{ "name": "居間のテレビ" }`。名前は 40 字まで):

```json
{ "deviceCode": "…", "userCode": "ABCD-EFGH",
  "verificationUri": "device", "verificationUriComplete": "device?code=ABCD-EFGH",
  "expiresIn": 600, "interval": 5 }
```

- `verificationUriComplete` (denpa の根からの相対) を QR にして出します。スマホで開くと、
  いつもの入り方 (信頼するネットワークか OIDC のログイン) を通ったうえでそのまま済みます
- 生きている札が多すぎるときは `429 {"error":"too_many_pending"}` (しばらくして出し直す)

`POST /api/device/token` (本文 `{ "deviceCode": "…" }`) を `interval` 秒おきに:

- 済んでいれば `200 { "token": "denpa_…", "tokenType": "Bearer" }`。**1度だけ**返します
- まだなら `400 {"error":"authorization_pending"}`、急ぎすぎなら `400 {"error":"slow_down"}`
  (間隔を延ばす)、切れたら `400 {"error":"expired_token"}` (札から出し直す)、
  知らない・使い終えた札なら `400 {"error":"invalid_grant"}`。断る手順は無いので `access_denied` は返しません

## 鍵を止める `POST /api/device/logout`

`Authorization: Bearer` で出している鍵を止めます (アプリの「サーバーから外す」)。`204` を返します。
ほかの端末の鍵は、設定画面の「テレビのアプリ」から取り消します。
