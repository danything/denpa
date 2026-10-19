# どこに何があるか

**索引。** ファイル・画面・状態遷移・テストの入口をまとめてある。環境変数は [config.md](config.md) に。

**「なぜそうなっているか」はここには書かない。** 理由は
[architecture.md](architecture.md) に置く (両方に書くと必ず片方が古くなる)。
迷ったら「これは何」ならここ、「なぜこれ」なら architecture.md。

チューナーエージェントから TS を受け取り、番組表の読み取り・予約・録画・エンコード・
保存先への配置までを受け持つ。
出来上がった mkv はブラウザ (`/watch`) かテレビのアプリ (danything/denpa-tv) で観る (外部のプレイヤーには対応しない)。削除は手動。
EPGStation の置き換えとして作ったもので、エンコード設定はそこから移した。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/lib/server/tuner.ts` | チューナーエージェントとのやり取り (選局・チューナー一覧)。同じ TS を指す枠の判定もここ |
| `src/lib/server/agent-events.ts` | エージェントからの通知 (`/denpa/events`) の購読 |
| `src/lib/server/epg.ts` | 局と番組表のDB書き込み、予約時刻の追従 |
| `src/lib/server/epg-collect.ts` | 番組表集め (どのチャンネルを何本並べて開くか) |
| `src/lib/server/scan.ts` | チャンネルスキャンの総当たり (選局はエージェント、NIT/SDT を読むのはこちら) |
| `src/lib/server/channel-seed.ts` | BS / CS の局が無いとき、その種別の局を標準の表 (`channel-seed.json`) から入れる (全国で同じなのでスキャン不要) |
| `src/lib/server/rules.ts` | ルール(キーワード/局/ジャンル)から予約を作る |
| `src/lib/server/search.ts` | サイト全体の検索 (`/search`)。番組表・録画・予約・ルールを同じ読み方 (空白で区切った語をすべて含む。`title.searchable` で揃えて比べる) で探す。`GLOB` で候補を減らしてから JS で当てる。番組表はルールと同じ判定 (`rules.matchesCompiled`。番組名と概要)。**要るぶんだけ読む** (並べた順に少しずつ読み、上限に1つ足したぶんが揃ったら止める。件数は `count(*)` で、外字に寄せた字を含む言葉だけ全部読んで数える) |
| `src/lib/server/rule-preview.ts` | ルールの下見。書きかけの条件でこれからの放送の何を録るか (`rules.missOf` と同じ回のまとめ `rules.previewSkips`。予約を立てるときと同じ判定)。先頭 100 件にチューナーの取り合いを当てる。`ids` を渡すと番組ごとの「録る / 予約済み / 録らない (理由)」も返す (検索の結果の行に出す) |
| `src/lib/server/rule-form.ts` | ルールの書く欄の読み取り (`conditionsOf`。下見も保存も同じもの)・ルール名・録画や番組からの下書き (`originOf`) |
| `src/lib/server/rule-actions.ts` | ルールを足す・直す・止める・消す (検索の画面とルールの一覧が同じものを呼ぶ)。足したらそのルールだけ、ほかは全ルールを当て直す |
| `src/lib/search-suggest.ts` | ヘッダーの欄の候補 (`/api/search` の答え) を節ごとの並びにし、選んだときの行き先を決める (番組・予約は `/search?q=…&program=<id>` で詳細、録画は観る画面、ルールは `/search?rule=<id>` で編集) |
| `src/lib/recent-searches.ts` | 最近の検索。端末ごとに localStorage に覚える (サーバには送らない) |
| `src/lib/server/episode.ts` | 同じ回は最初の放送だけ録る (`firstAirings`)。同じ回の見分け (`episodeOf` / `sameEpisode`。題名に話数・副題が無ければ概要から読む) と、同時放送の選び方 (字幕 → 衛星) |
| `src/lib/server/reservations.ts` | 手動予約と取り消し |
| `src/lib/server/conflict.ts` | チューナー割り当てと競合判定 (純粋関数) |
| `src/lib/server/scheduler.ts` | 予約 → 録画の状態遷移 |
| `src/lib/server/recorder.ts` | TS の受信とファイル書き出し |
| `src/lib/server/cm.ts` | CM検出。材料を読んで境目を決め、チャプター・実カット用の区間にする |
| `src/lib/server/cm-scan.ts` | CM検出の材料 (無音・場面の切れ目・局ロゴの枠) を1本の ffmpeg で1回だけ復号して読む |
| `src/lib/ts/cm-decide.ts` | CM の境目を決める (ロゴの消えている所を無音の切れ目と CM の並びで詰める。ロゴが無ければ CM の尺だけで。純粋関数) |
| `src/lib/server/encoder.ts` | 録画のエンコード (AV1 / H.264) |
| `src/lib/server/hwenc.ts` | GPU (QSV / VA-API) でエンコードできるかを起動時に確かめ、デバイスごとの方式を決める。共有の型と名前は `src/lib/hw.ts` |
| `src/lib/server/databroadcast.ts` | データ放送。1局に絞った TS をデコードして、組み立て終わったモジュールを配る |
| `src/lib/ts/bml.ts` | データ放送をデコードする (PMT の記述子 → カルーセル → ファイル) |
| `src/lib/ts/dsmcc.ts` | データカルーセル (DSM-CC) の DII/DDB。ロゴとデータ放送で分け合う |
| `src/lib/ts/carousel.ts` | 配ったものを覚えておく (遅れて繋いだ人に配り直すため) |
| `src/lib/components/player/DataBroadcast.svelte` | データ放送を映像の上に重ねる (d ボタン。押されるまで読み込まない) |
| `src/lib/ts/data-timeline.ts` / `src/lib/ts/data-capture.ts` / `src/lib/server/recorded-bml.ts` | 録画のデータ放送。エンコードするときに元のTSから変化ログを取り出して隣に置き (`.bml.jsonl`)、再生位置に合わせて流し直す |
| `src/lib/components/player/Remote.svelte` | 指で押すリモコン (色・十字・決定・戻る・d・数字)。映像の上ではなく右の列 |
| `src/lib/ts/ait.ts` | Hybridcast の在り処 (AIT)。読むだけ (開くのは画面の `HybridcastFrame`。`src/lib/hybridcast/` が差し込み) |
| `src/lib/server/bml-network.ts` | データ放送の双方向の中継 (`/api/bml/proxy`・`/post`・`/confirm`。Hybridcast の入れ物 `/hybridcast` も、オフなら同じく 403)。既定はオン (設定で切れる)・公開の相手だけ |
| `src/lib/ts/watch.ts` | 録画を観るときの押したことの読み方 (2回押し・チャプター送り・続きの位置。DOM を触らない) |
| `src/lib/icons/` | Lucide に無いアイコンの図形 (`~icons/denpa/*`。いまはデータ放送の d だけ。[player.md](player.md#アイコンは-lucide-を組むときに埋め込みます)) |
| `src/lib/components/player/` | 映像の上に置くもの。3画面 (ライブ・追っかけ・観る画面) で共通 (アイコン・重ねボタン・操作列・出し入れの決め方・字幕の重ね方) |
| `src/lib/server/library.ts` | 保存先でのファイル配置 |
| `src/lib/server/metadata.ts` | サムネイル (`-poster.jpg`) と、その置き場の決めごと |
| `src/lib/server/files.ts` | 録画の削除と、実体とDBの突き合わせ |
| `src/lib/server/disk.ts` | 保存先の残量の見張り (閾値をまたいだときに1回だけ知らせる) |
| `src/lib/server/fsx.ts` | ファイル操作の道具 (PVC をまたぐ移動・空フォルダを畳む) |
| `src/lib/server/serve.ts` | ファイルの配信 (Range 対応) |
| `src/lib/server/scramble.ts` | スクランブルの検出と、チューナー側への解除依頼 |
| `src/lib/server/live.ts` | ライブ視聴。エンコード方式・ストリームの共有・見ている人の勘定 ([stream.md](stream.md))。追っかけ再生の入口 (`openChase`) もここ |
| `src/lib/server/chase.ts` | 追っかけ再生の追い読み。録画中の伸びる元のTSを尻から読み続け、バイト比例でシークの当たりを付ける ([issue #16](https://github.com/danything/denpa/issues/16)) |
| `src/lib/server/captions.ts` | ライブの字幕。映像と同じ ffmpeg から字幕をそのまま写して受け、デコードして文字の配置にして配る (別々に起こすと時刻が揃わない) |
| `src/lib/ts/b24caption.ts` | 放送の字幕 (ARIB STD-B24) をデコードして字の置き場所まで決める。libaribcaption のデコーダを写したもの。表は `b24-tables.ts` (手で持つ。始まりは libaribcaption の表の写し) |
| `src/lib/ts/drcs-smooth.ts` | 字にできない外字 (DRCS) の白黒の画像を、斜めを丸めた濃淡の画像にしてから送る (引き伸ばしてもジャギジャギにならない) |
| `src/lib/caption-text.ts` | 字幕の文字の配置の形式 (サーバと画面とテレビのアプリの取り決め。[api.md](api.md#字幕の文字の配置)) |
| `src/lib/ts/captions.ts` | 届いた字幕を、映像に合わせて出す順に並べる (DOM を触らない) |
| `src/lib/ts/mkv.ts` | Matroska からコマと時刻を取り出す。字幕は時刻をコマに付けて運ぶ (録画の字幕が S_ARIBSUB かも見る)。EBML の読み方は `mkv-media.ts` もこれを使う |
| `src/lib/live.ts` | ライブ視聴でサーバと画面が取り決めていること (多重化の種別・指示・通知) |
| `src/lib/live-player.svelte.ts` | ライブ視聴の受け側。WebSocket → MSE、音声の選び直し、切り替え中の映像 |
| `src/lib/ts/pacing.ts` | ライブの再生位置の決め方 (どれだけ貯めるか。DOM を触らない) |
| `src/lib/ts/fmp4.ts` | ffmpeg の fMP4 を MSE が食える単位に割る |
| `src/lib/ts/media-source.ts` | MSE の実装を選ぶ。無ければ `ManagedMediaSource` (iPhone の Safari) |
| `src/lib/remux-player.ts` | 観る画面で、サーバがその場で流す fMP4 (詰め替え・変換) を MSE で受ける。飛んだ先が無ければリクエストし直す ([library.md](library.md#何で観るかはサーバが出せるものから画面が選ぶ)) |
| `src/lib/canvas-player.ts` | 観る画面の互換モード。`/stream` を fetch で読んで canvas に描く (`raw/engine.ts`)。飛ぶときは捨ててリクエストし直し、先へ読みすぎない ([stream.md](stream.md#録画の観る画面も-canvas-に描く)) |
| `src/lib/drive-gate.svelte.ts` | 互換モードで初めて再生する前の、運転中の注意。押されるまで再生を待たせる (ライブ・追っかけ・観る画面で同じ) |
| `src/lib/mkv-source.ts` / `src/lib/ts/mkv-media.ts` / `src/lib/raw/mkv.ts` | 互換モードで端末に保存した録画 (Matroska) を描く。頭と Cues を読んで飛び先の Cluster から流し、worker がそのまま読んで fMP4 と同じ経路でデコードする ([stream.md](stream.md#録画の観る画面も-canvas-に描く)) |
| `src/lib/ts/playback.ts` / `src/lib/server/playback.ts` | 録画の観方。何を出せるか・どの形式で出すか・時刻の物差しはサーバが決め、どれを使うかは画面が決める (`api/recordings/<id>/playback`・`stream`。[api.md](api.md#録画の観方-get-apirecordingsidplayback)) |
| `src/lib/ts/seek.ts` | 録画の TS の中で時刻からバイトの位置を引く (決まった位置の PES の PTS で二分探索。PTS の一周は頭から数えて越える) |
| `src/lib/server/transcode.ts` | その場で変換する本数の枠 (録画の変換と追っかけを数え、ライブは数えない。既定は GPU の有無で 2 か 4、設定で変えられる) |
| `src/lib/server/ws.ts` | WebSocket の受け付け (多重化の頭を付け外しする) |
| `src/lib/server/tickets.ts` | WebSocket に繋ぐための使い捨てのチケット ([auth.md](auth.md)) |
| `src/lib/arib.ts` | ARIB の符号を言葉に直す (ジャンル・映像・音声)。選べる音声の組み立ても |
| `src/lib/server/logo.ts` | 局ロゴの収集と保存 (番組表に出すPNG) |
| `src/lib/server/logo-data.ts` | CM検出のために覚えたロゴ (`own-logo-*.bin`) の置き場・画像にする・破棄・同じ画像の局へ配る |
| `src/lib/ts/logo-area.ts` | 隅の縁の強さからロゴのかたまりを選んで枠にする (純粋関数。隅だけを見る) |
| `src/lib/ts/logo-detect.ts` | CM検出のロゴ判定。線の向きで覚え、コマごとに当てて区間にする (純粋関数) |
| `src/lib/server/logo-own.ts` | 覚えるコマを ffmpeg で抜き (当てるコマは cm-scan から受け取る)、覚えたもの (`own-logo-<幅>x<高さ>.bin`) を局ごとの入れ物に置く |
| `src/lib/components/ProgramFacts.svelte` | 番組の中身そのもの (枠は持たない)。モーダルと観る画面の両方から使う |
| `src/lib/components/home/` | ホーム (`/`) の部品。行 (`TimelineRow`。予約・録画・録り逃し)・番組の見出し (`GroupHead`)・日付と「いま」の見出し (`TimelineHeading`)・サイドバー (`TimelineSidebar`)・狭い画面の一枚 (`FilterSheet`)。開いた行の覚えや詳細の開き方はホームがコンテキストで配る (`context.ts`)。開いたときの位置へ送るのは `placement.ts`。見た目は `home.css` (`.board` の下だけに効く。部品をまたぐ行の作りを1か所に置く) |
| `src/lib/components/LearnedLogo.svelte` | CM検出用に覚えたロゴを小さな画像で出し、「覚え直す」で捨てる (設定の「ロゴ」の局ごとの行) |
| `src/lib/components/ServiceLogo.svelte` | 局ロゴ (一覧・番組表・ライブ)。まだ取得できていない局の出し方は画面ごと |
| `src/lib/components/ChannelNotice.svelte` | 局が無いときの案内と「スキャンへ」(録画・番組表・ライブの上の1行と、空の番組表の真ん中)。出すかどうかは `#lib/channel-notice.ts` (地上波が無い / どれも無い) |
| `src/lib/components/CheckRow.svelte` | チェック + 見出し + 1行の要点 (設定の決まりの形) |
| `src/lib/components/ActionButton.svelte` / `ArmedDelete.svelte` | 送るだけのボタン (`submitting` 付きの POST) と、2回押しで消すボタン (`arming.svelte.ts`。録画・予約・ルール・通知先) |
| `src/lib/components/JobProgress.svelte` | 時間の掛かる仕事の進み具合 (進捗バーと「いくつ中いくつ」) |
| `src/lib/components/Toasts.svelte` | 押した結果を画面の右下に浮かせて出す (本文を押し下げない) |
| `src/lib/paging.svelte.ts` / `paging.ts` | 長い一覧を少しずつ出す (`Paged` + `sentinel`。無限スクロール) と、その代わりの絞り込み (`matches`。空白区切りの語をすべて含む)。少しずつ出すのは予約・録画・ルールの一覧、絞り込みは予約・録画の一覧が使う |
| `src/lib/ts/psi.ts` | TS の PSI (PAT / PMT / NIT / SDT) を読む。チャンネルスキャンで局の一覧を知るのに使う (エージェントは NIT も SDT も読まない) |
| `src/lib/ts/bytes.ts` | バイト列の細かい道具 (繋ぐ)。中身の意味は持たない |
| `src/lib/ts/clock.ts` | PCR をサーバが受け取った時刻に結びつけ、エンコードしたものの物差しに直す (TDT は局ごとにずれるので使わない) |
| `src/lib/ts/aribtext.ts` | ARIB STD-B24 の8単位符号を読む (番組名・局名) |
| `src/lib/ts/aribtext-gaiji.ts` | ARIB 外字の対応表 (`🈟` `🈑` はここ)。字は字幕の表 `b24-tables.ts` を引き、番組表だけで違える数点を持つ |
| `src/lib/ts/eit.ts` | EIT[schedule] と EIT[p/f]。集まり具合の判定も |
| `src/lib/ts/service-filter.ts` | チャンネル丸ごとの TS から1局ぶんを抜く |
| `src/lib/ts/logo.ts` | TS から局ロゴを読む (地上波は CDT、衛星は下記) |
| `src/lib/ts/logo-dsmcc.ts` | 衛星の局ロゴをデータカルーセル (DSM-CC) から読む |
| `src/lib/ts/logo-palette.ts` | 局ロゴPNGに ARIB の色の表 (PLTE/tRNS) を入れ直す |
| `src/lib/ts/png.ts` | PNG の塊と CRC。データ放送 (`bml/png.ts`)・局ロゴ・覚えたロゴの画像で同じものを使う |
| `src/lib/ts/synth.ts` | TS のセクションを組み立てる (テストと偽エージェント用) |
| `src/lib/server/migrate.ts` | EPGStation からの引き継ぎ ([migrate.md](migrate.md)) |
| `src/lib/server/title.ts` | 番組名からシリーズ名・編 (`「作品名」〇〇編` `第2期`)・副題を切り出す。一覧と入れ物の title の名前 (`displayTitle`) |
| `src/lib/server/paths.ts` | 前段の接頭辞 (`/denpa` など) の下でも動く URL。転送は相対、外に渡す絶対 URL だけ `X-Forwarded-Prefix` / `X-Ingress-Path` を頭に付ける (`publicBase`) |
| `src/lib/server/auth.ts` | どのエンドポイントをどう守るか ([auth.md](auth.md)) |
| `src/lib/server/address.ts` | アドレスと CIDR の判定、前段越しの本当の接続元 (`TRUSTED_PROXIES`)。入口の `server.js` もこれを直に import する (イメージにもこの1枚を置く) ([auth.md](auth.md#前段の後ろに置くとき-trusted_proxies)) |
| `src/lib/server/oidc.ts` | OIDC (discovery・PKCE・ID トークンの検証)。ライブラリは使っていない |
| `src/lib/server/session.ts` | ログインの控え (DBに持つ。Cookie に入るのは32バイトだけ) |
| `src/lib/server/device-auth.ts` | テレビのアプリのペアリング (デバイス認可) と、アプリに渡すアクセストークン (`Authorization: Bearer`)。秘密は SHA-256 だけ持つ ([auth.md](auth.md#アプリのペアリング)) |
| `src/lib/server/manifest.ts` | ホーム画面に置いたときの見た目。名前は来た名前ごとに変える ([watch.md](watch.md#ホーム画面に置く)) |
| `src/lib/server/events.ts` | 画面へ変化を知らせる (SSE。ポーリングの代わり) |
| `src/lib/server/update.ts` | 新しい版が出ているかを GitHub のリリースと比べる |
| `src/lib/server/webhook.ts` | 録画の節目 (開始・完了・失敗)、エンコードの完了・失敗、録画の外側の変事 (ディスク残量わずか・チューナーに繋がらない/繋がった) を外部へ通知する |
| `src/lib/server/runtime.ts` | 常駐処理の起動 (hooks.server.ts から呼ばれる) |
| `src/lib/server/shutdown.ts` | 止められている最中かの印 (居座り中に始めた録画を記録に残すため) |
| `src/lib/server/recording.ts` | 録画の行を引く・通知に載せる要点 (画面と API の共通の前置き) |
| `src/lib/server/stream.ts` | ReadableStream をチャンク・行・文字列で読む道具と、子プロセスを起こして結果を待つ `run` |
| `src/lib/server/ts-probe.ts` | 元のTSを開くときの探りの長さ (エンコード・CM の切り出し・字幕で共通) |
| `src/lib/server/config.ts` | 環境変数 |
| `src/lib/server/settings.ts` | 画面から変えられる設定 (初期値は `config.ts`。DBに値があればそちらが勝つ) |
| `src/lib/server/db.ts` / `schema.ts` | SQLite。テーブルの定義は `schema.ts` (drizzle) にしか無く、型もマイグレーション (`drizzle/`) もそこから出す ([development.md](development.md#db-の列を足す)) |

## 状態遷移

```text
予約 scheduled ─(開始時刻)→ started_at が入る ─→ あとは録画の行が持つ
      ├(チューナー不足)→ conflict
      ├(コピー禁止の番組)→ skipped (録画しない。放送が終わってもそのまま。data.md「コピー禁止の番組は録らない」)
      ├(手で取り消し)→ canceled
      └(始まらないまま放送終了)→ missed

録画 recording ─→ recorded ─→ available ─(削除)→ deleted
      (どの段でも、録画そのものが失敗して error が入れば failed。優先は deleted → failed → recording)
```

**状態は列として持ちません。** 持っているのは事実だけで、そこから毎回決めます。

| 見せる状態 | 何から決まるか |
| --- | --- |
| `recording` | `recordings.finished_at` がまだ NULL (=チューナーを使っている) |
| `recorded` | 録り終えたが保存先にはまだ無い |
| `available` | `library_path` が入っている |
| `failed` | `recordings.error` が入っている (録画そのものの失敗だけ) |
| `deleted` | `deleted_at` が入っている |
| エンコード中 / エンコード失敗 | `encode_jobs` の最新の1件 (録画の状態には混ぜない) |

`recordings.state` は SQLite の**生成列** (`schema.RECORDING_STATE`) で、書き込もうとすると
SQLite が拒むので、事実と状態が食い違いません (文字列で別に持っていた頃は、エンコードの失敗が録画の失敗として
書き込まれていました)。

チューナーの台数を数えるときは、番組の時刻ではなく前後マージンを足した
「実際に使っている区間」で重なりを見ます。22:00 終了と 22:00 開始は実際には重なるので、
揃えないと予約表では通るのに実行時に録り逃します。

**どのチューナーに入るかはエージェントが決め、denpa はその決まりの上で割り振ります** (`conflict.ts` の
`assign`)。エージェントは選ぶ順 (`GET /denpa/tuners` の `rank`) を公開し、空いているチューナーのうち
受けられて順がいちばん前のチューナーを使い、1回の選局の途中でチューナーを替えません
([agent.md](agent.md#選ぶ順の約束))。denpa はこの約束どおりに**開始順になぞって**、どの予約も
最後まで1台のチューナーを使えるときだけ通します。同じ物理チャンネルは1台を共有します。
ルールの下見 (`rule-preview.ts`) も同じなぞり方です (`contentions`)。台数が分からないとき (エージェントに
繋がらない・`rank` を返さない古い版) はどちらも何も言いません。

地上波専用と兼用 (PX-MLT など) を併せると、瞬間ごとの台数が足りていても録れない組があるので、
台数ではなくこのなぞり方で決めます (#668)。

**録画中の予約も数えます。** 録り始めた予約は割り振り直しませんが、終わるまでチューナーを塞ぎます。
どのチューナーにいるかはエージェントの一覧の利用者 (`rec <録画ID>`) から読み、なぞり始めの状態にします
(`tuner.recordingHolds`)。ライブや番組表集めは数えません。録画には必ず譲る約束なので、予約の
割り振りには効きません。録り始めたのにまだ使えていない (空き待ちで掛け直している) 録画は数えられません。

**止めた録画は、次の録画に引き継ぎとして渡します** (`after`)。同じ定期チェックで止めた録画の利用者
(`rec <録画ID>`) を付けて開くので、エージェントはそれらをもう離れたものとして選びます (わけは
[agent.md](agent.md#選ぶ順の約束) の4)。割り振りも離すほうを先に数えているので、同じになります。

**ルールの下見は、誰も使っていない瞬間からなぞります** (`conflict.settled`)。どのチューナーに
入るかはその前に誰がどのチューナーに入ったかで変わるので、出す時間帯の頭から始めると答えが変わります。
プレビューは優先度を見ず、皆同じ扱いで開始順になぞります。

**丸ごと入らないからといって、丸ごと捨てません。** 実機では、30分番組4本のうち
15分だけ3チャンネル要る形の取り合いが出ました。1台のチューナーに最後まで収まる一番長い区間だけ使います
(`assign` の「入るところまで録る」)。採るのが優先度の高い順なので、切られるのは必ず
優先度の低いほう。譲った区間は `record_from` / `record_to` に残り (番組の時刻は動かさない)、
予約一覧は「頭 15分 が欠けます」、録画一覧は「欠けています」と言います
(`format.clipNote`)。マージンだけ削られたぶんは言いません。隣り合う番組は
マージンぶんが必ず重なるので、数えるとほとんどの録画に注記が付きます。

**番組はマージンに勝ちます。** 22:00 終了 → 22:00 開始の隣り合いは、前の
終了マージンと後の番組そのものの取り合いで、保険であるマージンが譲ります。
丸ごと競合にしていた頃は、隣り合っているだけで後ろが録れませんでした。
削るのは要るぶんだけで、削らずに入るならマージンは残します。マージンだけ削ったときも
`record_from` / `record_to` に残します。残していなかった頃は、前が終了マージンまで使い続け、
後ろが開始マージンから取りに行っていたので、割り振りと違うチューナーに入ったり空き待ちで頭が欠けたりしました。

録画中にプロセスが落ちたら、次の起動でまだ放送中なら録り直します。元のTSは追記で
開くので、落ちるまでの分は残ります。放送が終わっていれば失敗に倒します。

**使っている者がいないまま終了時刻を過ぎた録画は、定期チェックで畳みます** (`failStrayRecordings`、
猶予1分)。起動時の拾い直しだけだと、録り直しに行った先でまた殺されたとき
(ノードごと落ちる・Pod を強制終了する)、次の起動まで誰も畳みません。畳まれない行は
予約の一覧に「録画中」で居座り、録画の一覧には出てきません (どちらの振り分けも
`recordings.state = 'recording'` で決まる)。元のTSは消さないので、録れていた分は詳細から再エンコードできます。

## 画面

| 画面 | 役割 |
| --- | --- |
| `/` | **予約と録画を1本の一覧** (時間軸) に並べる。並べ方は `#lib/timeline.ts` (単体テストあり): 上がこれからの予約 (遠い先が上)、「いま」の線 (見出し。読み上げは「いま 14:32」) と録画中、下が録れたもの (録画と録り逃し。新しい順)。どちらの側も「いま」に近いものが線の側に来る。日付の見出し (`h2`。今日・明日・昨日は言葉で、予約か録画かも言う) は一覧の頭に貼り付く。「完了分も表示」で出る終わった予約は録れたものの側。開いたときは、観終えていない録画 (`watched_at` が無く観られるもの) のうちいちばん古いものを映す。60 件より先にあればそこまで描いてから送る。無ければ線を映す (線を見えている所の 3 割ほどの高さに)。線より下だけ 60 件ずつ描き足す (`Paged`)。線より上は全部描く (上へ足すと、位置合わせの無いブラウザでは読んでいる所が跳ねる)。広い画面 (768px 以上) は main の余白の外まで広げ、一覧とサイドバーがそれぞれ自分でスクロールする。1000px 以上は右に**サイドバー** (端まで寄せる。一覧とは線で分けず、地も同じ。グループの間は見出しの上の細い線。ドキュメントの目次と同じ作り): 絞り込み (すべて・予約・録画中・未視聴・失敗と件数。その場かぎり)、表示の切り替え (まとめて表示は cookie で端末に覚え、サーバが読む。完了分・削除済みは URL の `?all=1`・`?deleted=1`。ファイルと照合)、今日のまとめ (次の録画・録画中・未視聴・空き。空きは `disk.capacity`)、選んだ番組 (指を乗せた行・焦点のある行・最後に開いた行。無ければ「いま」に近いもの。再生・追っかけ・予約取消)。1000px 未満はサイドバーの代わりに、頭のボタン (いまの絞り込みと件数を出す) から下からの一枚 (`<dialog>`) を開く。番組名で探すのはホームではなく全体の検索。行は 48px (広い画面は1段、1000〜1279px と狭い画面は番組名の下に局と尺の2段)。線も枠も無く、触れると薄い塗り、サイドバーに出ている行は少し濃い塗り。言うことがあるときだけ下に1段足す (競合の理由・欠ける・ロゴでCMを判定できなかった・端末に保存・エンコードの進み具合)。「まとめて表示」(`#lib/grouping.ts`) は予約にも録画にも効き、同じ番組でも線の上と下で別の見出し (1つにすると見出しの位置が時間の並びから外れ、開くと中身が線をまたぐ)。番組の位置は、予約は次の回 (`groupBySeries` の `earliest`)、録画は最新の回。まとめる鍵はエンコードしたものを置くシリーズのフォルダ名 (`library.seriesFolder`。シリーズ名の無い行は番組名を `parseTitle` で切って使う)。中は放送順。1本しか無い番組はまとめずにふつうの行。見出しは本物の button (`aria-expanded`) で、開いた番組は側ごとにその場かぎり覚える。録画の行を押すと観る画面 (`/watch/<id>`) へ、中身は行の「詳細」(アイコン) から (録っている最中のものは線の下の予約の行の「追っかけ」で `/chase/<id>` へ。エンコード中・エンコード失敗でも元のTSがあれば観る画面で観られる。押せないのは録画失敗・削除済み・録り逃しで、その行は行そのものが詳細の入口)。詳細に「ルールを作る」(`/rules?recording=<録画ID>`)。めったに押さないもの (視聴済みの付け外し・再エンコード・CM検出のやり直し) は「その他…」に畳む。録画をファイルとして持ち出すダウンロードは持たない ([Discussion #760](https://github.com/danything/denpa/discussions/760))。「CM検出をやり直す」は再エンコードせずに CM を探し直す ([cm.md](cm.md#cm-検出だけやり直す))。開いた番組の頭にも「ルールを作る」(録画ならいちばん新しい録画、予約なら次の回の番組から)。予約の詳細にも取消と「ルールを作る」(`/rules?program=<番組ID>`)。行の頭にポスター (`api/recordings/<id>/poster`。無ければ枠だけ。読めなかったら隠す。`onerror` を属性で書くとサーバの HTML にインラインのハンドラとして出て CSP に止められるので、アクションで付ける)。途中まで観たものは「続き」の進捗バーと残り時間。まだ観ていないものは番組名の頭に点、まとめた見出しには「未視聴 N」。置いてあるものは全部の大きさを出す (`43 MB (H.264 71 MB、元のTS 594 MB)`)。300件で頭打ちのときはその旨を出す。録り逃しは録れたものの側に出し、確かめ終わったら2回押しで消せる。どの行にも「何で立ったか」を出す (広い画面の行と詳細。ルール名がそのまま編集への入口で、手動で録ったものもそう書く)。エンコードの失敗では再生も録り直しも消さない。**`/?q=` は `/search?q=` へ転送する** (`hooks.server.ts`。言葉で探すのはサイト全体の検索に寄せた) |
| `/guide` | 番組表(グリッド)。言葉で探すのは `/search`。表の外の細い1行 (狭い画面は表の下、下のタブのすぐ上) に、種別・日付 (番組の残っている前の日を控えた字で今日の左に、今日から番組表の届いている日まで並べて直接押す。今日は「今日 19(月)」と日付も出す。番組の無い日は押せない。土日は字の色。← → は並びが入りきらないときだけ)・時刻 (今・朝 6:00・昼 12:00・夜 19:00・深夜 23:00 へ送る。今は今日だけ)・ジャンルの色の見本 (押すとそのジャンルだけ目立たせる) を置く。入りきらない幅では時刻を「⋯」へ、狭い画面では ← 日付 → にして日付のメニューに1週間ぶんと時刻を入れる。マスはジャンルごとに色を変える。**サブチャンネル (テレ東2・3、Eテレ2・3、BS朝日2・3 など) は既定で出す**が、並ぶのはその日に分割放送 (本チャンネルと違う番組) のあるサブだけで、本チャンネルのすぐ右に置く。そのときは「サブch」の切り替えも出て、切ると本チャンネルだけになる (端末ごとに cookie で覚える)。同じものを流している間 (名前の無い枠・重なる時間の本チャンネルの番組と同じ名前・番組が無い) は本チャンネルのマスが横に伸びて1つになる。分割放送の間だけサブに自分のマスが立つ (`#lib/subchannels.ts`)。ずっと本チャンネルと同じ番組のサブは列を立てない。本チャンネルとサブは地上波・BS とも同じ TS (`services.channel`。BS朝日1〜3 は `BS01_3`) で束ね、サービスID のいちばん若い局を本チャンネルとする。イベント共有 (サブが本チャンネルと同じ番組を流すこと) は同じ TS の中でしかできない決まり (ARIB TR-B14 第四編 17.2、TR-B15 第一部 第四編 17.2)。WOWOW のプライム・ライブ・シネマは同じ会社でも TS が別なので別の局のまま。CS・SKY は束ねない (1つの TS に別々の会社の局が乗る)。隠しても録画のルールには関わらない。ライブの一覧も、いま本チャンネルと同じ番組を流しているサブは同じ決め方で外す (`epg.airing`)。詳細から予約・取消と、エンコードできていれば録れたものをそのまま観られる。「ルールを作る」で検索の画面の「ルールとして保存」へ (`/search?from=program:<番組ID>`)。いま流れている番組には「視聴」が出て、その局でライブ画面が開く。音声は**放送が付けた名前**で出す (「主音声ステレオ」「解説ステレオ」)。符号だけだと解説放送で同じラベルが2つ並ぶ |
| `/live` | **いま流れているものを見る** ([stream.md](stream.md))。左に映像、右に局の一覧。前回見ていた局から開く (覚えていなければリモコン番号のいちばん若い局。番組表の「視聴」から来たときはその局)。局の並びは番組表と同じ。操作列は自前 (備え付けは使わない) で、止めた所から見られる (追いかける速さを選べ、追いついたら自分でライブに戻る)・音声を選べる・エンコード方式 (H.264 / AV1) を見ながら選べる・字幕を出せる・いまの1コマを字幕ごと切り抜ける・切り替えの間は前の映像を貼る。d と切り抜きは右上の縦列 (観る画面と同じ場所・同じ並び)。右上の録画ボタンで、いま観ている番組の録画が始まる (手動予約と同じ流れ)。画質の切り替えで MPEG-2 を選ぶと、エンコードせずに放送そのままを WASM でデコードして見られる ([stream.md](stream.md#放送そのままmpeg-2を送る))。データ放送も出せる (d ボタン。指で押せるリモコンが右に並ぶ)。Hybridcast は行き先を出し (別のタブで開く)、データ放送が起動を求めたら映像の上に開く ([stream.md](stream.md#hybridcast)) |
| `/chase/<id>` | **追っかけ再生** ([issue #16](https://github.com/danything/denpa/issues/16))。録画中の録画を頭から観る。一覧の予約側の録画中の行の「追っかけ」から (録れている最中の行はまだ予約の側にいる)。元のTSはブラウザで読めないので、サーバが伸びるファイルを追い読みしてライブと同じ経路 (fMP4 → WebSocket → MSE) で再エンコードする。チューナーは使わない。押し方は観る画面と同じ (空白・矢印・画面内クリック、指は端2回で10秒)。速さも同じところに覚える。シークバーは番組の全長で、右端 (いま録れているところ) は伸びていく。手元に残っている範囲は即座に、外は `chase` の送り直し (ffmpeg 立て直し) で飛ぶ。視聴位置は15秒おきにサーバへ写すので、エンコードが終わったあとの `/watch` が続きから拾う。録り終えた録画で開くと `/watch` へ回す (エンコードを待っている間も) |
| `/watch/<id>` | **録画をブラウザで観る。** 画面の構成と操作 (2段組・全画面・端2回で10秒・CM飛ばし・字幕・速さ・続き・その場で削除) は [library.md](library.md#観るのはブラウザで)。録り終えた録画はどれもここで観る。何で観るかはサーバが出せるもの (`api/recordings/<id>/playback`) から画面が選ぶ (エンコード済みそのまま・詰め替え・その場の変換。[library.md](library.md#何で観るかはサーバが出せるものから画面が選ぶ))。コーデックのメニュー (自動・H.264・AV1。端末ごとに覚える) は観られる方式が2つ以上あるときだけ。音声トラックも選べる。二カ国語・二重音声・解説をエンコードしたものは全部入っている。ブラウザがコンテナから出せればそこで切り替え (`video.audioTracks`)、出せなければ (Chrome・Firefox の既定) 選んだときにその場で流すほう (`/stream?audio=`) へ移る ([library.md](library.md#何で観るかはサーバが出せるものから画面が選ぶ))。番組表から消えた録画でもジャンル・音声・詳細のラベルは出る。録り始めに `recordings` へ写してあり、詳細の種はそれを既定の null で潰さない (`detail.svelte.ts`) |
| `/api/recordings/<id>/resume` | どこまで観たかを覚える (POST)。端末ではなくサーバに置くので別の端末でも続く。末尾まで観たものは忘れる |
| `/api/recordings/<id>/captions.json` | 字幕を文字の配置で返す。入れ物の中の放送の字幕 (S_ARIBSUB) を抜いてサーバでデコードする (まだエンコードしていない録画は元の TS から抜き、TS の頭からの秒で返す)。字幕を持たない録画と、ずっと前にエンコードした録画 (画像の字幕 PGS。もう読まない) は 404 (画面はボタンを出さない) |
| `/api/recordings/<id>/chapters` | エンコードしたものに入っているチャプター (CM飛ばしの行き先)。DB ではなくファイルから読む。CMを切ってエンコードしたものと引き継いだ録画では DB と食い違う。まだエンコードしていない録画は検出した区間 (`cm_ranges`。元の TS の頭からの秒) から組む。時刻は `playback` の物差しの秒で、テレビのアプリも使う ([api.md](api.md#録画のチャプター-get-apirecordingsidchapters)) |
| `/api/recordings/<id>/playback` | 録画を何で観られるか (尺・時刻の物差し・音声・出せるもの)。どれを使うかは観る画面が決める ([api.md](api.md#録画の観方-get-apirecordingsidplayback)) |
| `/api/recordings/<id>/stream?codec=&from=<秒>` | 録画をその場で流す。H.264 / AV1 は fMP4 (同じコーデックのエンコード済みは詰め替え、違えば変換。変換は本数の枠を使い、埋まっていれば 503)、MPEG-2 は元の TS を飛び先から |
| `/rules` | **ルールの一覧と管理** (`#lib/server/rule-list.ts`)。作る・直すのは検索の画面の「ルールとして保存」(行はリンクで `/search?rule=<ID>`)。2段の淡い塊の並び (ホームの行と同じ `--dp-row`、6px 空ける) で、1段目は名前とスイッチ・削除、2段目は条件 (`#lib/rule-summary.ts`。探す所・局・ジャンル・同じ回は1度・除外)・次の放送 (いちばん近い予約。今日・明日は言葉で)・予約 (これから録るもの)・録画 (このルールの予約で録れたもの。失敗・削除は数えない)・最後に録れた日。リンクの外に有効/無効のスイッチ (`?/toggle`。送っている間は押せない。断られたら戻す) と削除 (`?/delete`。2回押し)。どちらも `rule-actions.ts` (検索の画面と同じもの)。絞り込み (すべて・有効・無効・次の放送なし・競合あり。件数つき。絞り込み・並び・数の行と表の見出しは巻いても上に残る) と並び (次の放送が近い順・新しい順・名前順・予約が多い順・最近録れた順) はその場かぎり。集計はこれから7日の予約とこの7日で録れた本数。60 行ずつ描き足す (`Paged`)。絞り込み・並び・集計は 1000px から右のサイドバー (ホームと同じ `.s-group`・`.s-item`)、それより狭いと細い帯で、下のタブがある幅 (640px 未満) では画面の下、タブのすぐ上に貼り付ける。**優先度は予約どうしを比べる数** (0〜9。チューナーが足りないとき大きいほうを残す。設定の「チューナー」の「詳しく」に出る、チューナーを譲り合う順とは別の物差し)。**前の URL は検索の画面へ送る**: `?edit=<ID>` → `/search?rule=<ID>`、`?program=` / `?recording=` → `/search?from=program:<ID>` など (シリーズ名を言葉にして出直す。ホームの詳細の「ルールを作る」とルール名のリンクはこの経路)、`?keyword=` など書く欄の値 → `/search?q=<キーワード>&…`、`?new` → `/search`。録画・番組から作る下書きはシリーズ名をキーワード・同じ回は1度 (`rules.prefillFrom`。期・シーズンの表記は入れない `title.withoutSeason`)。このシリーズ名に当たるルールが既にあれば、検索の画面でそのルールへの入口を出す (`rules.coveringRule`) |
| `/search` | **サイト全体の検索** (`?q=`。GET なので URL をそのまま渡せる。`#lib/server/search.ts`)。節は「これからの放送」(番組名・概要。終わっていない番組。行から予約・取消。右の書く欄の条件で録るかを行ごとに出す)・「録画」(番組名・シリーズ・副題・局名。消したものは出さない。押せば観る画面・録画中は追っかけ再生、削除は2回押し)・「予約」(これから録るものと録画中。取消)・「ルール」(名前・キーワード。押せば `?rule=`)。どの節も件数と先頭5件 (「もっと見る」で受け取った 100 件まで)。見出しは `h2`。欄は `SearchField` 1つ (`role="search"`)。広い画面はヘッダーの真ん中 (「印と名前 ｜ 欄 ｜ ナビ」の3列。欄は 36rem まで広がり、中くらいの幅では先に縮む)、狭い画面 (ヘッダーを隠す) は検索の画面の上の帯に同じものを置く。結果の画面に別の欄は無く、ヘッダー (帯) の欄に探した言葉が入ったまま直して送れる。`/` か Ctrl/⌘+K で見えている欄に入る (入力欄・テキストエリア・選ぶ欄・編集できる所では取らない。見えている欄が無ければ `/search` を開く)。狭い画面の入口は下のタブの「検索」(下のタブは 録画 / 番組表 / ライブ / 検索 / その他。ルールと設定は「その他」の中)。言葉なしで開くと欄に入り、その端末の最近の検索を出す (`#lib/recent-searches.ts`。打ちかけを覚えないよう、言葉が 1.5 秒変わらなかったら覚える)。**打つそばから応える**: 結果の画面の外ではヘッダーの欄に打つと 180ms 待って `/api/search` (節ごとに数件) に聞き、欄の下に候補を出す (combobox と listbox。↑/↓ で選び Enter で開く、何も選んでいなければ Enter で結果の画面、Esc で閉じる。言葉が変わったら送りかけの問い合わせは止める)。結果の画面 (狭い画面の上の帯も) では候補を出さず、打つそばから結果の画面を出し直す (履歴は置き換える)。`?program=<番組ID>` で開くとその番組の詳細を出す (候補から番組・予約を選んだとき。閉じると URL から外す)。**右の「ルールとして保存」** (`RuleDraft.svelte`。1024px からは右の列でヘッダーの下に貼り付け、狭い画面は下の「ルールとして保存」で下から出す): キーワード (探した言葉から始まり、手で直すまで付いていく)・探す所・除外する言葉・局・同じ回は最初の放送だけ・優先度・ジャンル (畳んだ行)。条件を変えるたびに 300ms 待って `?/preview` に書く欄と結果の番組 ID (`ids`) を送り、行ごとの「録る / 録らない (理由) / 予約済み」を返してもらう (`rule-preview.previewFor` の `verdicts`。送っている間に変わったぶんは返ってから1回、同じ条件なら送らない)。立っている予約は行に先に出す。保存は `?/createRule` (保存したルールへのリンクを出す)。`?rule=<ID>` で開くとそのルールを書く欄に読み込み、「更新」(`?/updateRule`)・「無効化」(`?/toggleRule`)・「削除」(`?/deleteRule`。2回押し。消したら `?rule=` を外して出直す)。無い ID は `?rule=` を外して出直す。言葉なしで開いたら結果の代わりにそのルールの下見の行を出す。結果の画面で打ち直しても `?rule=` は付けたまま (`SearchField`)。`?from=program:<番組ID>` / `?from=recording:<録画ID>` (詳細の「ルールを作る」) はシリーズ名を言葉にして出直し (`rule-form.originOf`)、既にそのシリーズを録っているルールがあればそちらへの入口を出す。`?keyword=` など書く欄の名前が付いていれば、その値で書く欄を始める |
| `/settings` | 設定。**左にグループとその節の一覧、右にグループの画面** (一覧と詳細の形。`settings/+layout.svelte`)。グループごとに1つの画面 (`/settings/<グループ>`) で、節は上から積み、`#<節>` で飛ぶ (一覧の節を押すと滑らかに巻く)。見えている節を `IntersectionObserver` で追って一覧で塗る (ヘッダーの下から画面の 45% の帯にかかっている節のうちいちばん上。下まで巻いたら最後の節)。並びは `#lib/settings-sections.ts` が持つ (録画 / 受信 / 連携 / その他)。広い画面 (768px 以上) で `/settings` を開くと先頭のグループ (`/settings/recording`) へ移る (`+page.ts`。幅はブラウザで見る)。狭い画面の `/settings` はグループの一覧だけで、押すとその画面と、上に「← 設定」と節へ飛ぶ行 (巻いても残る)。読み込みと actions は節ごとのファイル (`reception/tuners.server.ts` など) が持ち、グループの `+page.server.ts` がまとめる (返す値と action の名前は節どうしで重ならない)。押した結果のトーストは画面で1か所、通知 (SSE) も画面で1本。その場で保存する節はフォームごとに `autosave`。説明は要点1行で、残りは「詳しく」に畳む |
| `/settings/general` | その他。**この端末** (`#browser`。サーバに送らず端末に覚える): 画面の高さを見る (PWA にはアドレスバーが無く `?measure` を打てないので、入口をここに置く)。**ほかで切り替えられるものは置かない** — テーマはヘッダーのボタンとスマホの「その他」(`#lib/theme.svelte.ts`)、互換モードは再生画面の ⚙ ([stream.md](stream.md#互換モード--エンコードしたもの-h264--av1-も-canvas-に描く))。この端末で描けない形式は ⚙ のコーデックで押せなくなる (`canvasChoices`) ので、使えるものの一覧も出さない。**ログイン** (`#login`): ログインの控えで入っているときだけ、ログアウト (`POST /logout`) と「ほかの端末からもログアウト」(2回押し。この控えのほかを誰のものでも消し、消した数を出す。`session.destroyOthers`。テレビのアプリのアクセストークンは消さない)。ほかに生きているログインの数も出す。素通しでは「ログインせずに使っています」の1行だけ。ヘッダーとスマホの「その他」にはログアウトを置かない。**バージョン** (`#version`): 動いている版 (`DENPA_VERSION`。`dev` は開発版) だけ。新しい版のリンクはヘッダーとスマホの「その他」にだけ出す (`server/update.ts`) |
| `/settings/recording` | 録画。節ごとにフォームと action が分かれる。**エンコード** (`#encoding`。映像コーデック — AV1・H.264 を複数選べる。両方選ぶと1本を2ファイルでエンコードする。どちらも外すと「エンコードしない」。コーデックごとに横の欄でエンコーダ (ソフトウェア・GPU・GPU を順番に使う) を選ぶ。欄はそのコーデックを GPU でエンコードできるときだけ出る。その下に GPU を探した結果の1行と「確かめ直す」、デバイスごとの QSV / VA-API の可否は「詳しく」の中/同時に変換する本数 (録画をその場で変換するのと追っかけ再生の上限。自動では GPU が無ければ 2、あれば 4)/元のTSを残すか/コマ数を映像から決めるか)、**CM** (`#cm`。CMの扱い)、**自動予約** (`#reserve`。無料放送だけか) |
| `/settings/reception` | 受信。**チューナー** (`#tuners`): 1台1行の表。名前とデバイス、受信できる種別 (GR/BS/CS の切り替え)、状態 (空き・使用中とチャンネル・無効) と使っている相手、「使う」のスイッチ、「⋯」で名前・デバイス・LNB・削除。どれも変えたらその場で保存し、「追加」と「自動検出に戻す」は表の下 (書かなければ自動検出)。電波の強さはエージェントが返さないので出さない。その下にカードリーダー (リーダーごとの表: カードの番号・使用中/予備・そのカードでデコードしているチューナー)。チューナーを使っている相手は用途で出す (「録画: 番組名」「番組表 (T16)」「局ロゴ収集 (T16)」)。取り合いの優先度 (`config.priority`) の数字は出さず、譲り合う順を用途の並びで「詳しく」に出す (`yieldOrder`。ルールの優先度と同じ数字の物差しに見えないように)。チューナーの表とカードリーダーは、エージェントの答えが届くまで本物と同じ形の骨組みを出す。**チャンネル** (`#channels`): 受信できるチャンネル (チャンネル → 局 → 番組表のある局の数、「局ロゴ n / m 局」「CMロゴ n / m 局」)。表は1行に1局 (種別と ch は局の数だけ縦につなぐ) で、局ごとの番組表の集まり具合と、局ロゴ (取れていない局は点線の枠、放送に載っていない局は「—」)・CM検出用に覚えたロゴ (覚えていなければ空) の列。ロゴを押すと大きく見る窓 (`LogoZoom`) が開き、「覚え直す」はその中だけ。狭い幅ではロゴの列をたたんで局名の前に出す。見出しの行にチャンネルスキャン (種別を選ぶ欄と「スキャン」。回っている間は「中断」。録画中でも実行できる)・「番組表をいますぐ集める」・「ロゴをいますぐ集める」(地上波も衛星もチューナー2つ)、進み具合は見出しのすぐ下。チャンネルが1つも無ければ表の場所の真ん中にスキャンの欄を出す (局が無いときの案内 `ChannelNotice` の行き先)。前の「ロゴ」の節 (`#logos`・`/settings/logos`) はここへ送る。**データ放送** (`#broadcast`): 郵便番号・都道府県・双方向のオン/オフ |
| `/settings/integrations` | 連携。**通知** (`#notifications`。通知先の Webhook)、**テレビのアプリ** (`#tv`。ペアリングした端末の一覧と取り消し)、**EPGStation からの引き継ぎ** (`#migrate`) |
| `/settings/<前の節>` | 前の節ごとの画面 (`tuners` `channels` `logos` `broadcast` `browser` `notifications` `tv` `migrate`)。グループの画面のその節 (`/settings/reception#tuners` など) へ 308 で送る (`settings/[moved]/+server.ts`。行き先の表は `MOVED_SECTIONS`) |
| `/tuners` | 前のチューナーの画面。`/settings/reception#tuners` へ 308 で送る |
| `/api/recordings/<id>/file` | 録画ファイル。Range 対応。**エンコード済みがあればそちら、無ければ元のTS。再エンコードしている間は元のTS** (始める前に前のものを消すので、その間は保存先に何も無い)。`?source=ts` / `?source=encoded` / `?source=alt` (H.264) で名指しもできる (アプリと端末に保存が使う)。再生のためのエンドポイントで、添付 (`Content-Disposition: attachment`) にはしない ([library.md](library.md)) |
| `/api/recordings/<id>/poster` | エンコードしたときに動画の隣へ置いた `-poster.jpg` を返す (一覧のサムネイル用)。ffmpeg を起こさず読んで返すだけ。無ければ 404 |
| `/login` / `/login/callback` / `/logout` | OIDC でのログインとログアウト。`/login` と `/login/callback` は設定していなければ 404。`/logout` はいつでも控えを消して `/login/out` へ ([auth.md](auth.md)) |
| `/device` | テレビのアプリの QR で開く画面。開くと自分でフォームを送って (POST) ペアリングを済ませ、端末の名前を出す ([auth.md](auth.md#アプリのペアリング)) |
| `/api/services/<id>/logo-data` | CM検出のためにいま覚えているロゴ (線の向きの揃い方の白黒PNG)。番組表に出すロゴとは別物で、画像になっているかを確かめるためのもの |
| 画面の高さの採り方 | **単位で言い当てない。** `app.css` が `html, body` に高さを与え、土台も番組詳細の窓もそこから `%` で降りる。`100vh` も `100dvh` も実機の PWA (Android Chrome) で画面より 56px 大きく出た。56px は Chrome for Android のアドレスバーの高さそのもの。`%` なら JS も測り直しも要らず、描く前から正しい。`%` が届かないのは番組表の表だけ (畳まれる幅では途中の入れ物に高さが決まらない) で、そこは3つの単位のうち見えている範囲を超えない `svh` を使う |
| `?measure` (どの画面でも) | **その端末の高さを測るパネル** (`components/Measure.svelte`)。窓・枠・中身の高さと、`dvh`/`svh`/`lvh`/`vh` の実測、はみ出している要素を出す。縦のはみ出しは端末でしか起きないことがあり (引っ込むアドレスバー、切り欠き)、自動運転のブラウザでは作れない。PWA にはアドレスバーが無いので、設定画面にもオン/オフがある (そちらは覚える。端末ごとで、サーバには置かない) |
| 長い一覧 (どの画面でも) | **少しずつ出す** (`paging.svelte.ts`)。予約・録画・ルールは最初に 1 画面と少しだけ描き、下端に近づいたら足す。数百行を一度に描くと開いた直後に一瞬止まって見えた。全部は描かないので Ctrl+F では探せず、予約と録画の一覧には絞り込みの欄を置く (打った端から手元の行に当たる)。ルールはサイト全体の検索 (`/search`) で探す。番組表のマスも同じ理由で数百個ずつ描く (描いている間は `guide-grid` に `aria-busy`)。遷移が 150ms を超えたら上端に細いバーを出す (`nav-progress`)。押してから次の画面が届くまで何も変わらないと「止まった」に見えていた |
| ヘッダー (どの画面でも) | **新しい版が出ていればお知らせを出す** (`v1.8.0 が公開されています`。押せば GitHub のリリース)。サーバが 1 時間に 1 度、動いている版 (`DENPA_VERSION`。リリースのイメージにだけ入っている) と GitHub の最新のリリースを数で比べる (`server/update.ts`)。develop のイメージは版を持たないので出さない (main を追う限りリリースより常に先)。リリースを消せば、最新が消したあとの版になるので引っ込む。閉じるボタンは置いていない (上げるか、消えるまで出ている) |
| `/api/services`・`/api/recordings`・`/api/services/<id>/live` ほか | 画面の外のもの (テレビのアプリ・Home Assistant・スクリプト) 向けの API (追っかけ・字幕・番組の中身・続き・変化の通知・ペアリングも)。形式と使い方は [api.md](api.md) |
| `/manifest.webmanifest` | PWA のマニフェスト。来た名前で表示名が変わるので静的ファイルではない。認証を掛けていないエンドポイントの1つ (ブラウザが資格情報を付けずに取りに来るため。他は `/login*`・`/logout`・`/api/health`・`/api/device/code`・`/api/device/token`。`auth.ts` の `OPEN_PATHS`) |

## チューナーエージェント (`agent/`)

機材に触る側。中身は読まず、選局したチャンネルの TS をそのまま流す。
**`src/lib/ts` に依存していない。** TS を1バイトも解釈しないため。
.NET の Native AOT で実行ファイル1個。
なぜこの切り分けなのかは [agent.md](agent.md)。

| ファイル | 役割 |
| --- | --- |
| `agent/Denpa.Agent/Program.cs` | HTTP API (Kestrel)。選局・チャンネルの控え・カード・解除・通知 |
| `agent/Denpa.Agent/TunerPool.cs` | 優先度つきの取り合いと、使っているデバイスの面倒 |
| `agent/Denpa.Agent/Tuning.cs` | 選局そのもの (DVB)。使ったまま変えられる |
| `agent/Denpa.Agent/Px4.cs` | px4-userland の機材 (PX-Q3U4 / PX-MLT 系 …) を扱う。筐体と受信機は `px4d --list-json` (px4-userland 0.1.9 以上) に聞き、受信機は px4d の制御ソケットで取ったまま選局し直す |
| `agent/Denpa.Agent/Siano.cs` | siano-userland の機材 (PX-S1UD …) を扱う。機材は `siano-ts --list` に聞き、カーネルが使っていないものだけを `--control` で起こしたまま選局し直す |
| `agent/Denpa.Agent/Asicen.cs` | asicen-userland の機材 (PX-W3U3。試験的) を扱う。機材は sysfs で見つけてUSB ポートで名前を付け、asicend を起こし、受信機とカードは px4d と同じ IPC (`Px4Wire.Asicen`) で話す。配布物が無ければ何もしない |
| `agent/Denpa.Agent/Px4Control.cs` | px4d の制御ソケット (SPEC 6 節の portable IPC)。受信機 (`Px4.cs`) とカード (`Px4Card.cs`) が使う。asicend とも同じやり方で話す (違いは `Px4Wire`) |
| `agent/Denpa.Agent/ChildTs.cs` | 子プロセス (siano-ts) の標準出力を読み取り用のストリームにする。pipe の広げ方・閉じ方 |
| `agent/Denpa.Agent/ChannelTable.cs` | チャンネル名 → 周波数と TSID |
| `agent/Denpa.Agent/Cas.cs` | B-CAS まわりの境目 (復号する・鍵を貰う・カードと話す、の3段の型) |
| `agent/Denpa.Agent/B25.cs` / `Multi2.cs` | B25 の解除 (TS から ECM を拾い、鍵を貰って MULTI2 で復号する) |
| `agent/Denpa.Agent/BCas.cs` / `CardLinks.cs` | B-CAS へのコマンドと、カードリーダーを探して繋ぎ直す |
| `agent/Denpa.Agent/Ccid.cs` / `T1.cs` / `UsbFs.cs` | USB の CCID カードリーダーを usbfs で直に扱う (pcscd を使わない) |
| `agent/Denpa.Agent/Pcsc.cs` | macOS と Windows の USB カードリーダー (OS の PC/SC 越し。PCSC.framework / winscard.dll) |
| `agent/Denpa.Agent/Px4Card.cs` | px4-userland の内蔵カードリーダーに px4d の control socket で APDU を投げる |
| `agent/Denpa.Agent/CardShare.cs` | 鍵をどこから貰うか (手元のカード / 別の拠点) と、拠点のあいだのやり取りの形式 |
| `agent/Denpa.Agent/CardShareServer.cs` | 鍵を他の拠点へ配る API (専用のポート `CARD_SHARE_PORT`) |
| `agent/Denpa.Agent/CardLan.cs` | 鍵を配る・貰うのは LAN の中だけ (相手のアドレス・TTL・往復時間) |
| `agent/Denpa.Agent/Card.cs` | カードが読めているかと、掛かったまま録れた TS の後からの解除 |
| `agent/Denpa.Agent/DeviceProbe.cs` | チューナーの自動検出 (DVB は ioctl で受けられる方式を聞き、px4 / siano は `--list` に聞き、asicen は sysfs を読む) |
| `agent/Denpa.Agent/Config.cs` | `tuners.json` と `channels.json` の読み書き |
| `agent/Denpa.Agent/Events.cs` | 通知 (`/denpa/events`、SSE) |
| `agent/Denpa.Agent/Probe.cs` | 実機で選局と復号だけ試すコマンド (`denpa-agent --tune …`)。サーバは立てない |
| `agent/Denpa.Agent/Interop.cs` | 子プロセスへの SIGTERM (偽の選局 `FAKE_TUNE` はプロセスグループごと) |

**チューナーは書かなくてよい。** 定義が無ければ刺さっているものを自分で見つけ、
地上波か衛星かまで判別する。書いてあればそちらが勝つ (LNB・1台だけ止める、は
人にしか決められない)。聞き方は [agent.md](agent.md#選局コマンドは画面から渡させない)。

環境変数は `AGENT_PORT` (既定 `25252`)・`TUNERS_FILE` / `CHANNELS_FILE` (既定 `/config/` の下)・
`MEDIA_DIR` / `RAW_DIR` (denpa と同じ。元のTSの置き場)・`CARD_URL` (手元にカードが無い拠点だけ。鍵を貰う先。配る側の `CARD_SHARE_PORT` を指す)・
`CARD_SHARE_PORT` (鍵を配る拠点だけ。既定は配らない。例は `25253`)・`CARD_SHARE_NETWORKS` (鍵を配る相手。既定はループバックと LAN の中のアドレスで、書けるのもその中だけ)・
`CARD_TTL` (鍵のやり取りの TTL。既定 `1`、1〜8)・`CARD_SHARE_MAX_RTT` (往復時間の上限。既定は見ない)・
`SHUTDOWN_WAIT` (denpa と同じ)。同梱のドライバの置き場 `PX4_USERLAND_DIR` / `PX4_FIRMWARE` / `PX4_RUNTIME_DIR` /
`SIANO_USERLAND_DIR` / `SIANO_FIRMWARE` / `ASICEN_USERLAND_DIR` / `ASICEN_FIRMWARE` / `ASICEN_RUNTIME_DIR` はイメージの既定のままでよい (書き換えるのは Mac の `install.sh` (`PX4_*`・`SIANO_*`) と Windows の `install.ps1` (`PX4_*`・`SIANO_*`。Windows の `PX4_RUNTIME_DIR` は `C:\denpa-run`) だけ)。
`FAKE_TUNE` は適合テストだけが使う。

**鍵を配るのは LAN の中だけ** (鍵を使えるのは同じ世帯の機器だけ。LAN の中に限るのはその近似)。鍵を配る API は普通の API とは
別のポート (`CARD_SHARE_PORT`) にあり、ループバックと LAN の中のアドレス以外には 403 で断り、TTL 1 で
ルーターを越えない。設定で狭めることはできても LAN の外へは広げられず、`CARD_SHARE_NETWORKS` に LAN の外の範囲を書いたり
`CARD_TTL` を 9 以上にしたりすると起動しない。限界 (VPN・Docker のブリッジ・Kubernetes・プロキシ) と前の版からの移り方は [agent.md](agent.md#鍵を配るのは-lan-の中だけ) に。

## テスト

| 場所 | 何 |
| --- | --- |
| `tests/e2e/` | Playwright。予約・録画・ルール・引き継ぎ・放送の延長から、ライブ・観る画面・API・データ放送まで。ファイル単位で並ぶので、長いものは割ってある |
| `tests/stack.ts` | ワーカーごとに denpa と偽エージェントを1式立てる (これでファイル単位に並べられる) |
| `tests/fake/` | 偽エージェント・偽の選局 (`tune.ts`。本物のエージェントの `FAKE_TUNE` に渡す)・偽の通知先・偽ffmpeg。電波は `broadcast.ts` が組み立てる (EIT も SDT も NIT も。同じものを偽エージェントと偽の選局の両方が流す)。README の画像を撮るときは `docs.ts` の作り物の局・番組・ロゴに替わる (`FAKE_PROFILE=docs`) |
| `src/**/*.test.ts` | 純粋関数の境界条件 (bun test) |
| `agent/Denpa.Agent.Tests/` | エージェント側 (設定の読み書き、選局表、読み取り、px4-userland / siano-userland の答えの読み方と引数) |
| `agent/conformance.test.ts` | 本物のエージェントを起こして HTTP API に当てる (`bun run test:conformance`)。チューナーの代わりは偽の選局 (`FAKE_TUNE`)、起こすエージェントは `AGENT_CMD` で差し替えられる |

回し方と方針は [development.md](development.md) に置いてある。
