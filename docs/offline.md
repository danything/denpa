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
[視聴/一覧 UI] ──押す──▶ ダウンロード
     │                     fetch(cookie付き, Range可) で /file・字幕・ポスター・
     │                     チャプター・データ放送を取得 → IndexedDB に blob 保存
     │                     メタ (id, サイズ, DL日時, 消したいフラグ) も IndexedDB
     │
     ├─観る──▶ src を差し替え: DL 済みなら URL.createObjectURL(blob)、無ければ従来の API URL
     │
     └─消す──▶ IndexedDB から消す + 「サーバ側も消す」を予約 (outbox)
                     │
              online 復帰 ──▶ outbox を処理: DELETE /api/recordings/<id> → deleteRecordingFiles
```

**Service Worker はキャッシュに使わない。** 現状の `/api/` 素通しは変えず、DL は
ページ (またはSW) から**明示的に `fetch`** して blob を IndexedDB に積む。SW の
「殻だけキャッシュ・一覧はキャッシュしない」方針を崩さないため。

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

### ダウンロード
1. `fetch('/api/recordings/<id>/file?source=encoded')` を Range で分割取得
   (中断・再開できるように)。認証はセッション Cookie で通る
   ([auth.ts](../src/lib/server/auth.ts) の `sessionMayRead` で `/api/…/file` は緩和済み)。
2. 併せて字幕・ポスター・チャプター・データ放送も取得
   (視聴画面がそれぞれ別 fetch している。[watch/[id]/+page.svelte](../src/routes/watch/[id]/+page.svelte))。
3. すべて IndexedDB に入れて `state='ready'`。進捗は一覧のバッジに出す。

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

## 判断が要るところ / 未決

- **新規エンドポイント `DELETE /api/recordings/[id]`。** 認証は書き込み扱い
  (form action と同じ経路)。CSRF: SvelteKit の form は保護されるが、`fetch` DELETE は
  自前で確認 (同一オリジン・セッション必須)。
- **コーデック。** 端末が AV1 を再生できるか。両方焼いた録画は H.264 (`alt_path`) も
  あるので、[types.ts](../src/lib/types.ts) の `alt_path` を落とす選択肢を UI に出すか、
  端末の再生可否 (`MediaCapabilities`) で自動で選ぶ。
- **容量。** 30分で約300MB。`navigator.storage.estimate()` で残量を見て、入らなければ
  断る。永続化は `navigator.storage.persist()` を要求 (ブラウザが勝手に消さないように)。
- **部分 DL の後始末。** 中断した `downloading` は起動時に掃除するか再開するか。
- **視聴位置 (`resume_ms`)。** 現状サーバ DB で端末間同期している。オフライン中に進めた
  位置は、復帰時にまとめて `PUT /api/…/resume` で送る (outbox に相乗り)。
- **SW を絡めるか。** 最初はページ主導 (fetch→IndexedDB) が単純。将来 Background Fetch API
  (Chrome) を使えば、アプリを閉じても DL が続く — が対応ブラウザが限られるので後回し。

## 影響範囲 (実装時の当たり所)

- 追加: `src/lib/offline.svelte.ts` (IndexedDB ラッパ + ストア)、
  `src/routes/api/recordings/[id]/+server.ts` (DELETE)。
- 変更: [watch/[id]/+page.svelte](../src/routes/watch/[id]/+page.svelte) (src 差し替え・DL/削除ボタン)、
  [+page.svelte](../src/routes/+page.svelte) (一覧に DL 済みバッジ)、
  必要なら [auth.ts](../src/lib/server/auth.ts) (DELETE の許可経路の確認)。
- SW ([service-worker.ts](../src/service-worker.ts)) は当面変えない。
