# オフライン視聴 (PWA)

「録画を端末に落として、電波の届かないところ (出先・機内) で観る。観終えて消したら、
次にオンラインへ戻ったときにサーバ側の録画も自動で消える」の設計と実装の覚え書き。
消す判断は端末で済ませておき、戻ってからもう一度消す二度手間をなくす。

実装の入口:

- [src/lib/offline-db.ts](../src/lib/offline-db.ts) … IndexedDB (ページと SW の共有層)
- [src/lib/offline.svelte.ts](../src/lib/offline.svelte.ts) … 画面側 (保存・進捗・削除・outbox)
- [src/service-worker.ts](../src/service-worker.ts) … Background Fetch の受け取りとオフラインの入口
- [src/routes/offline/+page.svelte](../src/routes/offline/+page.svelte) … 保存済み一覧 + 内蔵プレイヤー
- [src/routes/api/recordings/[id]/+server.ts](../src/routes/api/recordings/[id]/+server.ts) … `DELETE` (outbox の宛先)

オフラインでは `/watch/<id>` は開けない (あの画面はサーバが組む) ので、電波の無いときの
視聴は `/offline` の内蔵プレイヤーで行う。ナビゲーションが繋がらないときは
サービスワーカーが `/offline` へ落とす。オンラインの `/watch` は端末のコピーがあれば
そちらを使う (動画・字幕・チャプター・データ放送)。

**`/offline` はナビに並べない。** ふだんの操作 (保存・削除・視聴・進捗) は全部
通常の一覧でできる。あの画面が要るのは電波が無いときだけで、そのときは
サービスワーカーが勝手に連れて行く。保存の進み具合はエンコードと同じ見せ方
(行のバッジに割合、行の下端にバー)。

## 全体像

```
[視聴/一覧 UI] ──押す──▶ ダウンロード (Background Fetch)
     │                     backgroundFetch.fetch() でブラウザに預ける (タブを閉じても続く)
     │                     動画は端末が解けるコーデック (既定 AV1、無理なら H.264)
     │                     SW の backgroundfetchsuccess → IndexedDB に blob 保存
     │
     ├─観る──▶ src を差し替え: DL 済みなら URL.createObjectURL(blob)、無ければ従来の API URL
     │
     └─消す──▶ IndexedDB から消す + 「サーバ側も消す」を予約 (outbox)
                     │
              online 復帰 ──▶ outbox を処理: DELETE /api/recordings/<id> → deleteRecordingFiles
```

**Service Worker は配信のキャッシュには使わない。** `/api/` 素通し・
「殻だけキャッシュ・一覧はキャッシュしない」の方針は崩さない。SW に足したのは
Background Fetch のイベント処理と、**オフラインの入口** — `/offline` を install 時に
控えておき、ナビゲーションが繋がらないときの行き先にする (+ ブラウザの
ダウンロード表示を押したときに `/offline` を開く `backgroundfetchclick`)。

## データモデル (IndexedDB)

DB 名 `denpa-offline`、ストア3つ (実体は [offline-db.ts](../src/lib/offline-db.ts) の型が正):

- `videos` (key: 録画ID) … 落とした録画1本。`video: Blob` と付き添い
  (`captions: Blob`・`poster: Blob`・`chapters`/`databroadcast`: JSON) を1行にまとめ、
  名前・局名・開始時刻・尺・どちらを落としたか (`source: 'encoded' | 'alt'`)、
  試みの印 (`attempt`)、状態 (`state`) を持つ。
- `outbox` (key: 録画ID) … オンライン復帰で処理する予約 (`{op: 'delete', name, queuedAt}`)。
- `resume` (key: 録画ID) … オフライン中に進んだ視聴位置。復帰時にまとめて
  `POST /api/recordings/<id>/resume` で送る。

`state` は `'downloading' | 'ready' | 'failed'` の3つ。**失敗は消さずに残す** —
失敗した瞬間の知らせ (トースト) は一瞬で、控えごと消すと「無かったことになった」ように
見える。残った行がそのまま「保存をやり直す」の口になる。進み具合 (%) は
IndexedDB には置かず、画面側のメモリだけで持つ (下記)。

一覧・視聴の UI はこの `videos` を参照して「DL 済みか」を分岐する。

## 主要な流れ

### ダウンロード — Background Fetch API を使う

1. **HEAD で下見してから預ける** (`probeDownloads`)。Background Fetch は
   **404 が1つでも混ざると全体が失敗になる** (`failureReason: bad-status`) — 付き添いは
   無い録画もあるので、在るものだけに絞る。さらに **`downloadTotal` を超えた時点で
   打ち切られる**ので、当てずっぽうではなく HEAD の実測合計 (+2%) を渡す。
   どちらも実機の Edge で踏んだ。
2. `backgroundFetch.fetch(id, urls, {title, downloadTotal})` で**ブラウザに預ける**。
   タブを閉じても続く。認証はセッション Cookie で通る
   ([auth.ts](../src/lib/server/auth.ts) の `sessionMayRead` で `/api/…/file` は緩和済み)。
   登録IDは `rec-<録画ID>-<source>-<試みの印>` — **同じIDが生きている間は再登録
   できない**ので、やり直しのたびに印を変え、前回の残骸は登録前に中止する。
   遅れて届いた残骸の中止の知らせが新しい控えを消さないように、SW 側は印を照合する。
3. **進み具合は2秒おきに訊きに行く** (`watchProgress`)。`progress` イベントに任せると、
   遅い回線でブラウザが止めて再開したあとの通知が届かず、割合が張り付く —
   `get()` で毎回新しく掴めば必ず今の値が読める。
4. SW の `backgroundfetchsuccess` で IndexedDB へ移して `state='ready'`。
   `backgroundfetchfail` / `backgroundfetchabort` は **`state='failed'` として残す**。
   開き直したときは突き合わせもする — 「保存中」なのにブラウザ側に対応する
   ダウンロードが無ければ、もう動いていないので失敗に倒す (`watchRunning`)。
5. 対応していないブラウザ (Safari / Firefox) は**ページ主導の fetch にフォールバック**
   (タブを開いたまま。進捗は一覧のバッジに出す)。機能検出は
   `'backgroundFetch' in swReg`。仕分けは SW の受け取りと共有 (`storeResponse`)。

### どちらを落とすか — 端末が解けるコーデック

**既定は AV1** (`library_path`)。端末が AV1 を解けなければ H.264 (`alt_path`) に落とす。
判定は `navigator.mediaCapabilities.decodingInfo()` (`video/mp4; codecs=av01.…` の
`supported`)。H.264 しか解けない端末で `alt_path` が無い録画は、ダウンロード時に
「この端末では再生できない」と断る (落とすだけ落とせても観られないため)。

### オフライン再生

- `/watch` の `src` は「`videos` に `ready` があれば `URL.createObjectURL(blob)`、
  無ければ従来の API URL」。**同じ視聴画面の src を差し替えるだけ**なので、プレイヤーの
  操作 (チャプター・速度・字幕) はそのまま。字幕・チャプター・データ放送も同様に
  blob / メモリから読む。
- 使い終わったら `URL.revokeObjectURL` する。

### 削除とサーバ同期

- 端末で削除 → `videos` から除去し、`outbox` に `{op:'delete'}` を積む。
- `online` イベント (と起動時の `navigator.onLine`) で `outbox` を処理:
  `DELETE /api/recordings/<id>` → サーバは [`deleteRecordingFiles`](../src/lib/server/files.ts) を呼ぶ。
  成功と 404 (もう無い) は済んだことにして消す。他の失敗は残して次の復帰で再試行。
  視聴位置 (`resume` ストア) も同じ合図で送る。

> [!IMPORTANT]
> **「消したら自動でサーバも消す」は取り返しがつかない。** 端末での削除には、いまの一覧と
> 同じ**2回クリックの確認**を付けてある。オフラインで消したものが、オンライン復帰の
> 一瞬で本体からも消えることが分かる文言にする (「端末とサーバから消す」)。
> `/offline` の失敗した控えの「片付ける」だけは端末のみで、サーバには触らない
> (中身が無いだけなので)。

## 決めたこと

コーデック (既定 AV1) とダウンロード方式 (Background Fetch) は上記。ほかに:

- **削除の口: `DELETE /api/recordings/[id]` を新設。** 認証は書き込み扱い
  (form action と同じ経路)。録画中は 409、消し済みは 204 (何度呼んでも同じ)。
- **容量: 落とす前に確かめる。** 30分で約300MB。`navigator.storage.estimate()` で残量を
  見て、入らなければ断る。`navigator.storage.persist()` を要求して、ブラウザが勝手に
  消さないようにする。
