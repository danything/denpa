# 借りているもの (ライセンス)

denpa 自身は **AGPL-3.0-or-later** ([LICENSE](../LICENSE)) です。ここには、**コンテナ
イメージに同梱して配っているもの・リポジトリに写してあるもの・ブラウザへ配る束に
入るもの**を、出どころとライセンスごとに並べます。README の「ライセンス」はこの要約です。

書き方の約束: 「根拠」はリポジトリの中で確かめられるもの (LICENSE ファイル・
Dockerfile の行・`package.json`) を優先し、上流の表示に拠るものは (上流) と添えます。

## コンテナイメージ `denpa` に入るもの

[Dockerfile](../Dockerfile) の `runtime` 段。土台は Debian 13 (trixie) slim。

### 自前ビルドの ffmpeg と、そこに繋がるもの

`--enable-gpl` で x264 を繋いでいるので、**出来上がる ffmpeg / ffprobe は GPL-2.0-or-later**
になります。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| FFmpeg 9.0.1 | エンコード・字幕・サムネイル・ライブ | <https://ffmpeg.org> | LGPL-2.1+ (`--enable-gpl` で GPL-2.0+) |
| x264 | H.264 のエンコード | <https://www.videolan.org/developers/x264.html> | GPL-2.0+ |
| SVT-AV1 4.2.0 (ソースから静的リンク) | AV1 のエンコード | <https://gitlab.com/AOMediaCodec/SVT-AV1> | BSD-3-Clause-Clear + AOM 特許ライセンス |
| dav1d | AV1 のデコード | <https://code.videolan.org/videolan/dav1d> | BSD-2-Clause |
| Opus (libopus) | 音声 | <https://opus-codec.org> | BSD-3-Clause |
| libaribcaption 1.1.2 (ソースから) | ARIB 字幕を絵にする | <https://github.com/xqq/libaribcaption> | MIT |
| FreeType / fontconfig | 字幕の描画とフォント解決 | <https://freetype.org> / <https://fontconfig.org> | FTL (or GPL-2.0) / MIT 系 |
| libva / libva-drm | VA-API (GPU で焼く) | <https://github.com/intel/libva> | MIT |
| libvpl / libmfx-gen | Intel QSV (GPU で焼く) | <https://github.com/intel/libvpl> / <https://github.com/intel/vpl-gpu-rt> | MIT |
| intel-media-va-driver (iHD) | Intel の VA-API ドライバ | <https://github.com/intel/media-driver> | MIT (一部 BSD) |
| zlib | ffmpeg の依存 | <https://zlib.net> | zlib |
| [patches/](../patches) | ffmpeg の libaribcaption 呼び出しに当てている直し (denpa が書いたもの。上流に投げる前提) | — | 当てる先と同じ (LGPL/GPL) |

### CM 検出

`/opt/jls` に入る 3 本のバイナリと判定規則。**GPL-3.0 のバイナリを同梱**しています。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| join_logo_scp 5.1.1 | 本編と CM の判定 (`JL_*.txt` の規則も同梱) | <https://github.com/yobibi/join_logo_scp> (nekopanda 版のフォーク) | **正式なライセンス文書は無し**。README に「転載・改変は連絡不要 (各自の責任で)」とだけ。その表示に拠っています |
| chapter_exe | 無音とシーンチェンジ | <https://github.com/tobitti0/chapter_exe> (原作 ru、Linux 移植 sogaani) | GPL-3.0 |
| logoframe | 局ロゴの検出と学習 (`.lgd`) | <https://github.com/tobitti0/logoframe> (原作 Yobi、移植 sogaani) | GPL-3.0 |
| dtvindex | 上の 2 本が TS を読むための静的ライブラリ | <https://github.com/tobitti0/dtvindex> | GPL-3.0 |
| Debian の FFmpeg 共有ライブラリ (`libavcodec61` ほか) | 上の 3 本が繋ぐぶんだけ | Debian | LGPL-2.1+ (Debian のビルドは GPL 有効) |

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
**NuGet の依存は 0** (YAML も JSON も自前)。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| .NET 10 ランタイム (AOT でバイナリに埋まる) | エージェント本体 | <https://github.com/dotnet/runtime> | MIT |
| libaribb25 0.2.10 (deb) | B25 のスクランブル解除 | <https://github.com/tsukumijima/libaribb25> (arib_std_b25 → stz2012/libarib25 の系譜) | **Apache-2.0** (NOTICE の写しが要る) |
| pcscd / libpcsclite | B-CAS カードの読み取り | <https://pcsclite.apdu.fr> | BSD-3-Clause |
| pcsc-tools | カードの確認 | <https://pcsc-tools.apdu.fr> | GPL-2.0+ |
| util-linux (`setsid`) / procps / curl / zlib / ca-certificates / tzdata | 道具 | Debian | GPL-2.0 (一部 LGPL/BSD) / GPL-2.0+ / curl / zlib / MPL-2.0 / PD |

## リポジトリに写してあるもの・借りた表

| 名前 | 場所 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- | --- |
| web-bml (無改変。先頭 2 行だけ足してある) | [src/lib/vendor/web-bml](../src/lib/vendor/web-bml) | データ放送 (BML) を描く | <https://github.com/otya128/web-bml> | MIT ([LICENSE](../src/lib/vendor/web-bml/LICENSE)) |
| es2 (ECMAScript 2nd Edition の処理系) | 同 `es2/index.ts` | BML のスクリプトを動かす | <https://github.com/otya128/es2> | MIT (ファイル冒頭の SPDX) |
| ARIB ロゴの CLUT (129 色) | [src/lib/ts/logo-palette.ts](../src/lib/ts/logo-palette.ts) | 局ロゴの PNG 化 | node-aribts / @chinachu/aribts の `logo_clut.js` と同じ並び | MIT (上流) |
| ARIB 外字表 | [src/lib/ts/aribtext-gaiji.ts](../src/lib/ts/aribtext-gaiji.ts) | 番組名の「[新]」「[字]」など | epgdump_py (Yasumasa Murakami, 2011) → ariblib に引き継がれた表 | MIT (ariblib。上流) |
| 選局表の値と選局手順 | [agent/Denpa.Agent/ChannelTable.cs](../agent/Denpa.Agent/ChannelTable.cs) / `Tuning.cs` | チャンネル名 → 周波数、DVB の手順 | recisdb-rs の `dvbv5_channels_isdbs.conf` / `dvbv5.rs` を参照 (コードは写していない) | GPL-3.0 (上流) |
| エンコード再試行の秒数 (0.2) | [src/lib/server/config.ts](../src/lib/server/config.ts) | 値だけ | EPGStation の `enc.js` | MIT (上流) |
| アイコン類 | [static/](../static) | PWA のアイコン | 自作 | AGPL (denpa と同じ) |

## ブラウザへ配る束・サーバの束に入る主なもの

`package.json` に runtime の `dependencies` は無く、adapter-node が全部を `build/` に
畳み込みます (イメージにもそれだけを載せる)。**MIT がほとんどで、例外は 2 つ**
(`crc-32` が Apache-2.0、`ieee754` が BSD-3-Clause)。

| 名前 | 何に | 出どころ | ライセンス |
| --- | --- | --- | --- |
| Svelte / SvelteKit / adapter-node | 画面・ルーティング・サーバの束 | <https://github.com/sveltejs> | MIT |
| Tailwind CSS / daisyUI | 出力 CSS | <https://tailwindcss.com> / <https://daisyui.com> | MIT |
| buffer (feross) + base64-js / ieee754 | web-bml が要る Node の `Buffer` | <https://github.com/feross/buffer> | MIT / MIT / **BSD-3-Clause** |
| crc-32 | web-bml の PNG / DRCS | <https://github.com/SheetJS/js-crc32> | **Apache-2.0** |
| css (reworkcss、otya128 の fork) + source-map ほか | web-bml が BML の CSS を解く | <https://github.com/reworkcss/css> | MIT (依存は BSD-3 / MIT) |
| fast-xml-parser / fast-xml-builder | web-bml の BML → XHTML | <https://github.com/NaturalIntelligence/fast-xml-parser> | MIT |
| cookie / devalue / set-cookie-parser / sirv / mrmime / totalist / esm-env / clsx | SvelteKit と adapter-node のランタイム | 各上流 | MIT |

## 使っていないもの (書いておく価値のあるもの)

- **JS-Interpreter (Google, Apache-2.0)** — web-bml の上流はこれで BML のスクリプトを
  動かしますが、denpa は es2 に差し替えていて写していません
- **@chinachu/aribts / aribb24.js / mpegts.js / hls.js / shaka-player** — 検討したうえで
  自前実装にしたもの ([stream.md](stream.md))
- **OIDC のライブラリ** — 入れていません ([auth.md](auth.md))
- **recisdb** — 選局は自前で ioctl を叩きます。値の出どころとして上に書いてあります
