# 借りているもの (ライセンス)

denpa 自身は **AGPL-3.0-or-later** ([LICENSE](../LICENSE)) です。ここには、**コンテナ
イメージに同梱して配っているもの・リポジトリに写してあるもの・ブラウザへ配る束に
入るもの**を、出どころとライセンスごとに並べます。README の「ライセンス」はこの要約です。

書き方の約束: 「根拠」はリポジトリの中で確かめられるもの (LICENSE ファイル・
Dockerfile の行・`package.json`) を優先し、上流の表示に拠るものは (上流) と添えます。
**版はここに書きません。** Renovate が Dockerfile の `ARG` / `ENV` を上げるたびに食い違うので、
いま入っている版は Dockerfile を見てください。

## コンテナイメージ `denpa` に入るもの

[Dockerfile](../Dockerfile) の `runtime` 段。土台は Debian 13 (trixie) slim。

### 自前ビルドの ffmpeg と、そこに繋がるもの

`--enable-gpl` で x264 を繋いでいるので、**出来上がる ffmpeg / ffprobe は GPL-2.0-or-later**
になります。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| FFmpeg | エンコード・字幕・サムネイル・ライブ | <https://ffmpeg.org> | LGPL-2.1+ (`--enable-gpl` で GPL-2.0+) |
| x264 | H.264 のエンコード | <https://www.videolan.org/developers/x264.html> | GPL-2.0+ |
| SVT-AV1 (ソースから静的リンク) | AV1 のエンコード | <https://gitlab.com/AOMediaCodec/SVT-AV1> | BSD-3-Clause-Clear + AOM 特許ライセンス |
| dav1d | AV1 のデコード | <https://code.videolan.org/videolan/dav1d> | BSD-2-Clause |
| Opus (libopus) | 音声 | <https://opus-codec.org> | BSD-3-Clause |
| libaribcaption (ソースから) | ARIB 字幕を絵にする | <https://github.com/xqq/libaribcaption> | MIT |
| FreeType / fontconfig | 字幕の描画とフォント解決 | <https://freetype.org> / <https://fontconfig.org> | FTL (or GPL-2.0) / MIT 系 |
| libva / libva-drm | VA-API (GPU で焼く) | <https://github.com/intel/libva> | MIT |
| libvpl / libmfx-gen | Intel QSV (GPU で焼く) | <https://github.com/intel/libvpl> / <https://github.com/intel/vpl-gpu-rt> | MIT |
| intel-media-va-driver (iHD) | Intel の VA-API ドライバ | <https://github.com/intel/media-driver> | MIT (一部 BSD) |
| zlib | ffmpeg の依存 | <https://zlib.net> | zlib |
| [patches/](../patches) | ffmpeg と libaribcaption に当てている直し (字幕の「消せ」・外字の描き方など。denpa が書いたもの。上流に投げる前提) | — | 当てる先と同じ (ffmpeg は LGPL/GPL、libaribcaption は MIT) |

### フォント

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| rounded-mplus-1m-arib | 字幕の焼き込みと、データ放送の web フォント (`/api/font` で配る) | <https://github.com/5ym/arib-font> (自家製 Rounded M+ 1m と和田研中丸ゴシック 2004ARIB の派生) | M+ FONT LICENSE (上流の LICENSE: 使用・複製・配布・改変を商用非商用問わず無制限に許可) |

### ランタイム

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| Bun (実行バイナリだけ `oven/bun` から写す) | denpa 本体を動かす | <https://github.com/oven-sh/bun> | MIT (中の JavaScriptCore は LGPL-2.1) |
| ca-certificates / tzdata / fontconfig | 証明書・時刻・フォント | Debian | MPL-2.0 / パブリックドメイン / MIT 系 |

## コンテナイメージ `denpa-agent` に入るもの

[agent/Dockerfile](../agent/Dockerfile)。.NET の Native AOT で 1 本のバイナリにしてあり、
**NuGet の依存は 0** (JSON はランタイムの `System.Text.Json`)。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| .NET 10 ランタイム (AOT でバイナリに埋まる) | エージェント本体 | <https://github.com/dotnet/runtime> | MIT |
| px4-userland (`/opt/px4-userland`) | PLEX PX-Q3U4 / PX-W3U4 / PX-MLT 系、e-Better / Digibest 系のユーザー空間ドライバ。`px4d` / `px4ctl` (配布物に入っている `px4-ts` と pcscd 用 IFD ハンドラは使わない) | <https://github.com/Khronos31/px4-userland> | **GPL-2.0-only** (実行ファイルに静的リンクの libusb 1.0.30 は LGPL-2.1+。配布物の `THIRD_PARTY_NOTICES.md` を同梱のまま置いてある) |
| IT930x ファームウェア (`/opt/px4-userland/firmware/it930x-firmware.bin`、2,169 バイト) | 挿すたびに流し込む (px4-userland の対応機種で共通) | PLEX 公式の Windows ドライバ (`pxw3u4_BDA_ver1x64.zip` の `PXW3U4.sys`、著作権表示は Digital Warrior Corp.) から焼くときに切り出す (agent/Dockerfile) | **ライセンス無し** (再配布の許諾は誰も持っていない。権利者が動いていない実態に乗る判断。[agent.md](agent.md#px-q3u4-などは-px4-userland-でカーネルドライバは入れてもらわない)) |
| siano-userland (`/opt/siano-userland`) | PLEX PX-S1UD など Siano RIO 系のユーザー空間ドライバ。`siano-ts` | <https://github.com/Khronos31/siano-userland> | **GPL-2.0-or-later** (実行ファイルに静的リンクの libusb 1.0.30 は LGPL-2.1+。配布物の `COPYING`・`libusb/COPYING`・`DEPENDENCY-NOTICE.txt` を同梱のまま置いてある) |
| Siano ISDB-T ファームウェア (`/opt/siano-userland/firmware/isdbt_rio.inp`、85,840 バイト) | siano-ts が USB で流し込む | siano-userland の配布アーカイブに入っているもの (Siano Mobile Silicon) | **Siano の再配布許諾** (無改変なら再配布可。解析は禁止。許諾の文面 `LICENCE.siano` を同じ場所に置いてある) |
| procps / curl / zlib / ca-certificates / tzdata | 道具 | Debian | GPL-2.0+ / curl / zlib / MPL-2.0 / PD |

### Mac に入れるもの (`install.sh`)

リリースに添えた `denpa-agent-<版>-darwin-arm64.tar.gz` (上と同じ .NET の Native AOT のバイナリ1個) と、
上と同じ px4-userland / siano-userland の **Mac 版** (`darwin-arm64`)・同じファームウェア。
libusb 1.0.30 (LGPL-2.1+) が実行ファイルに静的リンクなのも上と同じで、
配布物の `DEPENDENCY-NOTICE.txt` / `THIRD_PARTY_NOTICES.md` もそのまま置きます。
USB のカードリーダーは macOS の PCSC.framework (OS の一部) を呼びます。
denpa 本体は上と同じコンテナイメージ `denpa` を、Mac の Docker で動かします。

### Windows に入れるもの (`install.ps1`)

リリースに添えた `denpa-agent-<版>-windows-x64.zip` (`denpa-agent.exe` 1個) と、siano-userland の
**Windows 版** (`windows-x64`)・同じファームウェア。px4-userland は入れません (Windows 版が無い)。
カードリーダーは Windows の WinSCard (`winscard.dll`。OS の一部) を呼びます。

### `denpa-aio`

上の `denpa` に、`denpa-agent` の実行ファイルと `/opt/px4-userland`・`/opt/siano-userland` を
写しただけのもの (`.github/aio.Dockerfile`)。中身もライセンスも上の2つと同じです。

## リポジトリに写してあるもの・借りた表

| 名前 | 場所 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- | --- |
| BS / CS の標準の局の表 | [src/lib/server/channel-seed.json](../src/lib/server/channel-seed.json) | BS・CS の局が無いときに入れる BS 26 + CS 12 TS (`channel-seed.ts`) | Khronos31/hassio-addons の denpa アドオンの `seed/channels.bs.json` | MIT |
| ARIB ロゴの CLUT (129 色) | [src/lib/ts/logo-palette.ts](../src/lib/ts/logo-palette.ts) | 局ロゴの PNG 化 | node-aribts / @chinachu/aribts の `logo_clut.js` と同じ並び | MIT (上流) |
| ARIB 外字表 | [src/lib/ts/aribtext-gaiji.ts](../src/lib/ts/aribtext-gaiji.ts) | 番組名の「[新]」「[字]」など | epgdump_py (Yasumasa Murakami, 2011) → ariblib に引き継がれた表 | MIT (ariblib。上流) |
| 選局表の値と選局手順 | [agent/Denpa.Agent/ChannelTable.cs](../agent/Denpa.Agent/ChannelTable.cs) / `Tuning.cs` | チャンネル名 → 周波数、DVB の手順 | recisdb-rs の `dvbv5_channels_isdbs.conf` / `dvbv5.rs` を参照 (コードは写していない) | GPL-3.0 (上流) |
| エンコード再試行の秒数 (0.2) | [src/lib/server/config.ts](../src/lib/server/config.ts) | 値だけ | EPGStation の `enc.js` | MIT (上流) |
| アイコン類 | [static/](../static) | PWA のアイコン | 自作 | AGPL (denpa と同じ) |

## ブラウザへ配る束・サーバの束に入る主なもの

`package.json` に runtime の `dependencies` は無く、adapter-node が全部を `build/` に
畳み込みます (イメージにもそれだけを載せる)。**MIT がほとんどで、例外は Apache-2.0 の
2 つ** (`drizzle-orm` と `crc-32`) **と、ISC の Lucide** (アイコンの形)。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| Svelte / SvelteKit / adapter-node | 画面・ルーティング・サーバの束 | <https://github.com/sveltejs> | MIT |
| Blades (Pico CSS を引き継いだもの) / Bits UI | 見た目の土台と、メニューなどの部品 | <https://blades.ninja> / <https://bits-ui.com> | MIT |
| Floating UI / runed / svelte-toolbelt / tabbable / style-to-object | Bits UI の依存 (浮かせる枠・フォーカス) | 各上流 | MIT |
| drizzle-orm | SQLite の読み書き (サーバの束) | <https://github.com/drizzle-team/drizzle-orm> | **Apache-2.0** |
| web-bml (+ 同梱の es2) | **データ放送 (BML) を描く。** 2026-08 に上流がライブラリ化して npm に出したので、写しをやめて普通の依存にした | <https://github.com/otya128/web-bml> / <https://github.com/otya128/es2> | MIT / MIT |
| crc-32 | web-bml の PNG / DRCS | <https://github.com/SheetJS/js-crc32> | **Apache-2.0** |
| css (reworkcss、otya128 の fork。依存なし) | web-bml が BML の CSS を解く | <https://github.com/otya128/reworkcss-css> | MIT |
| fast-xml-parser (+ strnum) | web-bml の BML → XHTML | <https://github.com/NaturalIntelligence/fast-xml-parser> | MIT |
| arib-mmt-tlv-ts / fflate | web-bml の依存 | npm の各上流 | MIT |
| Lucide (`@iconify-json/lucide` から、使ったアイコンの `<svg>` だけ) | 画面のアイコン ([player.md](player.md#アイコンは-lucide-を組むときに埋め込みます)) | <https://lucide.dev> | **ISC** |
| unplugin-icons / @iconify/utils (組むときだけ。束には入らない) | `~icons/*` を Svelte の部品に変える | <https://github.com/unplugin/unplugin-icons> / <https://github.com/iconify/iconify> | MIT |
| cookie / devalue / esm-env / clsx | SvelteKit のランタイム (adapter-node 6 は静的ファイルの配りも自前で、依存を持たない) | 各上流 | MIT |

### ライブを生で見るときにブラウザへ配る復号器

[Dockerfile](../Dockerfile) の `mpeg2wasm` 段で組み、イメージの `/opt/denpa/mpeg2` に置いて
`/api/live/mpeg2/` から配る WebAssembly ([stream.md](stream.md#55-放送そのままmpeg-2を送る))。
**`--enable-gpl` を付けずに組んでいる**ので、中の FFmpeg は LGPL のまま (denpa 自身は AGPL で、
どちらでも問題は無い)。ソースは Dockerfile が取ってくる FFmpeg の tarball と `wasm/mpeg2/decoder.c`。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| FFmpeg (libavcodec の mpeg2video・aac 復号器と mpegvideo parser、libavutil だけ) | 放送の MPEG-2 と AAC をブラウザで解く | <https://ffmpeg.org> | LGPL-2.1+ |
| emscripten の読み込み口 (`decoder.mjs` に埋まる実行時の糊) | WASM を worker に読み込む | <https://github.com/emscripten-core/emscripten> | MIT / University of Illinois/NCSA |

## 使っていないもの (書いておく価値のあるもの)

- **JS-Interpreter (Google, Apache-2.0)** — web-bml の上流はかつてこれで BML の
  スクリプトを動かしていました。いまは向こうも es2 に置き換えていて、2026-08 に
  ファイルごと消えています
- **@chinachu/aribts / aribb24.js / mpegts.js / hls.js / shaka-player** — 検討したうえで
  自前実装にしたもの ([stream.md](stream.md))
- **@iconify/svelte / lucide-svelte** — アイコンは組むときに埋め込む unplugin-icons にした
  ([player.md](player.md#アイコンは-lucide-を組むときに埋め込みます))。`@iconify/svelte` は既定で
  Iconify の API から形を取りに行き、LAN だけ・オフラインで開けない
- **OIDC のライブラリ** — 入れていません ([auth.md](auth.md))
- **recisdb** — 選局は自前で ioctl を叩きます。値の出どころとして上に書いてあります
