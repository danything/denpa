# 外から使う口 (API)

画面の外のもの (Home Assistant の連携・スクリプト・VLC・録画ソフト) 向けの口です。
**JSON の形は保ちます。** 足すことはあっても、名前を変えたり消したりはしません。

- **入り方は画面と同じです。** `TRUSTED_NETWORKS` に入っている相手はそのまま通ります
  (家の LAN の Home Assistant や Cast 端末)。それ以外はログインが要ります
- **URL は denpa の根からの相対で返します** (`api/services/…`)。denpa を開いている URL に足して使います。
  前段の接頭辞 (`/denpa/` など) の下で動かしていても、そのまま解けます

## 局の一覧 `GET /api/services`

テレビと同じ並び (地上波 → BS → CS、リモコン番号順)。

```json
[{ "id": 3227310008, "type": "GR", "name": "TOKYO MX", "remoteControlKey": 9,
   "logo": "api/services/3227310008/logo", "live": "api/services/3227310008/live" }]
```

- `logo` は局ロゴをまだ拾えていなければ `null`

## ライブ `GET /api/services/<id>/live`

流し続けます。閉じれば止まり、誰も見ていなければチューナーを返します (画面のライブと同じ取り合い。
同じ局・同じ形を誰かが見ていれば相乗りします)。

| `codec` | 中身 | Content-Type | 向いている相手 |
|---|---|---|---|
| (なし) / `h264` | H.264 / AAC の fragmented MP4 | `video/mp4` | Cast・テレビ・古い VLC (いちばん広く再生できる) |
| `av1` | AV1 / Opus の fragmented MP4 | `video/mp4` | AV1 を解ける新しい端末 |
| `raw` | 焼かずに1局に絞っただけの TS (MPEG-2) | `video/mp2t` | VLC・ffplay・録画ソフト (いちばん軽い) |

`?audio=only` で音声だけ (AAC の fragmented MP4、`audio/mp4`)。画面の無いスピーカーへの Cast 向け。
映像を焼かないので軽い。録画の `audio` と同じ書き方です。

## 録画の一覧 `GET /api/recordings`

観られるもの (録り終えて、ファイルがあるもの) を新しい順に。`?limit=` と `?offset=` で区切れます。

```json
[{ "id": 12, "title": "番組 第1話", "name": "[新]番組 第1話[字]",
   "serviceId": 3227310008, "serviceName": "TOKYO MX",
   "startAt": 1790000000000, "endAt": 1790001800000, "durationMs": 1800000,
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
