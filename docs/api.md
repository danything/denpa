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
   "now": { "id": 32736103210001, "title": "ニュース", "startAt": 1790000000000, "endAt": 1790001800000,
            "reserved": false, "recording": false,
            "audios": [{ "id": "0:main", "stream": 0, "side": "main", "label": "主音声 (日本語)", "main": true },
                       { "id": "0:sub",  "stream": 0, "side": "sub",  "label": "副音声 (英語)", "main": true },
                       { "id": "0:both", "stream": 0, "side": "both", "label": "主+副", "main": true }] } }]
```

- `logo` は局ロゴをまだ拾えていなければ `null`
- `now` はいま放送中の番組 (時刻は epoch ms)。番組表に無ければ `null`
- `now.audios` はその番組で選べる音声 ([下記](#音声の一覧-audios))。ライブの `?audio=<id>` に渡します
- `now.id` は番組ID ([`GET /api/programs/<id>`](#番組表の番組の中身-get-apiprogramsid) で中身を引けます)
- `now.reserved` はその番組を録る予定か (予約が予約済みか録画中。競合で弾かれたものは `false`)、`now.recording` は
  いま録っている最中か (録画中なら `reserved` も `true`)。番組表のマスの印と同じ物差しです。
  録画ボタンの印に使い、押すのは [`POST /api/services/<id>/record`](#いまの番組を録る-post-apiservicesidrecord)

### 音声の一覧 `audios`

局の `now.audios` と録画の `audios` は同じ形で、画面の音声の切り替えに出るものと同じ一覧です。
番組表が何も言っていなくても、`{ "id": "0:both", "stream": 0, "side": "both", "label": "音声" }` の1つは必ず入ります。

- `id` … 選ぶときに渡す合言葉 (`<stream>:<side>`)
- `stream` … 何本目の音声か (0 から)。複数の音声 (解説放送など) はここが分かれる
- `side` … `both` はそのまま、`main` / `sub` は**デュアルモノ** (二カ国語。1本の左右に別の音声) の
  左だけ・右だけを両耳に配ったもの。デュアルモノは1本から `main` `sub` `both` (主+副) の3つが出ます
- `label` … 画面と同じ名前 (「主音声 (日本語)」「解説ステレオ」)
- `main` … 放送が主音声と言っているか。言っていなければ鍵ごと無い。何も選ばなければ、これ (無ければ先頭) を焼きます

## ライブ `GET /api/services/<id>/live`

流し続けます。閉じれば止まり、誰も見ていなければチューナーを返します (画面のライブと同じ取り合い。
同じ局・同じ形を誰かが見ていれば相乗りします)。知らない局は 404。

| `codec` | 中身 | Content-Type | 向いている相手 |
|---|---|---|---|
| (なし) / `h264` | H.264 / AAC の fragmented MP4 | `video/mp4` | Cast・テレビ・古い VLC (いちばん広く再生できる) |
| `av1` | AV1 / Opus の fragmented MP4 | `video/mp4` | AV1 を解ける新しい端末 |
| `raw` | 焼かずに1局に絞っただけの TS (MPEG-2) | `video/mp2t` | VLC・ffplay・録画ソフト (いちばん軽い) |

`?audio=only` で音声だけ (AAC の fragmented MP4、`audio/mp4`)。画面の無いスピーカーへの Cast 向け。
映像を焼かないので軽い。録画の `audio` と同じ書き方です。`codec` と一緒に渡すと、`audio=only` が勝ちます。

`?audio=<id>` (`now.audios` の `id`) で焼く音声を選びます。デュアルモノの `main` / `sub` は片側を両耳に配って焼きます。
知らない・形の違う `id` は断らずに主音声で焼きます (番組が替わって消えた音声など)。**選び直すには頼み直します**
(同じ局・同じ形・同じ音声を見ている人とだけ相乗りする)。`raw` では効きません (全部の音声が入っているので、受け側が選ぶ)。

## いまの番組を録る `POST /api/services/<id>/record`

その局でいま流れている番組を予約します (画面のライブの録画ボタンと同じ)。本文は要りませんが、
`Content-Type: application/json` は付けます ([上記](#外から使う口-api))。

```json
{ "recorded": "ニュース", "programId": 32736103210001, "reserved": true }
```

- 既に始まっている番組は、数秒後 (次のスケジューラの周期) に録りはじめます
- **何度押しても二重には録りません** (予約は番組ごとに1本)。予約済み・録画中でも同じ答えが返ります
- `reserved` が `false` なら予約はあるものの録らない状態です。たいていはチューナーが足りない**競合**
  (画面の予約の一覧で優先を変えられます)
- 番組表にいまの番組が無ければ `404`、予約できなければ (放送が終わったところなど) `400`。
  どちらも `message` に画面に出せる理由が入ります

## 録画の一覧 `GET /api/recordings`

観られるもの (録り終えてファイルがあるものと、**いま録っているもの**) を新しい順に。`?limit=` と `?offset=` で区切れます。

```json
[{ "id": 12, "title": "番組 第1話", "name": "[新]番組 第1話[字]",
   "serviceId": 3227310008, "serviceName": "TOKYO MX",
   "startAt": 1790000000000, "endAt": 1790001800000, "durationMs": 1800000, "resumeMs": 754000, "watchedAt": null,
   "recording": false, "chase": "api/recordings/12/chase", "cmReliable": true,
   "poster": "api/recordings/12/poster",
   "files": [
     { "source": "encoded", "codec": "av1",   "url": "api/recordings/12/file?source=encoded" },
     { "source": "alt",     "codec": "h264",  "url": "api/recordings/12/file?source=alt" },
     { "source": "ts",      "codec": "mpeg2", "url": "api/recordings/12/file?source=ts" }],
   "audio": "api/recordings/12/file?audio=only",
   "audios": [{ "id": "0:both", "stream": 0, "side": "both", "label": "ステレオ (日本語)", "main": true }] }]
```

- 時刻は UNIX ミリ秒。`title` は記号 (`[字]` など) を落とした名前、`name` は放送のままの名前
- `files` は出せるものだけ。**どれを開くかは呼ぶ側が決めます** (Cast なら `h264`、新しいテレビなら `av1`)。
  焼いたものは Matroska (`video/x-matroska`)、生は TS (`video/mp2t`)。Range に応じます
- `audio` は主音声だけを AAC (ADTS、`audio/aac`) で流します。画面の無いスピーカーへの Cast 向け。
  `source` と一緒に渡せば、元にするファイルを選べます
- `resumeMs` は続きから観る位置 (画面の「続き」と同じもの)。観ていない・観終えたものは `null`
- `watchedAt` は末尾まで観た時刻 (ms)。まだなら `null`。`watchedAt` も `resumeMs` も `null` なら未視聴 (画面の一覧の印と同じ)。
  `resume` に末尾 (尺の30秒手前より後) を送ると入ります。画面の「未視聴に戻す」で `null` に戻ります
- `poster` は一覧のサムネイル (JPEG)。焼く前の録画や生TSしか無いものでは 404
- `recording` はいま録っている最中か。録画中は `durationMs` が `null` (途中で切れて録り直したものは、それまでに録れた長さ) で、`files` は生TSだけ (伸びている途中)。
  録画中・焼き上がる前は `chase` (下) で観る
- `chase` は追っかけ再生の口。生TSがある間だけ入り、無ければ `null`
- `audios` は放送の音声の構成 ([上記](#音声の一覧-audios))。追っかけの `?audio=<id>` に渡します。焼いたもの (`files`) は
  デュアルモノを左右2本に割ってあるなど作りが違うので、そちらの音声は再生側のトラックの切り替えで選んでください
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
- `?audio=<id>` (一覧の `audios` の `id`) で `h264` / `av1` の焼く音声を選びます。ライブと同じく、知らないものは主音声、
  選び直すには頼み直し、`raw` では効きません
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

## 生TSの字幕 `GET /api/services/<id>/captions`・`GET /api/recordings/<id>/captions`

生の TS (`live?codec=raw`・`chase?codec=raw`・`file?source=ts`) には字幕の絵が乗っていない (放送は文字と指定だけ)
ので、denpa が描いた絵を**放送の PTS のまま**流します。ブラウザの生の道と同じもの ([stream.md](stream.md#字幕))。
受け側は映像の PTS がそこを過ぎたら重ね、次が来るまで出しておきます (全部透明な絵が来たら消える)。

- ライブ (`services/<id>/captions`) は**いま生で流している局に乗るだけ**です。`live?codec=raw` を開いてから頼みます。
  流していなければ 404。映像が閉じれば、こちらも閉じます
- 録画 (`recordings/<id>/captions?from=<秒>`) は、映像を頼んだのと同じ `from` を渡します (シークしたら頼み直す)。
  `from` の 10 秒手前から読むので、いま出ている字幕も来ます。追っかけと同じく倍速までで先へ進み、録り終えた録画は
  尻まで読んだら閉じます。生TSが無ければ 404。同じ録画に同時に開けるのは 3 本までで、超えるといちばん古いものを閉じます
  (シークで頼み直したとき、前の繋ぎが残っていても積もらないように)
- 本文 (`application/octet-stream`) は、WebSocket の1こま ([stream.md](stream.md#53-websocket-プロトコル)) の頭に長さを付けたものが並びます:

```
[4: 後ろの長さ (BE)][1: 種別][8: 時刻 (90kHz, BE)][中身]

0x20  字幕の絵  [2:x][2:y][2:w][2:h][PNG]  座標は 1920x1080 の上 (いまは画面まるごと)
0x40  知らせ    JSON。{"type":"captions","tracks":[{"index":0,"lang":"jpn","label":"字幕 (日本語)"}],"track":0}
                は選べる字幕 (字幕を持たない放送では来ない。`lang` は放送が名乗っていなければ null)。20 秒おきに {"type":"ping"}。知らない種別・type は読み捨てる
```

- 時刻は放送の PTS (33 ビットで 26.5 時間ごとに一周する)。比べるときは近いほうへ伸ばしてください

## 番組表の番組の中身 `GET /api/programs/<id>`

`<id>` は番組ID (局の `now.id`)。画面の番組の詳細と同じものを返します (テレビのアプリのライブの詳細で使う)。
**この口だけ鍵は snake_case** (画面と同じ形をそのまま返している)。

```json
{ "name": "[新]番組 第1話[字]", "service_name": "TOKYO MX",
  "start_at": 1790000000000, "end_at": 1790001800000,
  "description": "番組の概要", "extended": { "番組内容": "…", "出演者": "…" },
  "genre_detail": [{ "lv1": 7, "lv2": 0 }],
  "audios": [{ "componentType": 3, "langs": ["jpn"], "main": true },
             { "componentType": 3, "langs": ["jpn"], "text": "解説ステレオ" }],
  "video_type": "mpeg2", "video_resolution": "1080i", "is_free": true }
```

- `name` は放送のままの名前 (記号 `[字]` などを含む)。時刻は UNIX ミリ秒
- `extended` は放送の詳細 (見出し → 本文)、`genre_detail` はジャンル (ARIB の大分類 `lv1`・中分類 `lv2`)、
  `audios` は番組表の音声 (`componentType` は ARIB の音声の構成。2 がデュアルモノ、3 がステレオ。`text` は放送が付けた名前)。
  どれも番組表に無ければ `null`
- `video_type` (`mpeg2` / `h.264` など)・`video_resolution` (`1080i` / `480i` など) も、無ければ `null`
- `is_free` は無料放送か
- 番組表は終わった番組を消していくので、**引けないことがあります** (`404`)。そのときは呼ぶ側が持っている分
  (`now` の番組名・時刻など) だけを出してください

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
15 秒おきくらいに送れば、ほかの端末 (画面・ほかのテレビ) でも続きから観られます。

末尾の 30 秒に入った位置を送ると「観終えた」になり、一覧の `watchedAt` が入ります (`length` が要ります)。
再生が終わったときにも位置を送ってください (末尾の CM を飛ばすと、15 秒おきの控えが末尾に届かないため)

## 変化の知らせ `GET /api/events`

Server-Sent Events (`text/event-stream`) で、サーバ側の変化を流し続けます。受け取ったら該当の一覧を読み直してください。

```
event: recordings
data: 1

event: encode
data: {"recordingId":12,"percent":0.425,"etaMs":600000,"log":"…"}
```

- 名前: `recordings` `services` `programs` `tuners` `encode` ほか (画面向けのもの)。知らない名前は読み捨ててください
- `data` は `encode` だけが中身 (`recordingId` `percent` `etaMs` `log`) を運び、ほかは `1`。`percent` は 0〜1 (名前に反して百分率ではない)。`etaMs` は見積もれなければ `null`
- 25 秒おきに `event: ping` が来ます。60 秒ほど何も届かなければ繋ぎ直してください (黙って切れた繋ぎを見分けるため)
- 繋ぎ直したら一覧を1度読み直してください。切れていた間の知らせは送り直しません (`Last-Event-ID` は使わない)

## 入り方

| 相手 | 入り方 |
|---|---|
| 信頼するネットワーク (`TRUSTED_NETWORKS`) の中 | 何も要りません |
| アプリ (テレビなど) | `Authorization: Bearer denpa_…` (下のペアリングで受け取る鍵)。どこから来ても通ります |
| ブラウザ | OIDC のログイン (Cookie) |

**資格の無い API の呼び出しには、いつも同じ 401 の JSON を返します** (`{"error":"unauthorized"}`、
`WWW-Authenticate: Bearer realm="denpa"`)。ログイン画面の HTML へは回しません。アプリは鍵なしでまず API を叩き、
これが返ったときだけペアリングに進めばよい (信頼するネットワークの中なら通るので、ペアリングは要らない)。
止めた・知らない鍵を出したときは `{"error":"invalid_token"}` の 401 (`WWW-Authenticate: Bearer error="invalid_token"`) で、
信頼するネットワークの中でも通しません (ペアリングし直しの合図)。仕組みと守りは [auth.md](auth.md#アプリのペアリング)。

**ファイルの口 (`file`・`playlist`) だけは 401 ではなく 403 (text/plain)** です。ログインの控えか
期限付きのリンク (`share`) でも開けるようにしてあり、どれも無ければ言葉で断ります。アプリは Bearer を付けて開きます。
もう1つ、入る道 (OIDC か `TRUSTED_NETWORKS`) を何も設定していない denpa は、どの口も 403 で断ります
(ペアリングもできない。[auth.md](auth.md#入る道が無ければ全部断る))。

## ペアリング `POST /api/device/code` → `POST /api/device/token`

OAuth のデバイス認可 (RFC 8628) と同じ形です。どちらも資格は要りません。

`POST /api/device/code` (本文 `{ "name": "居間のテレビ" }`。名前は 40 字まで):

```json
{ "deviceCode": "…", "userCode": "ABCD-EFGH",
  "verificationUri": "device", "verificationUriComplete": "device?code=ABCD-EFGH",
  "expiresIn": 600, "interval": 5 }
```

- **QR にするのは `verificationUriComplete`** (denpa の根からの相対) です。`userCode`・`verificationUri` は
  RFC の形に合わせて返すだけで、札を打ち込む画面はありません (札は画面に出さなくてよい)。スマホで開くと、
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

## 録画の状態 `GET /api/recordings/<id>`

```json
{ "id": 12, "encoded": false, "state": "recording" }
```

- `encoded` は焼き上がっているか、`state` は録画の状態 (`recording` `recorded` `available` `failed`)。録画が無い・消したものは `404`
- 追っかけ再生の画面は `recordings` の知らせ ([上記](#変化の知らせ-get-apievents)) のたびにこれを読み、焼き上がったら観る画面へ移る

## 録画を消す `DELETE /api/recordings/<id>`

ファイルごと消して `204` を返します。もう消えていても `204`、録画中は `409`、録画が無ければ `404`
(どれも呼ぶ側は「済んだ」か「消せない」と読めばよい。端末の消しておいた分をあとで送り直すため、何度叩いても同じ結果になる)。
本文は要りませんが、`Content-Type: application/json` は付けます ([上記](#外から使う口-api))。
