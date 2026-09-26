# オフライン視聴 (PWA)

「録画を端末に落として、電波の届かないところ (出先・機内) で観る。`/offline` で消したら、
次にオンラインへ戻ったときサーバ側の録画も自動で消える」の設計と実装の覚え書き。
**消す判断は端末で済ませ、戻ってからもう一度消す二度手間をなくす。**

実装の入口:

- [src/lib/offline-db.ts](../src/lib/offline-db.ts) … IndexedDB (ページと SW の共有層)
- [src/lib/offline.svelte.ts](../src/lib/offline.svelte.ts) … 画面側 (保存・進捗・削除・outbox)
- [src/service-worker.ts](../src/service-worker.ts) … Background Fetch の受け取りとオフラインの入口
- [src/routes/offline/+page.svelte](../src/routes/offline/+page.svelte) … 保存済み一覧 + 内蔵プレイヤー
- [src/routes/api/recordings/[id]/+server.ts](../src/routes/api/recordings/[id]/+server.ts) … `DELETE` (outbox の宛先)

**電波の無いときは `/offline` で観ます。** `/watch/<id>` はサーバが組む画面なので開けず、
ナビゲーションが繋がらないとサービスワーカーが `/offline` へ落とします。
`/offline` はナビに並べません。保存・進み具合 (行のバッジに割合、下端にバー)・視聴は
ふだんの一覧と観る画面でできます (オンラインの `/watch` は端末のコピーがあればそちらを使う)。
「サーバからも消す」予約 (outbox) を積むのは `/offline` の削除だけです。一覧の行の削除は
その場でサーバから消し (端末のコピーも片付ける)、詳細の「端末から消す」はサーバに触りません。

## 全体像

```
[一覧・詳細] ──押す──▶ ダウンロード (Background Fetch)
     │                     backgroundFetch.fetch() でブラウザに預ける (タブを閉じても続く)
     │                     動画は端末が解けるコーデック (既定 AV1、無理なら H.264)
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

## データモデル (IndexedDB)

DB 名 `denpa-offline`、ストア3つ (実体は [offline-db.ts](../src/lib/offline-db.ts) の型が正):

- `videos` (key: 録画ID) … 落とした録画1本。`video: Blob` と付き添い
  (`captions: Blob`・`poster: Blob`・`chapters`/`databroadcast`: JSON) を1行にまとめ、
  名前・局名・開始時刻・尺・どちらを落としたか (`source: 'encoded' | 'alt'`)、
  試みの印 (`attempt`)、状態 (`state`) を持つ。
- `outbox` (key: 録画ID) … オンライン復帰で処理する予約 (`{op: 'delete', name, queuedAt}`)。
- `resume` (key: 録画ID) … オフライン中に進んだ視聴位置。復帰時にまとめて
  `POST /api/recordings/<id>/resume` で送る。

`state` は `'downloading' | 'ready' | 'failed'` の3つ。**失敗は消さずに残す。**
知らせ (トースト) は一瞬なので、控えごと消すと無かったことに見える。残った行がそのまま
「保存をやり直す」の口になる。進み具合 (%) は IndexedDB に置かず、画面側のメモリだけで持つ (下記)。

一覧・視聴の UI はこの `videos` を参照して「DL 済みか」を分岐する。

## 主要な流れ

### ダウンロード — Background Fetch API を使う

1. **HEAD で下見してから預ける** (`probeDownloads`)。Background Fetch は
   404 が1つでも混ざると全体が失敗になる (`failureReason: bad-status`) ので、付き添いは
   在るものだけに絞る。`downloadTotal` を超えても打ち切られるので、HEAD の実測合計 (+2%) を渡す。
   どちらも実機の Edge で踏んだ。
2. `backgroundFetch.fetch(id, urls, {title, downloadTotal})` でブラウザに預ける (タブを
   閉じても続く。`/api/…/file` はログインの控えでも通る: `auth.sessionMayRead`)。登録IDは
   `rec-<録画ID>-<source>-<試みの印>`。同じIDが生きている間は再登録できないので
   やり直しのたびに印を変え、前回の残骸は登録前に中止する。遅れて届く残骸の中止の知らせが
   新しい控えを消さないよう、SW 側は印を照合する。
3. **進み具合は2秒おきに `get()` で掴み直す** (`watchProgress`)。`progress` イベントだけだと、
   遅い回線でブラウザが止めて再開したあとの通知が届かず、割合が張り付く。
4. SW の `backgroundfetchsuccess` で IndexedDB へ移して `state='ready'`。
   `backgroundfetchfail` / `backgroundfetchabort` は `state='failed'` として残す。
   開き直したときは、「保存中」なのにブラウザ側にダウンロードが無ければ失敗に倒す (`watchRunning`)。
5. 対応していないブラウザ (Safari / Firefox) はページ主導の fetch にフォールバック
   (タブを開いたまま。進捗は一覧のバッジに出す)。機能検出は
   `'backgroundFetch' in swReg`。仕分けは SW の受け取りと共有 (`storeResponse`)。

### どちらを落とすか — 端末が解けるコーデック

**既定は AV1** (`library_path`)。端末が AV1 を解けなければ H.264 (`alt_path`) に落とす。
判定は `navigator.mediaCapabilities.decodingInfo()` (`video/mp4; codecs=av01.…` の
`supported`)。H.264 しか解けない端末で `alt_path` が無い録画は、ダウンロード時に
「この端末では再生できない」と断る (落とせても観られないため)。

### 観る

- **オンラインの `/watch`** は、`videos` に `ready` があれば `URL.createObjectURL(blob)`、
  無ければ従来の API URL を `src` にする。src を差し替えるだけなので操作
  (チャプター・CM飛ばし・速度・字幕・データ放送) はそのままで、付き添いも端末のものを読む。
- **オフラインの `/offline`** は素の `<video controls>` で、動画だけを流す
  (字幕・チャプター・データ放送は落としてあっても使わない)。位置は5秒ごとに `resume` ストアへ。
- 使い終わったら `URL.revokeObjectURL` する。

### 削除とサーバ同期

- `/offline` で削除 → `videos` から除去し、`outbox` に `{op:'delete'}` を積む (オンラインならその場で流す)。
- `online` イベント (と起動時の `navigator.onLine`) で `outbox` を処理:
  `DELETE /api/recordings/<id>` → サーバは [`deleteRecordingFiles`](../src/lib/server/files.ts) を呼ぶ。
  成功と 404 (もう無い) は済みとして消し、他の失敗は残して次の復帰で再試行。
  視聴位置 (`resume` ストア) も同じ合図で送る。

> [!IMPORTANT]
> **「消したら自動でサーバも消す」は取り返しがつかない。** `/offline` の削除は2回押しで、
> 2回目の文言を「端末とサーバから消す」にしてある。端末だけを消す口 (一覧の詳細の
> 「端末から消す」「保存を取り消す」、失敗した行の「失敗した保存データを消す」) はサーバに触らない。

## 決めたこと

コーデック (既定 AV1) とダウンロード方式 (Background Fetch) は上記。ほかに:

- **削除の口: `DELETE /api/recordings/[id]`。** 認証はほかの API と同じ。録画中は 409、
  消し済みは 204、行が無ければ 404 (何度呼んでも同じところに落ちる)。
- **容量: 落とす前に確かめる** (30分で約300MB)。`navigator.storage.estimate()` の空きが
  HEAD で測った合計の 1.2 倍に満たなければ断り、`navigator.storage.persist()` で
  ブラウザに勝手に消させない。
