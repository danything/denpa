# オフライン視聴 (PWA) — 設計メモ

> [!NOTE]
> **設計だけの覚え書き。まだ実装していない。** 「録画を端末に落として、電波の届かない
> ところ (出先・機内) で観る。観終えて消したら、次にオンラインへ戻ったときにサーバ側の
> 録画も自動で消える」を、**既存の視聴 UI そのまま**で成り立たせるための下ごしらえ。

## やりたいこと

1. 録画一覧・視聴画面から「ダウンロード」を押すと、端末に丸ごと落ちる。
2. 落とした録画は**同じ視聴画面**で観られる (オフラインでも)。src を差し替えるだけで、
   プレイヤーの操作 (チャプター・速度・字幕) はそのまま。
3. 端末から「削除」すると端末のコピーが消える。**次にオンラインへ戻ったとき、サーバ側の
   録画も自動で消える** (二度手間をなくす。消す判断は端末で済ませておく)。

## いまの土台 (調査済み)

すでに揃っているもの:

- **PWA 化済み。** Service Worker は [src/service-worker.ts](../src/service-worker.ts) にあり
  SvelteKit が自動登録する。ただしキャッシュするのは**アプリの殻 (JS/CSS) だけ**で、
  `/api/` は素通し (録画は数十GBあり載せると壊れる、と明記)。manifest は
  [src/lib/server/manifest.ts](../src/lib/server/manifest.ts) が動的生成。
- **動画は単一ファイルのプログレッシブ配信** ([api/recordings/[id]/file](../src/routes/api/recordings/[id]/file/+server.ts))。
  HLS ではないので、**1ファイルを丸ごと保存すれば済む** (セグメント管理が要らない)。
  既定は AV1+Opus+PGS の Matroska、地上波30分で約300MB。
- **Range 対応済み** ([src/lib/server/serve.ts](../src/lib/server/serve.ts))。分割・レジューム DL 可。
- **video src は1箇所の `$derived`** ([watch/[id]/+page.svelte:62](../src/routes/watch/[id]/+page.svelte))。
  ここを `blob:` に差し替えればオフライン再生に回せる。
- **削除ロジックは1関数** [`deleteRecordingFiles`](../src/lib/server/files.ts) (ソフトデリート)。

足りないもの:

- **専用の削除エンドポイントが無い。** 削除は SvelteKit の form action のみ
  (`POST /?/delete` と `POST /watch/[id]?/delete`)。オンライン復帰時にバックグラウンドで
  叩くには、`fetch` から呼べる `DELETE /api/recordings/[id]` を足すのが素直
  ([resume/+server.ts](../src/routes/api/recordings/[id]/resume/+server.ts) と同型で作れる)。
- **IndexedDB / Cache Storage を使っていない。** DL 済み動画とメタの置き場が要る。
- **`online` 復帰の検知が無い。** `navigator.onLine` / `online` イベント / Background Sync 未使用。

## 全体像

```
[視聴/一覧 UI] ──押す──▶ ダウンロード (Background Fetch)
     │                     backgroundFetch.fetch() でブラウザに預ける (タブを閉じても続く)
     │                     動画は端末が解けるコーデック (既定 AV1、無理なら H.264)
     │                     SW の backgroundfetchsuccess → IndexedDB に blob 保存
     │                     メタ (id, サイズ, DL日時, 消したいフラグ) も IndexedDB
     │
     ├─観る──▶ src を差し替え: DL 済みなら URL.createObjectURL(blob)、無ければ従来の API URL
     │
     └─消す──▶ IndexedDB から消す + 「サーバ側も消す」を予約 (outbox)
                     │
              online 復帰 ──▶ outbox を処理: DELETE /api/recordings/<id> → deleteRecordingFiles
```

**Service Worker は配信のキャッシュには使わない。** 現状の `/api/` 素通しは変えず、
SW に足すのは Background Fetch のイベント処理 (受け取って IndexedDB へ移す) だけ。
「殻だけキャッシュ・一覧はキャッシュしない」方針は崩さない。

## データモデル (IndexedDB)

DB 名 `denpa-offline`、ストア2つ:

- `videos` (key: `recordingId`)
  - `blob: Blob` — 動画本体 (.mkv)
  - `captions?: Blob` — PGS 字幕 (.sup)。[captions.sup](../src/routes/api/recordings/[id]/captions.sup/+server.ts)
  - `poster?: Blob`、`chapters?: JSON`、`dataBroadcast?: Blob` — 完全オフライン化のため同梱
  - `meta: { name, series, subtitle, durationMs, bytes, downloadedAt, codec }`
  - `state: 'downloading' | 'ready'`、`progress: number`
- `outbox` (key: `recordingId`)
  - `{ op: 'delete', queuedAt }` — オンライン復帰で処理する予約

一覧・視聴の UI はこの `videos` を参照して「DL 済みか」を分岐する。

## 主要な流れ

### ダウンロード — Background Fetch API を使う (決定)

1. `swReg.backgroundFetch.fetch(id, [動画, 字幕, ポスター, チャプター, データ放送], {title, downloadTotal})`
   で**ブラウザにダウンロードを預ける**。アプリ (タブ) を閉じても続き、
   進捗はブラウザ標準のダウンロード UI に出る。認証はセッション Cookie で通る
   ([auth.ts](../src/lib/server/auth.ts) の `sessionMayRead` で `/api/…/file` は緩和済み)。
2. Service Worker の `backgroundfetchsuccess` で受け取り、IndexedDB へ移して
   `state='ready'`。`backgroundfetchfail` / `backgroundfetchabort` は途中までを捨てる。
   (SW が配信ルートをキャッシュしない方針は変えない — SW に足すのはこのイベント処理だけ)
3. 対応していないブラウザ (Safari / Firefox) は**ページ主導の fetch にフォールバック**
   (タブを開いたまま。進捗は一覧のバッジに出す)。機能検出は
   `'backgroundFetch' in swReg`。

### どちらを落とすか — 端末が解けるコーデック (決定)

**既定は AV1** (`library_path`)。端末が AV1 を解けなければ H.264 (`alt_path`) に落とす。
判定は `navigator.mediaCapabilities.decodingInfo()` (`video/mp4; codecs=av01.…` の
`supported`)。H.264 しか解けない端末で `alt_path` が無い録画は、ダウンロード時に
「この端末では再生できない」と断る (落とすだけ落とせても観られないため)。

### オフライン再生

- `src` の `$derived` を「`videos` に `ready` があれば `URL.createObjectURL(blob)`、
  無ければ従来の API URL」に変える。字幕・チャプターも同様に blob / メモリから読む。
- 使い終わったら `URL.revokeObjectURL` する ($effect のクリーンアップ)。

### 削除とサーバ同期

- 端末で削除 → `videos` から除去し、`outbox` に `{op:'delete'}` を積む。
- `online` イベント (と起動時の `navigator.onLine`) で `outbox` を処理:
  `DELETE /api/recordings/<id>` → サーバは [`deleteRecordingFiles`](../src/lib/server/files.ts) を呼ぶ。
  成功したら `outbox` から消す。失敗は残して次の復帰で再試行。

> [!IMPORTANT]
> **「消したら自動でサーバも消す」は取り返しがつかない。** 端末での削除に、いまの一覧と
> 同じ**2回クリックの確認**を必ず付ける。オフラインで消したものが、オンライン復帰の
> 一瞬で本体からも消えることをユーザーが理解できる文言にする (「端末とサーバの両方から
> 消えます」)。事故を防ぐため、`outbox` 処理の前に通知を1本出すのも検討。

## 決めたこと

- **コーデック: 端末が解けるもの。既定は AV1** (上記)。
- **ダウンロード: Background Fetch API** (上記)。非対応ブラウザはページ主導にフォールバック。
- **削除の口: `DELETE /api/recordings/[id]` を新設。** 認証は書き込み扱い
  (form action と同じ経路)。`fetch` DELETE は同一オリジン + セッション必須で自前確認。
- **容量: 落とす前に確かめる。** 30分で約300MB。`navigator.storage.estimate()` で残量を
  見て、入らなければ断る。`navigator.storage.persist()` を要求して、ブラウザが勝手に
  消さないようにする。
- **部分 DL の後始末:** Background Fetch はブラウザが面倒を見る (失敗イベントで捨てる)。
  ページ主導フォールバックの中断だけ、起動時に `downloading` を掃除する。
- **視聴位置 (`resume_ms`):** オフライン中に進めた位置は端末に覚えておき、復帰時に
  まとめて `PUT /api/…/resume` で送る (outbox に相乗り)。端末間同期の仕組みは変えない。

## 影響範囲 (実装時の当たり所)

- 追加: `src/lib/offline.svelte.ts` (IndexedDB ラッパ + ストア)、
  `src/routes/api/recordings/[id]/+server.ts` (DELETE)。
- 変更: [watch/[id]/+page.svelte](../src/routes/watch/[id]/+page.svelte) (src 差し替え・DL/削除ボタン)、
  [+page.svelte](../src/routes/+page.svelte) (一覧に DL 済みバッジ)、
  必要なら [auth.ts](../src/lib/server/auth.ts) (DELETE の許可経路の確認)。
- SW ([service-worker.ts](../src/service-worker.ts)) は当面変えない。
