# 外から使う API

画面の外のもの (テレビのアプリ・Home Assistant の連携・スクリプト) 向けの API です。
**JSON の形式は保ちます。** 足すのが原則で、やむを得ず外したものはその節に書きます。

- **認証は画面と同じです** ([下記](#認証))。`TRUSTED_NETWORKS` に入っている相手はそのまま通ります
  (家の LAN の Home Assistant など)。それ以外はログインか、アクセストークンが要ります
- **書き込み (POST・DELETE) には `Content-Type: application/json` を付けます** (本文が無い DELETE でも)。
  付けないと、SvelteKit の CSRF の守りが「よそのサイトからのフォーム送信」とみなして 403 を返します
  (アプリは Origin を付けないため)
- **URL は denpa の根からの相対で返します** (`api/services/…`)。denpa を開いている URL に足して使います。
  前段の接頭辞 (`/denpa/` など) の下で動かしていても、そのまま解決できます

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

- `logo` は局ロゴをまだ取得できていなければ `null`
- `now` はいま放送中の番組 (時刻は epoch ms)。番組表に無ければ `null`
- `now.audios` はその番組で選べる音声 ([下記](#音声の一覧-audios))。ライブの `?audio=<id>` に渡します
- `now.id` は番組ID ([`GET /api/programs/<id>`](#番組表の番組の中身-get-apiprogramsid) で中身を引けます)
- `now.reserved` はその番組を録る予定か (予約が予約済みか録画中。競合で弾かれたものは `false`)、`now.recording` は
  いま録っている最中か (録画中なら `reserved` も `true`)。番組表のマスの印と同じ物差しです。
  録画ボタンの印に使い、押すのは [`POST /api/services/<id>/record`](#いまの番組を録る-post-apiservicesidrecord)

### 音声の一覧 `audios`

局の `now.audios` と録画の `audios` は同じ形式で、画面の音声の切り替えに出るものと同じ一覧です。
番組表が何も言っていなくても、`{ "id": "0:both", "stream": 0, "side": "both", "label": "音声" }` の1つは必ず入ります。

- `id` … 選ぶときに渡す値 (`<stream>:<side>`)
- `stream` … 何本目の音声か (0 から)。複数の音声 (解説放送など) はここが分かれる
- `side` … `both` はそのまま、`main` / `sub` は**デュアルモノ** (二カ国語。1本の左右に別の音声) の
  左だけ・右だけを両耳に配ったもの。デュアルモノは1本から `main` `sub` `both` (主+副) の3つが出ます
- `label` … 画面と同じ名前 (「主音声 (日本語)」「解説ステレオ」)
- `main` … 放送が主音声と言っているか。言っていなければキーごと無い。何も選ばなければ、これ (無ければ先頭) をエンコードします

## ライブ `GET /api/services/<id>/live`

流し続けます。閉じれば止まり、誰も見ていなければチューナーを返します (画面のライブと同じ取り合い。
同じ局・同じ形式を誰かが見ていればそのストリームを共有します)。知らない局は 404。

| `codec` | 中身 | Content-Type | 向いている相手 |
|---|---|---|---|
| (なし) / `h264` | H.264 / AAC の fragmented MP4 | `video/mp4` | ブラウザ・テレビのアプリ (いちばん広く再生できる) |
| `av1` | AV1 / Opus の fragmented MP4 | `video/mp4` | AV1 をデコードできる新しい端末 |
| `raw` | エンコードせずに1局に絞っただけの TS (MPEG-2) | `video/mp2t` | テレビのアプリ (いちばん軽い。MPEG-2 をハードでデコードできる端末) |

`?audio=only` で音声だけ (AAC の fragmented MP4、`audio/mp4`)。音声だけを聴くとき向け。
映像をエンコードしないので軽い。録画の `audio` と同じ書き方です。`codec` と一緒に渡すと、`audio=only` が勝ちます。

`?audio=<id>` (`now.audios` の `id`) でエンコードする音声を選びます。デュアルモノの `main` / `sub` は片側を両耳に配ってエンコードします。
知らない・形式の違う `id` は断らずに主音声でエンコードします (番組が替わって消えた音声など)。**選び直すにはリクエストし直します**
(同じ局・同じ形式・同じ音声を見ている人とだけストリームを共有する)。`raw` では効きません (全部の音声が入っているので、受け側が選ぶ)。

**録画にチューナーを譲ると閉じます** (ライブは録画にだけ譲る。チューナーを取り上げられると、ほかのチューナーが空いていても閉じることがある)。
閉じたら同じ局をリクエストし直してください。入れたらそのまま続きが観られます。入れなかったときは、その少し前に
通知 (`GET /api/events`) の `yielded` で**どの録画に譲ったか**が来ているので、その録画の追っかけ
(`GET /api/recordings/<id>/chase?from=<大きな値>`。録れているところの少し手前から流れる) に切り替えられます。
画面とテレビのアプリの動きは [stream.md](stream.md#録画に譲る)。

**番組が替わって映像・音声・字幕の並び (PMT) が変わったときも閉じます** (音声の本数や字幕の PID が変わった)。エンコードは起きたときの
並びのまま音声・字幕を選んでいて追従しないので、作り直します。閉じたらすぐ同じ局をリクエストし直してください。
`raw` では閉じません (映像と音声は受け側が PMT を読んで追い、[字幕](#元のtsの字幕-get-apiservicesidcaptionsget-apirecordingsidcaptions)はサーバが写し直します)。
[stream.md](stream.md#番組が替わって並びが変わったら作り直す)。

## いまの番組を録る `POST /api/services/<id>/record`

その局でいま流れている番組を予約します (画面のライブの録画ボタンと同じ)。本文は要りませんが、
`Content-Type: application/json` は付けます ([上記](#外から使う-api))。

```json
{ "recorded": "ニュース", "programId": 32736103210001, "reserved": true }
```

- 既に始まっている番組は、数秒後 (次のスケジューラの周期) に録りはじめます
- **何度押しても二重には録りません** (予約は番組ごとに1本)。予約済み・録画中でも同じ答えが返ります
- `reserved` が `false` なら予約はあるものの録らない状態です。たいていはチューナーが足りない**競合**
  (どれを録るかは予約どうしの優先度で決まります。手動の予約は 2、ルールの予約はルールの優先度)
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
- `files` は出せるものだけ。**どれを開くかは呼ぶ側が決めます** (テレビのアプリなら、その端末がデコードできるもの)。
  エンコードしたものは Matroska (`video/x-matroska`)、元のTSは TS (`video/mp2t`)。Range に応じます。
  再生のためのもので、ダウンロード用ではありません (添付は付けない)
- `audio` は主音声だけを AAC (ADTS、`audio/aac`) で流します。音声だけを聴くとき向け。
  `source` と一緒に渡せば、元にするファイルを選べます
- `resumeMs` は続きから観る位置 (画面の「続き」と同じもの)。観ていない・観終えたものは `null`。
  **エンコードしたもの (`source` が `encoded`・`alt`) の時刻**で、エンコードしたものが無ければ元のTSの時刻。
  エンコードしたものがあるのに元のTS (`source=ts`) で開くときは、時刻が合わないので使えません (CM を切ったもの・頭を捨てたもの)。
  `durationMs` もエンコードし終えると出来上がりの長さになるので、`resumeMs` と同じ物差しです (観た割合・残りは2つから出せます)
- `watchedAt` は末尾まで観た時刻 (ms)。まだなら `null`。`watchedAt` も `resumeMs` も `null` なら未視聴 (画面の一覧の印と同じ)。
  `resume` に末尾 (尺の30秒手前より後) を送ると入ります。画面の「未視聴に戻す」で `null` に戻ります (「視聴済みにする」「未視聴に戻す」はどちらも `resumeMs` も消します)
- `poster` は一覧のサムネイル (JPEG)。エンコードする前の録画や元のTSしか無いものでは 404
- `recording` はいま録っている最中か。録画中は `durationMs` が `null` (途中で切れて録り直したものは、それまでに録れた長さ) で、`files` は元のTSだけ (伸びている途中)。
  録画中・エンコードが終わる前は `chase` (下) で観る
- `chase` は追っかけ再生のエンドポイント。元のTSがある間だけ入り、無ければ `null`
- `audios` は放送の音声の構成 ([上記](#音声の一覧-audios))。追っかけの `?audio=<id>` に渡します。エンコードしたもの (`files`) は
  デュアルモノを左右2本に割ってあるなど作りが違うので、そちらの音声は再生側のトラックの切り替えで選んでください
- `cmReliable` は CM 飛ばしを観はじめに入れてよいか (画面と同じ決め方)。ロゴで CM を見分けられなかった
  録画は無音だけで当てていて外れやすいので `false`。そのときはオフで始め、押せばオンにする

## 追っかけ再生 `GET /api/recordings/<id>/chase`

録っている最中 (と、録り終えてエンコードが終わる前) の録画を、伸びている元のTSから流します。

| `codec` | 中身 | Content-Type |
|---|---|---|
| (なし) / `h264` | 画面の追っかけと同じ再エンコード (H.264 / AAC の fragmented MP4) | `video/mp4` |
| `av1` | AV1 / Opus の fragmented MP4 | `video/mp4` |
| `raw` | エンコードせずに元のTS (MPEG-2) をそのまま | `video/mp2t` |

- `?from=<秒>` で頭からの位置を選びます (既定 0)。**シークは `from` を変えてリクエストし直します**
- `?audio=<id>` (一覧の `audios` の `id`) で `h264` / `av1` でエンコードする音声を選びます。ライブと同じく、知らないものは主音声、
  選び直すにはリクエストし直し、`raw` では効きません
- 元のTSには時間の索引が無いので、位置は「いまのファイルの大きさ ÷ 録れている秒数」の比例で
  当たりを付け、188 バイト (TS パケット) に揃えます。いま書いているところの 5 秒手前より先へは行きません
- 送り込みは実時間の倍速まで。読む側が詰まっている間は止めて待ちます (再エンコードのほうも、
  読まれずに溜まったら送り込みを止める)
- 尻まで読んだら、録っている間は書き足されるのを待って読み続け、**録り終えて尻まで読んだら閉じます**
- `h264` / `av1` は、**番組が替わって映像・音声・字幕の並び (PMT) が変わったところでも閉じます** (ライブと同じ理由)。
  届いたぶんを観終えてから、観ていた位置 (`from` + 再生した秒) をリクエストし直してください。変わったところの 15 秒以内を
  リクエストされたら、変わったところから流します (秒からバイトへの当たりがずれて、前の番組から読み直さないように)。
  `raw` では閉じません
- 録画が無い・まだ何も録れていなければ 404
- `h264` / `av1` は、上の確かめ (録画がある・何か録れている) を通ったあとで再エンコードを断られると
  (録画が直前に消された・音声の組み立てで転んだなど)、**200 のまま中身が空で、すぐ閉じます**。
  空で閉じたらリクエストし直すか、`raw` を使ってください
- 録画中は一覧の `durationMs` が `null` です (長さが決まっていない)。録れている長さは
  録り始め (`startAt`) からの経過で見積もってください
- `h264` / `av1` は**その場で変換する本数の枠**を 1 つ使います ([下記](#その場で変換する本数))。
  埋まっていれば 503 (`{"message":"サーバが混んでいます"}`)。`raw` は数えません

## 録画の観方 `GET /api/recordings/<id>/playback`

録り終えた録画を、何で観られるか。観る画面 (`/watch`) が使っています。**どれを使うかは受け側が決めます**
(端末で再生できるか、人が選んだコーデック)。

```json
{ "duration": 1790.5, "axis": "encoded",
  "audios": [{ "id": "0", "label": "主音声" }, { "id": "1", "label": "副音声" }],
  "offers": [{ "codec": "av1", "way": "file", "source": "encoded", "codecs": "av01.0.08M.08,opus" },
             { "codec": "h264", "way": "stream", "codecs": "avc1.640029,mp4a.40.2" },
             { "codec": "av1", "way": "stream", "codecs": "av01.0.08M.08,opus" },
             { "codec": "mpeg2", "way": "raw" }] }
```

- `axis` は**時刻の物差し**。`encoded` はエンコード済みのファイルの時刻、`ts` は元の TS の頭を 0 とした時刻
  (エンコード済みが無い録画)。`duration`・下の `from`・ストリームの時刻・字幕 (`captions.json`)・チャプターはどれもこれで数えます
- `offers` の `way`:
  - `file` … エンコード済みのファイルそのまま (`api/recordings/<id>/file?source=<source>`)。`codecs` は入れ物の中身 (読めなければ無い)
  - `stream` … `stream?codec=<codec>` で fragmented MP4。`codecs` は MP4 の中身。エンコード済みと同じコーデックなら詰め替えるだけ
    (軽い)、違えばエンコード済み (無ければ元の TS) から変換します
  - `raw` … `stream?codec=mpeg2` で元の TS をそのまま。元の TS が残っていて、CM を切らずにエンコードした録画 (か、エンコード済みが無い録画) だけ
- `audios` の `id` を `stream?audio=` に渡します
- 録っている最中の録画、エンコード済みも元の TS も無い録画は 404

## 録画を流す `GET /api/recordings/<id>/stream`

`?codec=h264` / `av1` / `mpeg2` (要る。無い・知らない値は 400)、`?from=<秒>` (物差しの上の位置。既定 0)、`?audio=<id>`。**シークは `from` を変えてリクエストし直します。**

- `h264` / `av1` … fragmented MP4 (`video/mp4`)。塊の時刻 (tfdt) は物差しの時刻のまま書きます (頭を 0 に詰め直さない)。
  詰め替えは `from` の手前のキーフレームから、変換は元の TS なら `from` の 1 秒手前の映像から始まります
- `mpeg2` … 元の TS を `from` の 1 秒手前の映像から流します (`video/mp2t`)。**`X-Denpa-Origin` に物差しの 0 にあたる PTS** (90kHz) を返します。
  物差しの時刻 = (PTS − `X-Denpa-Origin`) を 33 ビットの一周の中で取って 90000 で割ったもの。`audio` は効きません (全部の音声が入る)
- 変換 (エンコード済みと違うコーデック) は**その場で変換する本数の枠**を使います。埋まっていれば 503 (`{"message":"サーバが混んでいます"}`)。
  詰め替えと `mpeg2` は数えません
- `offers` に無い形式は 404。読まれないまま 5 分置かれた変換は止めます (枠を返すため)。リクエストし直してください

## 録画のチャプター `GET /api/recordings/<id>/chapters`

CM 飛ばしの行き先です。観る画面とテレビのアプリが使っています。

```json
{ "chapters": [{ "start": 0, "end": 612.4, "title": "本編" },
               { "start": 612.4, "end": 702.4, "title": "CM" },
               { "start": 702.4, "end": 1790.5, "title": "本編" }] }
```

- `start`・`end` は秒で、**`playback` の物差し ([上記](#録画の観方-get-apirecordingsidplayback)) の時刻**です。録画の時間そのもので、
  エンコード済みのファイルの時刻・`stream` の `from`・ストリームの時刻と同じ数です。シークでリクエストし直しても、どの形式で流しても、そのまま使えます
- エンコード済みがあれば、ファイルに入っているチャプターを返します。まだエンコードしていない録画は、検出した CM の区間から組みます
- `title` は denpa が書くものは `本編` と `CM`。**CM かどうかは `title` が `CM` かで見てください**。引き継いだ録画 (EPGStation) は
  別の名前のことがあり、名前の無いものは `—` です。並びは `start` の順
- チャプターが無ければ空の配列です (CM を切ってエンコードした、CM を見つけられなかった、CM の扱いが「何もしない」、録っている最中)。
  ファイルを読めなかったときも空で返します
- 録画が無い・消したものは 404

## その場で変換する本数

録画をエンコード済みと違う形式で流す (`stream`) のと、追っかけ再生 (`chase` の `h264` / `av1`。画面の追っかけも) は、
サーバがその場でエンコードします。同時に走らせる本数には上限があり、設定の「録画」の「エンコード」(`/settings/recording#encoding`) にある「同時に変換する本数」で変えられます
(自動では GPU が無ければ 2 本、あれば 4 本)。**ライブは数えず、断りません。**

## 元のTSの字幕 `GET /api/services/<id>/captions`・`GET /api/recordings/<id>/captions`

元の TS (`live?codec=raw`・`chase?codec=raw`・`file?source=ts`) の字幕を、**放送の PTS のまま**流します。
ブラウザで元のTSを再生する経路と同じもの ([stream.md](stream.md#放送のままのときの字幕))。受け側は映像の PTS がそこを過ぎたら重ね、次が来るまで出しておきます。

- 中身は**文字の配置** (0x22。[下記](#字幕の文字の配置)) です。ブラウザと同じもので、受け側が描きます。
  前の画像 (0x20) はやめ、`?format` は見ません (denpa-tv 0.16.0 より前のアプリでは字幕が出ません)
- ライブ (`services/<id>/captions`) は**いま変換せずに流している局のストリームを共有するだけ**です。`live?codec=raw` を開いてからリクエストします。
  流していなければ 404。映像が閉じれば、こちらも閉じます
- 録画 (`recordings/<id>/captions?from=<秒>`) は、映像をリクエストしたのと同じ `from` を渡します (シークしたらリクエストし直す)。
  `from` の 10 秒手前から読むので、いま出ている字幕も来ます。追っかけと同じく倍速までで先へ進み、録り終えた録画は
  尻まで読んだら閉じます。元のTSが無ければ 404。同じ録画に同時に開けるのは 3 本までで、超えるといちばん古いものを閉じます
  (シークでリクエストし直したとき、前の繋ぎが残っていても積もらないように)
- 番組が替わって並び (PMT) が変わっても閉じません。サーバが字幕を写し直し、選べる字幕 (0x40) を送り直します
- 本文 (`application/octet-stream`) は、WebSocket の1フレーム ([stream.md](stream.md#websocket-プロトコル)) の頭に長さを付けたものが並びます:

```
[4: 後ろの長さ (BE)][1: 種別][8: 時刻 (90kHz, BE)][中身]

0x22  字幕の文字の配置  JSON (下記)。前の1枚を丸ごと置き換える (`runs` が空なら消す)
0x40  通知            JSON。{"type":"captions","tracks":[{"index":0,"lang":"jpn","label":"字幕 (日本語)"}],"track":0}
                      は選べる字幕 (字幕を持たない放送では来ない。`lang` は放送が名乗っていなければ null)。20 秒おきに {"type":"ping"}。知らない種別・type は読み捨てる
```

- **字幕の言語。** 字幕1本に言語が複数載っている放送 (たまに英語が付く) では、`captions` の通知に
  `"languages":[{"index":1,"code":"jpn","label":"日本語"},{"index":2,"code":"eng","label":"英語"}],"language":1` が付きます
  (字幕管理データが届いてから)。`?language=<1〜8>` で第何言語を流すかを選びます。省けば第1言語。
  その言語が載っていない番組では第1言語を流し、通知の `language` も 1 になります
- 時刻は放送の PTS (33 ビットで 26.5 時間ごとに一周する)。比べるときは近いほうへ伸ばしてください

## 録画の字幕 `GET /api/recordings/<id>/captions.json`

エンコードしたもの (mkv) に入っている放送の字幕を、**文字の配置**で丸ごと返します。観る画面はこれを描きます。

```json
{ "v": 1, "pages": [{ "at": 12.345, "page": { "v": 1, "plane": [960, 540], "duration": null, "runs": [ … ] } }],
  "language": { "index": 1, "code": "jpn", "label": "日本語" },
  "others": [{ "index": 2, "code": "eng", "label": "英語", "pages": [ … ] }] }
```

- `at` は動画の頭からの秒。`page` は [下記](#字幕の文字の配置)。再生位置を追い越していない中の最後の1枚を出します
- **まだエンコードしていない録画**は元の TS から抜きます。`at` は元の TS の頭からの秒 (`playback` の物差し `ts`)。
  TS を丸ごと読むので、返るまでエンコード済みより時間がかかります
- `pages` は第1言語。`language` は第1言語の名前 (字幕管理データが読めなければ省く)。**`others` は第2言語から後ろで、載っているときだけ**
  付きます (たいていの番組には無い)。足しただけなので `v` は 1 のままです
- 字幕を持たない録画は 404。**ずっと前にエンコードした録画** (字幕が画像 (PGS) で入っている) も 404 です。元のTSが残っていれば、再エンコードすると放送の字幕が入ります

## 字幕の文字の配置

放送の字幕 (ARIB STD-B24) を denpa がデコードして、**置き場所・大きさ・色まで決めたもの**です。受け側は言われたとおりに塗るだけで、
放送どおりの所に出ます。ブラウザの描き方は `src/lib/components/player/caption-draw.ts`。

```json
{ "v": 1, "plane": [960, 540], "duration": 3000,
  "runs": [{ "x": 250, "y": 450, "w": 40, "h": 60, "fx": 2, "fy": 12, "size": 36, "scaleX": 1,
             "text": "字幕です", "fg": "#ffffffff", "bg": "#00000080" },
           { "x": 410, "y": 450, "w": 40, "h": 60, "fx": 2, "fy": 12, "size": 36, "scaleX": 1,
             "text": "〓", "drcs": "65569", "fg": "#ffffffff", "bg": "#00000080", "stroke": "#000000ff" }],
  "drcs": { "65569": { "w": 72, "h": 72, "depth": 16, "bits": 4, "data": "AAAA…", "md5": "0123…" } } }
```

- `v` は形式の版。**知らない版は描かないでください** (互換の無い変え方をしたら上げます。足すだけなら上げない)
- **座標はすべて字幕の面の単位** (`plane`。ふつう 960x540)。映像の枠に合わせて縦横それぞれ伸ばします
- `duration` は出しておく長さ (ms)。`null` なら次の1枚まで。過ぎたら次を待たずに消します
- `runs` は描く順。1つの run は同じ見た目で横に並ぶ字で、`text` の1字 (コードポイント) ごとに幅 `w`・高さ `h` の
  **区画**を `x` から右へ使います
  - 背景: 区画を `bg` で塗る (空白の字も塗る)
  - 字: 区画の左上から (`fx`, `fy`) ずらした所が**字の枠** (高さ `size`・幅 `size × scaleX`)。字の大きさは `size` (em) で、
    横だけ `scaleX` 倍に縮める (中くらいの全角は 0.5。半角の英数・カナは 1 のまま)。ペンは字の枠の左端。
    **縦は「永」の墨の上下が字の枠の真ん中に来るように基準線を置きます**
  - 空白 (U+0020・U+3000 など) は字を描かない
  - `stroke` があれば字の外側へ太さ 1.5 (面の単位) で縁取る (字より先に)
  - `underline` は区画の幅で字の下に線。`box` は区画の縁に字の色の線 (1 下・2 右・4 上・8 左の和、太さは面の 1 単位)
  - `flash` は点滅 (0.5 秒ずつ出す・消す)。`ruby` はルビらしい小さな字 (隠したければ隠してよい)。`bold` / `italic` は印だけ (描き分けなくてよい)
  - `drcs` は置き換えられなかった外字。`text` は「〓」で、`drcs` の画像を字の枠いっぱいに `fg` で描く
- `drcs` の画像は左上から1画素 `bits` ビットずつ上の桁から詰めたもの (base64)。値 v の濃さは v / (`depth` − 1)。
  いまは denpa が放送の白黒の画像 (16〜36 画素) の斜めを丸め、**濃淡の画像** (`bits` 4・`depth` 16、一辺 64〜256。18x18 の字なら 72x72 で base64 3.5KB ほど) にして送ります。
  濃さを `fg` の不透明度に掛けて塗り、字の枠いっぱいへなめらかに (双線形などで) 引き伸ばしてください。`bits` は 1・2・4・8 のどれでも
  読めるようにしておいてください (前に保存した字幕には白黒の `bits` 1 が入っています)。
  `md5` は放送の元の画像の MD5 (外字の置き換え表に足すときのキー。描くのには使わない)。
  置き換え表で字にできたもの (〓 にならないもの) はここに来ません
- 色は `#rrggbbaa`。字はデータ放送と同じ丸ゴシック (`GET /api/font/denpa-font.woff2`。Denpa Font) で描きます。版なしの URL は毎回確かめる (`no-cache` + ETag) ので、そのまま取っても古い字は残りません

## 番組表の番組の中身 `GET /api/programs/<id>`

`<id>` は番組ID (局の `now.id`)。画面の番組の詳細と同じものを返します (テレビのアプリのライブの詳細で使う)。
**このエンドポイントだけキーは snake_case** (画面と同じ形式をそのまま返している)。

```json
{ "name": "[新]番組 第1話[字]", "service_name": "TOKYO MX",
  "start_at": 1790000000000, "end_at": 1790001800000,
  "description": "番組の概要", "extended": { "番組内容": "…", "出演者": "…" },
  "genre_detail": [{ "lv1": 7, "lv2": 0 }],
  "audios": [{ "componentType": 3, "langs": ["jpn"], "main": true },
             { "componentType": 3, "langs": ["jpn"], "text": "解説ステレオ" }],
  "video_type": "mpeg2", "video_resolution": "1080i", "is_free": true, "copy_never": false }
```

- `name` は放送のままの名前 (記号 `[字]` などを含む)。時刻は UNIX ミリ秒
- `extended` は放送の詳細 (見出し → 本文)、`genre_detail` はジャンル (ARIB の大分類 `lv1`・中分類 `lv2`)、
  `audios` は番組表の音声 (`componentType` は ARIB の音声の構成。2 がデュアルモノ、3 がステレオ。`text` は放送が付けた名前)。
  どれも番組表に無ければ `null`
- `video_type` (`mpeg2` / `h.264` など)・`video_resolution` (`1080i` / `480i` など) も、無ければ `null`
- `is_free` は無料放送か
- `copy_never` はコピー禁止の番組か。禁止の番組は録らない ([data.md](data.md#コピー禁止の番組は録らない))。
  `POST /api/services/<id>/record` は `400` と「コピー禁止の番組なので録画しません」を返す
- 番組表は終わった番組を消していくので、**引けないことがあります** (`404`)。そのときは呼ぶ側が持っている分
  (`now` の番組名・時刻など) だけを出してください

## 検索の候補 `GET /api/search?q=<言葉>&limit=<数>`

画面のヘッダーの欄が、打つそばから出す候補に使います。読み方は結果の画面 (`/search?q=`) と同じで
(空白で区切った語をすべて含む。全角/半角・大文字/小文字は区別しない)、節ごとに先頭の `limit` 件 (既定 4、多くても 10) と、
その先にもあるか (`more`) だけを返します。件数は数えません。**キーは snake_case** です。

```json
{ "q": "でんぱ",
  "programs": { "more": true, "rows": [{ "id": 3227310008123, "name": "でんぱ劇場", "service_name": "でんぱテレビ",
                                         "start_at": 1790000000000, "end_at": 1790001800000, "reservation_state": null }] },
  "recordings": { "more": false, "rows": [{ "id": 12, "name": "でんぱ劇場 #1", "service_name": "でんぱテレビ",
                                            "start_at": 1789000000000, "state": "available", "watch": "watch/12" }] },
  "reservations": { "more": false, "rows": [{ "id": 5, "program_id": 3227310008123, "name": "でんぱ劇場",
                                              "service_name": "でんぱテレビ", "start_at": 1790000000000,
                                              "end_at": 1790001800000, "state": "scheduled", "chase": null }] },
  "rules": { "more": false, "rows": [{ "id": 2, "name": "でんぱ", "enabled": true }] } }
```

- `programs` はまだ終わっていない番組 (始まる順)。`reservation_state` は予約が立っていればその状態
- `recordings` は消していない録画 (新しい順)。`watch` は観る画面 (録っている最中は追っかけ再生 `chase/<id>`)。観られなければ `null`
- `reservations` はこれから録るものと録っている最中のもの。`chase` は録っている最中なら追っかけ再生
- `q` が空なら、どの節も空で返します。100 字を超えた分は切って探します (結果の画面 `/search?q=` も同じ)

## 番組の中身 `GET /api/recordings/<id>/detail`

```json
{ "id": 12, "title": "番組 第1話", "name": "[新]番組 第1話[字]",
  "description": "番組の概要", "extended": { "出演者": "…", "番組内容": "…" } }
```

- `description` は短い説明、`extended` は放送の詳細 (見出し → 本文)。無ければ `""` / `{}`
- 一覧 (`GET /api/recordings`) には入れていない (長くて一覧が重くなる)。テレビのアプリの詳細で使う

## 観た位置 `POST /api/recordings/<id>/resume`

本文は `{ "at": 秒, "length": 尺の秒, "source": "encoded" }` (`length` は分からなければ省く)。`source` は観ているファイル
(`files` の `source` と同じ `encoded` / `alt` / `ts`。追っかけは `ts`)。省くと、エンコードしたものがあれば `encoded`、無ければ `ts` とみなします。
`at` と `length` はそのファイルの時刻です。画面と同じく、頭の少しと
末尾の 30 秒は「覚えない」(消す) 扱いです。答えは `{ "resume": 覚えた秒 または null, "edge": 30 }`。
15 秒おきくらいに送れば、ほかの端末 (画面・ほかのテレビ) でも続きから観られます。

末尾の 30 秒に入った位置を送ると「観終えた」になり、一覧の `watchedAt` が入ります (`length` が要ります)。
再生が終わったときにも位置を送ってください (末尾の CM を飛ばすと、15 秒おきの控えが末尾に届かないため)

**サーバは元のTSの時刻に直して覚えます** (CM を切ってエンコードしたものは、残した区間をつないだ時刻なので)。
追っかけで観た続きをエンコードしたもので開いても、同じ場面から始まります。切った CM の途中だった位置は、その後の本編の頭になります。
答えの `resume` は送った `source` の時刻のままです (v1.55 までに覚えた位置は直していないので、CM を切った録画では少しずれることがあります)

## 変化の通知 `GET /api/events`

Server-Sent Events (`text/event-stream`) で、サーバ側の変化を流し続けます。受け取ったら該当の一覧を読み直してください。

```
event: recordings
data: 1

event: encode
data: {"recordingId":12,"percent":0.425,"etaMs":600000,"log":"…"}
```

- 名前: `recordings` `services` `programs` `tuners` `encode` ほか (画面向けのもの)。知らない名前は読み捨ててください
- `programs` は番組表を集めたときのほか、**ライブで開いている局の番組が放送で替わった・延びた**ときにも来ます
  (EIT[p/f] が番組表と違ったとき)。局の一覧 (`GET /api/services`) の `now` を読み直せば、いまの番組に追いつきます
- `data` は `encode` と `yielded` だけが中身を運び、ほかは `1`。`encode` は `recordingId` `percent` `etaMs` `log`。`percent` は 0〜1 (名前に反して百分率ではない)。`etaMs` は見積もれなければ `null`
- `yielded` は**ライブがチューナーを録画に譲った** (チューナーを取り上げられた) ことの通知。`serviceId` の局を観ていた人だけが読みます。
  譲った録画が分かったときだけ来ます

  ```
  event: yielded
  data: {"serviceId":3239123608,"recording":{"id":12,"title":"ニュース","serviceName":"TOKYO MX","endAt":1790001815000}}
  ```

  `recording.endAt` は録り終える時刻 (UNIX ミリ秒。終わりのマージン込み)。それまでそのチューナーは空きません。
  使い方は [ライブ](#ライブ-get-apiservicesidlive) の「録画にチューナーを譲ると閉じます」
- 25 秒おきに `event: ping` が来ます。60 秒ほど何も届かなければ繋ぎ直してください (黙って切れた繋ぎを見分けるため)
- 繋ぎ直したら一覧を1度読み直してください。切れていた間の通知は送り直しません (`Last-Event-ID` は使わない)

## 認証

| 相手 | 認証 |
|---|---|
| 信頼するネットワーク (`TRUSTED_NETWORKS`) の中 | 何も要りません |
| アプリ (テレビなど) | `Authorization: Bearer denpa_…` (下のペアリングで受け取るアクセストークン)。どこから来ても通ります |
| ブラウザ | OIDC のログイン (Cookie) |

**資格の無い API の呼び出しには、いつも同じ 401 の JSON を返します** (`{"error":"unauthorized"}`、
`WWW-Authenticate: Bearer realm="denpa"`)。ログイン画面の HTML へは回しません。アプリはアクセストークンなしでまず API を呼び、
これが返ったときだけペアリングに進めばよい (信頼するネットワークの中なら通るので、ペアリングは要らない)。
無効にした・知らないアクセストークンを出したときは `{"error":"invalid_token"}` の 401 (`WWW-Authenticate: Bearer error="invalid_token"`) で、
信頼するネットワークの中でも通しません (ペアリングし直しの合図)。仕組みと守りは [auth.md](auth.md#アプリのペアリング)。

ログイン方法を何も設定していない denpa は 403 で断り、ペアリングもできません ([auth.md](auth.md#ログイン方法が無ければ全部断る))。

## ペアリング `POST /api/device/code` → `POST /api/device/token`

OAuth のデバイス認可 (RFC 8628) と同じ方式です。どちらも資格は要りません。

`POST /api/device/code` (本文 `{ "name": "居間のテレビ" }`。名前は 40 字まで):

```json
{ "deviceCode": "…", "userCode": "ABCD-EFGH",
  "verificationUri": "device", "verificationUriComplete": "device?code=ABCD-EFGH",
  "expiresIn": 600, "interval": 5 }
```

- **QR にするのは `verificationUriComplete`** (denpa の根からの相対) です。`userCode`・`verificationUri` は
  RFC の形式に合わせて返すだけで、コードを打ち込む画面はありません (コードは画面に出さなくてよい)。スマホで開くと、
  いつものログイン方法 (信頼するネットワークか OIDC のログイン) を通ったうえでそのまま済みます
- 有効なコードが多すぎるときは `429 {"error":"too_many_pending"}` (しばらくして出し直す)

`POST /api/device/token` (本文 `{ "deviceCode": "…" }`) を `interval` 秒おきに:

- 済んでいれば `200 { "token": "denpa_…", "tokenType": "Bearer" }`。**1度だけ**返します
- まだなら `400 {"error":"authorization_pending"}`、急ぎすぎなら `400 {"error":"slow_down"}`
  (間隔を延ばす)、切れたら `400 {"error":"expired_token"}` (コードの発行からやり直す)、
  知らない・使い終えたコードなら `400 {"error":"invalid_grant"}`。断る手順は無いので `access_denied` は返しません

## アクセストークンを無効にする `POST /api/device/logout`

`Authorization: Bearer` で出しているアクセストークンを無効にします (アプリの「サーバーから外す」)。`204` を返します。Bearer が無ければ `401 {"error":"unauthorized"}`。
ほかの端末のアクセストークンは、設定の「連携」の「テレビのアプリ」(`/settings/integrations#tv`) から取り消します。

## 録画の状態 `GET /api/recordings/<id>`

```json
{ "id": 12, "encoded": false, "state": "recording", "durationMs": null }
```

- `encoded` はエンコード済みのファイルがあるか。「エンコードしない」録画は元の TS を置くだけなので、置き終えても `false` のまま
  (観られるかどうかは `state` で分かる)。`state` は録画の状態 (`recording` `recorded` `available` `failed`)。録画が無い・消したものは `404`
- `durationMs` は[一覧](#録画の一覧-get-apirecordings)の `durationMs` と同じもの (録画中は `null`)。
  追っかけのストリームが終わったとき、録り終えて最後まで観たのかを確かめるのに使えます (一覧を取り直さずに済む)
- 追っかけ再生の画面は `recordings` の通知 ([上記](#変化の通知-get-apievents)) のたびにこれを読み、`encoded` が `true` になったら観る画面への案内を出す

## 録画を消す `DELETE /api/recordings/<id>`

ファイルごと消して `204` を返します。もう消えていても `204`、録画中は `409`、録画が無ければ `404`
(どれも呼ぶ側は「済んだ」か「消せない」と読めばよい。端末の消しておいた分をあとで送り直すため、何度呼んでも同じ結果になる)。
本文は要りませんが、`Content-Type: application/json` は付けます ([上記](#外から使う-api))。
