# 外から使う口 (API)

画面の外のもの (Home Assistant の連携・スクリプト・VLC・録画ソフト) 向けの口です。
**JSON の形は保ちます。** 足すことはあっても、名前を変えたり消したりはしません。

- **入り方は画面と同じです** ([下記](#入り方))。`TRUSTED_NETWORKS` に入っている相手はそのまま通ります
  (家の LAN の Home Assistant や Cast 端末)。それ以外はログインか、アプリの鍵が要ります
- **書き込み (POST・DELETE) には `Content-Type: application/json` を付けます** (本文が無い DELETE でも)。
  付けないと、SvelteKit の CSRF の守りが「よそのサイトからのフォーム送信」とみなして 403 を返します
  (アプリは Origin を付けないため)。テレビのアプリの削除がこれで失敗していました
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

観られるもの (録り終えてファイルがあるものと、**いま録っているもの**) を新しい順に。`?limit=` と `?offset=` で区切れます。

```json
[{ "id": 12, "title": "番組 第1話", "name": "[新]番組 第1話[字]",
   "serviceId": 3227310008, "serviceName": "TOKYO MX",
   "startAt": 1790000000000, "endAt": 1790001800000, "durationMs": 1800000, "resumeMs": 754000,
   "recording": false, "chase": "api/recordings/12/chase", "cmReliable": true,
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
- `recording` はいま録っている最中か。録画中は `durationMs` が `null` で、`files` は生TSだけ (伸びている途中)。
  録画中・焼き上がる前は `chase` (下) で観る
- `chase` は追っかけ再生の口。生TSがある間だけ入り、無ければ `null`
- `cmReliable` は CM 飛ばしを観はじめに入れてよいか (画面と同じ決め方)。ロゴで CM を見分けられなかった
  録画は無音だけで当てていて外れやすいので `false`。そのときは切って始め、押せば入れる

## 追っかけ再生 `GET /api/recordings/<id>/chase`

録っている最中 (と、録り終えて焼き上がる前) の録画を、伸びている生TSから流します。

| `codec` | 中身 | Content-Type |
|---|---|---|
| (なし) / `h264` | 画面の追っかけと同じ焼き直し (H.264 / AAC の fragmented MP4) | `video/mp4` |
| `av1` | AV1 / Opus の fragmented MP4 | `video/mp4` |
| `raw` | 焼かずに生TS (MPEG-2) をそのまま | `video/mp2t` |

- `?from=<秒>` で頭からの位置を選びます (既定 0)。**シークは `from` を変えて頼み直します**
- 生TSには時間の索引が無いので、位置は「いまのファイルの大きさ ÷ 録れている秒数」の比例で
  当たりを付け、188 バイト (TS パケット) に揃えます。いま書いているところの 5 秒手前より先へは行きません
- 送り込みは実時間の倍速まで。読む側が詰まっている間は止めて待ちます (焼き直しのほうも、
  読まれずに溜まったら送り込みを止める)
- 尻まで読んだら、録っている間は書き足されるのを待って読み続け、**録り終えて尻まで読んだら閉じます**
- 録画が無い・まだ何も録れていなければ 404
- `h264` / `av1` は、上の確かめ (録画がある・何か録れている) を通ったあとで焼き直しを断られると
  (録画が直前に消された・音声の組み立てで転んだなど)、**200 のまま中身が空で、すぐ閉じます**。
  空で閉じたら頼み直すか、`raw` を使ってください
- 録画中は一覧の `durationMs` が `null` です (長さが決まっていない)。録れている長さは
  録り始め (`startAt`) からの経過で見積もってください

## 番組の中身 `GET /api/recordings/<id>/detail`

```json
{ "id": 12, "title": "番組 第1話", "name": "[新]番組 第1話[字]",
  "description": "番組の概要", "extended": { "出演者": "…", "番組内容": "…" } }
```

- `description` は短い説明、`extended` は放送の詳細 (見出し → 本文)。無ければ `""` / `{}`
- 一覧 (`GET /api/recordings`) には入れていない (長くて一覧が重くなる)。テレビのアプリの詳細で使う

## 観た位置 `POST /api/recordings/<id>/resume`

本文は `{ "at": 秒, "length": 尺の秒 }` (`length` は分からなければ省く)。画面と同じく、頭の少しと
末尾の 30 秒は「覚えない」(消す) 扱いです。答えは `{ "resume": 覚えた秒 または null, "edge": 30 }`。
15 秒おきくらいに送れば、ほかの端末 (画面・ほかのテレビ) でも続きから観られます

## 変化の知らせ `GET /api/events`

Server-Sent Events (`text/event-stream`) で、サーバ側の変化を流し続けます。受け取ったら該当の一覧を読み直してください。

```
event: recordings
data: 1

event: encode
data: {"recordingId":12,"percent":42.5,"etaMs":600000,"log":"…"}
```

- 名前: `recordings` `services` `programs` `tuners` `encode` ほか (画面向けのもの)。知らない名前は読み捨ててください
- `data` は `encode` だけが中身 (`recordingId` `percent` `etaMs` `log`) を運び、ほかは `1`
- 25 秒おきに `event: ping` が来ます。60 秒ほど何も届かなければ繋ぎ直してください (黙って切れた繋ぎを見分けるため)
- 繋ぎ直したら一覧を1度読み直してください。切れていた間の知らせは送り直しません (`Last-Event-ID` は使わない)

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
