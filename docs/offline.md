# オフライン視聴 (PWA)

「録画を端末に保存して、電波の届かないところ (出先・機内) で観る。`/offline` で消したら、
次にオンラインへ戻ったときサーバ側の録画も自動で消える」の設計と実装の覚え書き。
**消す判断は端末で済ませ、戻ってからもう一度消す二度手間をなくす。**

下の「ダウンロード」は、端末に保存するためにブラウザが録画を受け取ることを指します (使い方は [watch.md](watch.md#端末に保存して観る-オフライン))。

実装の入口:

- [src/lib/offline-db.ts](../src/lib/offline-db.ts) … IndexedDB (ページと SW の共有層)
- [src/lib/offline.svelte.ts](../src/lib/offline.svelte.ts) … 画面側 (保存・進捗・削除・outbox)
- [src/service-worker/index.ts](../src/service-worker/index.ts) … Background Fetch の受け取りとオフラインの入口
- [src/routes/offline/+page.svelte](../src/routes/offline/+page.svelte) … 保存済み一覧 + 内蔵プレイヤー
- [src/routes/api/recordings/[id]/+server.ts](../src/routes/api/recordings/[id]/+server.ts) … `DELETE` (outbox の宛先)

## 全体像

```
[一覧・詳細] ──押す──▶ ダウンロード (Background Fetch)
     │                     backgroundFetch.fetch() でブラウザに預ける (タブを閉じても続く)
     │                     動画は端末がデコードできるコーデック (AV1 → H.265 → H.264 の順)
     │                     SW の backgroundfetchsuccess → IndexedDB に blob 保存
     │
     ├─観る──▶ オンライン: /watch が blob を使う (字幕・チャプター・データ放送も)
     │          オフライン: /offline の内蔵プレイヤー (動画だけ)
     │
     └─/offline で消す──▶ IndexedDB から消す + 「サーバ側も消す」を予約 (outbox)
                     │
              online 復帰 ──▶ outbox を処理: DELETE /api/recordings/<id> → deleteRecordingFiles
```

**Service Worker は配信のキャッシュに使いません** (`/api/` は素通し、キャッシュするのは殻だけ)。
足したのは Background Fetch の受け取りとオフラインの入口だけで、
`/offline` を install 時に控えて、ナビゲーションが繋がらないときの行き先にします
(ブラウザのダウンロード表示を押したときも `backgroundfetchclick` で `/offline` を開く)。
繋がらないときは**どの画面を開いても `/offline` へ移す** (その URL のまま入口の HTML を返すと、
殻がその URL の画面として始まり、データを取りに行って転ぶ)。入口は SSR を切った殻で、開くたびに
共通の枠のデータ (`/offline/__data.json`。ログインの控えなど) を取りに行くので、これも一緒に控えて
繋がらないときだけ出す。控えていなかった頃は、電波が無いと真っ白な画面になっていた。
「繋がらない」は失敗だけでなく**待ちすぎも含む** — 端末が繋がっていないと言うなら取りに行かず、
10秒返事が無ければ見切って、その後30秒は取りに行かない。iPhone の Safari は機内モードで、
取りに行ったものが失敗せず返事待ちのまま止まることがあり、いつまでも読み込み中になっていた。

## データモデル (IndexedDB)

DB 名 `denpa-offline`、ストア4つ (実体は [offline-db.ts](../src/lib/offline-db.ts) の型が正):

- `videos` (key: 録画ID) … 保存した録画1本。`video: Blob` と付属のデータ
  (`captionText`: `captions.json` の JSON・`poster: Blob`・`chapters`/`databroadcast`: JSON) を1行にまとめ、
  名前・局名・開始時刻・尺・どれを保存したか (`source: 'encoded' | 'hevc' | 'alt'`)、
  試みの印 (`attempt`)、状態 (`state`) を持つ。
- `outbox` (key: 録画ID) … オンライン復帰で処理する予約 (`{op: 'delete', name, queuedAt}`)。
- `resume` (key: 録画ID) … オフライン中に進んだ視聴位置。復帰時にまとめて
  `POST /api/recordings/<id>/resume` で送る。
- `parts` (key: `[録画ID, 番号]`) … ページで受け取った動画の塊 (16MiB ずつ。下記の 5)。
  その録画の `videos` の行は `video` の代わりに塊の数 (`parts`) と形式 (`videoType`) を持つ。
  **読むときは `videos.get` / `all` が塊を1本の `video` につないで出す**ので、観る画面・`/offline`・SW は
  塊を知らなくてよい (つないでも中身は写さない。置き場の Blob はファイルを指しているだけ)。
  塊が欠けていたら `video` 無しとして扱い、消すときは塊も消す。DB の版は 2 (1 で保存したものはそのまま読める)。

`state` は `'downloading' | 'ready' | 'failed'` の3つ。**失敗は消さずに残す。**
通知 (トースト) は一瞬なので、控えごと消すと無かったことに見える。残った行がそのまま
「保存をやり直す」の入口になる。進み具合 (%) は IndexedDB に置かず、画面側のメモリだけで持つ (下記)。

一覧・視聴の UI はこの `videos` を参照して「保存済みか」を分岐する。

## 主要な流れ

### ダウンロード — Background Fetch API を使う

1. **HEAD で下見してから預ける** (`probeDownloads`。一度に訊く)。Background Fetch は
   404 が1つでも混ざると全体が失敗になる (`failureReason: bad-status`) ので、付属のデータは
   在るものだけに絞る。`downloadTotal` を超えても打ち切られるので、HEAD の実測合計 (+2%) を渡す。
   どちらも実機の Edge で踏んだ。
2. `backgroundFetch.fetch(id, urls, {title, downloadTotal})` でブラウザに預ける (タブを
   閉じても続く。`/api/…/file` もほかの API と同じくログインの控えで通る)。登録IDは
   `rec-<録画ID>-<source>-<試みの印>`。同じIDが生きている間は再登録できないので
   やり直しのたびに印を変え、前回の残骸は登録前に中止する。遅れて届く残骸の中止の通知が
   新しい控えを消さないよう、SW 側は印を照合する。
3. **進み具合は2秒おきに `get()` で読み直す** (`watchProgress`)。`progress` イベントだけだと、
   遅い回線でブラウザが止めて再開したあとの通知が届かず、割合が張り付く。
4. SW の `backgroundfetchsuccess` で IndexedDB へ移して `state='ready'`。
   `backgroundfetchfail` / `backgroundfetchabort` は `state='failed'` として残す。
   開き直したときは、「保存中」なのにブラウザ側にダウンロードが無ければ失敗に倒す (`watchRunning`)。
5. 対応していないブラウザ (Safari / Firefox) はページ主導の fetch にフォールバック
   (タブを開いたまま。進捗は一覧の行の3段目に出す)。機能検出は
   `'backgroundFetch' in swReg`。付属のデータの仕分けは SW の受け取りと共有 (`storeResponse`)。
   - **始めたら返る** (`saveOffline` は受け取り終わりを待たない)。押したらすぐ「保存中」にし、
     下見は動画だけ (付属のデータは受け取るときに無ければ飛ばす。下見はサーバで録画を読む —
     字幕は ffmpeg、チャプターは ffprobe — ので、1つずつ訊いていた頃は始まるまで数秒待たせていた)。
     付属のデータは動画と同時に取りに行く。途中の失敗は `state='failed'` で残し、塊は捨てる
   - 取り消し・削除は受け取りも止める。開き直したときに「保存中」なのに受け取っていない行は失敗に倒す
     (ページを閉じた・読み込み直した時点で止まっている。`watchRunning`)
   - **動画は 16MiB の塊ごとに `parts` へ書きながら受け取る** (`stream-parts.ts`)。全部をメモリに
     溜めてから1つの Blob にしていた頃は、900MB の録画で iPhone の Safari のタブがだんだん重くなり、
     最後は落とされて読み込み直しになっていた。書いている間も次の塊を受け取る (書き込みは1つずつ)
   - **割合の分母は、返事に `Content-Length` が無ければ下見 (HEAD) の大きさ。** Cloudflare など
     間に入るものが外して送ることがあり、そのときは割合が出ず流れるだけの表示になっていた。
     割合は 1% 変わったときだけ書き換える (届くたびに一覧を描き直さない)

### どれを保存するか — 端末がデコードできるコーデック

エンコード済みのファイル (主 `library_path`・H.265 `hevc_path`・H.264 `alt_path`) のうち、**AV1 → H.265 → H.264 の順で
この端末で観られる最初のもの**を保存する (観る画面と同じ順。`offline-db.ts` の `offlineSource`)。コーデックは置き場の名前で
見分ける (`… [H265].mkv`・`… [H264].mkv`。H.264 だけでエンコードした録画は主がもう H.264)。

- AV1 … `navigator.mediaCapabilities.decodingInfo()` (`video/mp4; codecs=av01.0.09M.08` を 1080p60 で問うた `supported`)。
  AV1 の Matroska は WebM としても読める。**Level は 4.1** — 4.0 は 30fps までで、Safari は Level と
  コマ数を突き合わせて「デコードできない」と答える
- H.265 … 同じく `hvc1.…` でデコードできて、**しかも `canPlayType` が Matroska の H.265 を読めると言うとき**。保存するのは
  Matroska のままで、WebM に H.265 は入れられないので、デコーダがあっても入れ物を読めない端末 (Safari など) がある
- H.264 … 確かめない (どの端末もデコードできる前提)

どれも観られなければ、ダウンロード時に「この端末では再生できません」と断る (保存できても観られないため)。

### 観る

- **オンラインの `/watch`** は、`videos` に `ready` があり、ファイルをそのまま読む方式を自動で選んだときは
  `URL.createObjectURL(blob)` を `src` にする (コーデックを選んだときや、サーバが流すものを選んだときはサーバから)。
  src を差し替えるだけなので操作
  (チャプター・CM飛ばし・速度・字幕・データ放送) はそのままで、付属のデータも端末のものを読む。
  互換モードでは保存した Matroska をそのまま canvas に描く (`mkv-source.ts`。[stream.md](stream.md#録画の観る画面も-canvas-に描く))。
- **オフラインの `/offline`** は素の `<video controls>` で、動画だけを流す
  (字幕・チャプター・データ放送は保存してあっても使わない)。位置は5秒ごとに `resume` ストアへ。
- 使い終わったら `URL.revokeObjectURL` する。

### 削除とサーバ同期

- `/offline` で削除 → `videos` から除去し、`outbox` に `{op:'delete'}` を積む (オンラインならその場で流す)。
- `online` イベント (と起動時の `navigator.onLine`) で `outbox` を処理:
  `DELETE /api/recordings/<id>` → サーバは [`deleteRecordingFiles`](../src/lib/server/files.ts) を呼ぶ。
  成功と 404 (もう無い) は済みとして消し、他の失敗は残して次の復帰で再試行。
  視聴位置 (`resume` ストア) も同じ合図で送る。

> [!WARNING]
> **「消したら自動でサーバも消す」は取り返しがつかない。** `/offline` の削除は2回押しで、
> 2回目の文言を「端末とサーバから削除」にしてある。端末だけを消す操作 (一覧の詳細の
> 「端末から消す」「保存を取り消す」、失敗した行の「失敗した保存データを消す」) はサーバに触らない。

## 決めたこと

コーデック (AV1 → H.265 → H.264) とダウンロード方式 (Background Fetch) は上記。ほかに:

- **削除の API: `DELETE /api/recordings/[id]`。** 何度呼んでも同じ結果になる
  (答えは [api.md](api.md#録画を消す-delete-apirecordingsid))。
- **容量: 保存する前に確かめる** (30分で約300MB)。`navigator.storage.estimate()` の空きが
  HEAD で測った合計の 1.2 倍に満たなければ断り、`navigator.storage.persist()` で
  ブラウザに勝手に消させない。
