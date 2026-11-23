# 借りているもの (ライセンス)

denpa 自身は **AGPL-3.0-or-later** ([LICENSE](../LICENSE)) です。ただし `packages/arib/` (npm の `@danything/arib`。
denpa のリリースといっしょに出す) は **MIT** ([packages/arib/LICENSE](../packages/arib/LICENSE)) です。
チューナーエージェント (`agent/`) は **MPL-2.0** ([agent/LICENSE](../agent/LICENSE)) で、ASICEN 系の機材の子プロセス (`agent/asicen/`。asicen-userland を組み込んだ別のプログラム) だけが **GPL-2.0-only** です。
エージェントとはやりとりするだけの別のプログラムなので、エージェントは MPL-2.0 のままです ([下](#asicen-の子プロセス))。ここには、**コンテナ
イメージに同梱して配っているもの・リポジトリに写してあるもの・ブラウザへ配る束に
入るもの**を、出どころとライセンスごとに並べます。README の「ライセンス」はこの入口です。

書き方の約束: 「根拠」はリポジトリの中で確かめられるもの (LICENSE ファイル・
Dockerfile の行・`package.json`) を優先し、上流の表示に拠るものは (上流) と添えます。
**バージョンは、上げるときに人が確かめるもの (.NET のメジャー・asicen-userland のプレリリースなど) のほかは書きません。** Renovate が Dockerfile の `ARG` / `ENV` を上げるたびに食い違うので、
いま入っているバージョンは Dockerfile を見てください。

## コンテナイメージ `denpa` に入るもの

[Dockerfile](../Dockerfile) の `runtime` 段。土台は distroless (`gcr.io/distroless/base-nossl-debian13`。libssl を持たない)。libstdc++・libgcc_s・zlib は ffmpeg と GPU のドライバが繋ぐので Debian のパッケージから写す。
Debian のパッケージ (libva・ドライバなど) は要るファイルだけを写し、そのパッケージの copyright を
`/usr/share/doc/<パッケージ>/copyright` に置いています。ソースから組む Rockchip MPP (arm64 だけ) と Mesa (amd64 だけ) は、
ライセンスの文を `/usr/share/doc/rockchip-mpp/`・`/usr/share/doc/mesa/` に置いています。

### 自前ビルドの ffmpeg と、そこに繋がるもの

`--enable-gpl` で x264 を繋ぎ、`--enable-version3` も付けて組んでいるので、**出来上がる ffmpeg / ffprobe と、
2 つが共有する `libav*` の共有ライブラリ (`/usr/local/lib`) は GPL-3.0-or-later** になります。
version3 は arm64 で Rockchip MPP (Apache-2.0。GPLv2 とは組み合わせられない) を繋ぐためで、
FFmpeg の configure が rkmpp を version3 の一覧に入れています。ライセンスが arch で分かれないよう amd64 もそろえています。
denpa 本体は AGPL-3.0-or-later で、GPLv3 のものと一緒に配れます。

| 名前                                                                            | 何に                                                                                                   | 出どころ                                        | ライセンス                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| FFmpeg                                                                          | エンコード・字幕・サムネイル・ライブ                                                                   | <https://ffmpeg.org>                            | LGPL-2.1+ (`--enable-gpl --enable-version3` で GPL-3.0+)                  |
| x264                                                                            | H.264 のエンコード                                                                                     | <https://www.videolan.org/developers/x264.html> | GPL-2.0+                                                                  |
| SVT-AV1 (ソースから組み、libavcodec に静的リンク)                               | AV1 のエンコード                                                                                       | <https://gitlab.com/AOMediaCodec/SVT-AV1>       | BSD-3-Clause-Clear + AOM 特許ライセンス                                   |
| dav1d                                                                           | AV1 のデコード                                                                                         | <https://code.videolan.org/videolan/dav1d>      | BSD-2-Clause                                                              |
| zimg (libzimg。Debian のパッケージ)                                             | 4K の局のライブと録画で、HLG を SDR に直す (`zscale`)                                                  | <https://github.com/sekrit-twc/zimg>            | WTFPL                                                                     |
| Opus (libopus。ソースから組み、libavcodec に静的リンク)                         | 音声                                                                                                   | <https://opus-codec.org>                        | BSD-3-Clause                                                              |
| libva / libva-drm                                                               | VA-API (GPU でエンコードする)                                                                          | <https://github.com/intel/libva>                | MIT                                                                       |
| intel-media-va-driver-non-free (iHD。Debian の non-free 版)                     | Intel の VA-API ドライバ                                                                               | <https://github.com/intel/media-driver>         | MIT (一部 BSD)                                                            |
| Mesa (radeonsi の VA-API ドライバだけ。amd64 だけ。ソースから組む)              | AMD の VA-API ドライバ                                                                                 | <https://mesa3d.org>                            | MIT (一部 BSD など。docs/license.rst を /usr/share/doc/mesa に置く)       |
| libdrm-amdgpu・libelf・libexpat・libzstd                                        | AMD の VA-API ドライバの依存                                                                           | Debian のパッケージ                             | MIT 系・libelf は GPL-2.0+ か LGPL-3.0+ (パッケージの copyright のとおり) |
| nv-codec-headers (amd64 だけ。組むときのヘッダだけで、ファイルとしては入らない) | NVIDIA の NVENC (GPU でエンコードする)。ドライバのライブラリはホストのものを使い、イメージには入れない | <https://github.com/FFmpeg/nv-codec-headers>    | MIT                                                                       |
| Rockchip MPP (arm64 だけ。ソースから組み、`librockchip_mpp.so.1` を置く)        | RK3588 / RK3588S のハードウェアエンコード (h264_rkmpp・hevc_rkmpp)                                     | <https://github.com/rockchip-linux/mpp>         | Apache-2.0 (一部 MIT)                                                     |
| i965-va-driver・libigdgmm・libdrm・libpciaccess                                 | 古い世代の Intel の VA-API ドライバと、ドライバの依存 (libdrm は Rockchip MPP も使う)                  | Debian のパッケージ                             | MIT 系 (パッケージの copyright のとおり)                                  |
| zlib                                                                            | ffmpeg の依存                                                                                          | <https://zlib.net>                              | zlib                                                                      |
| [patches/](../patches)                                                          | ffmpeg に当てる直しの置き場 (いまは空。denpa が書いたもの。上流へ送る前提)                             | —                                               | 当てる先と同じ (ffmpeg は LGPL/GPL)                                       |

### フォント

| 名前       | 何に                                                                                                                                                                                                                                     | 出どころ                                                                                                                                                                                                                                                                        | ライセンス                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Denpa Font | データ放送・字幕と、画面の放送の字 (番組名・説明など) の web フォント (`/api/font/` で配る。基本の字の `denpa-font.woff2` と JIS X 0213 で足された漢字の `denpa-font-jisx0213.woff2` を、`denpa-font.css` が unicode-range で名乗らせる) | <https://github.com/danything/denpa-font> のリリースの woff2 の 2 つと字の範囲 (`denpa-font-jisx0213.txt`。タグで留め、同じリリースの SHA256SUMS で照らす)。BIZ UDゴシック (モリサワ) の角を丸め、BIZ UDゴシックに無い ARIB の記号・字を BIZ UDゴシックの部品で組んで足したもの | SIL OFL 1.1 (元の BIZ UDゴシックと同じ。原文は denpa-font の README) |

フォントに入る字は denpa の字の表 (`b24-tables.ts`・`aribtext-gaiji.ts` など) から作られる (denpa-font の fetch.sh がバージョンを留めて読む)。
**表に字を足したら**: `src/lib/ts/font-coverage.test.ts` が取ってくるフォントに無い字を出して落ちる →
denpa-font の `DENPA_COMMIT` を上げて (元に無い字は描き方を足して) リリースを出す → ここの Dockerfile の
`DENPA_FONT_VERSION` (タグ) を上げる (Renovate の github-releases)。

### ランタイム

| 名前                                                                       | 何に                                 | 出どころ                                                                          | ライセンス                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun (実行バイナリだけ `oven/bun` から写す)                                 | denpa 本体を動かす                   | <https://github.com/oven-sh/bun>                                                  | MIT (中の JavaScriptCore は LGPL-2.1)                                                                                                                                                       |
| 土台 (glibc・ca-certificates・tzdata) と、写した libstdc++・libgcc_s・zlib | bun と ffmpeg を動かす・証明書・時刻 | <https://github.com/GoogleContainerTools/distroless> (中身は Debian のパッケージ) | 組み方は Apache-2.0。中身はパッケージごと: glibc は LGPL-2.1+、libstdc++ は GPL-3.0+ (GCC Runtime Library Exception)、zlib は zlib、ca-certificates は MPL-2.0、tzdata はパブリックドメイン |

## コンテナイメージ `denpa-agent` に入るもの

[agent/Dockerfile](../agent/Dockerfile)。土台は distroless (`gcr.io/distroless/cc-debian13`。Debian 13 のパッケージから要るものだけを置いたもの)。
.NET の Native AOT で 1 つのバイナリにしてあり、
**NuGet の依存は 0** (JSON はランタイムの `System.Text.Json`)。

| 名前                                                                                                                                | 何に                                                                                                                                                                                    | 出どころ                                                                                                        | ライセンス                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .NET 11 ランタイムと ASP.NET Core (Kestrel。AOT でバイナリに埋まる)                                                                 | エージェント本体                                                                                                                                                                        | <https://github.com/dotnet/runtime>・<https://github.com/dotnet/aspnetcore>                                     | MIT                                                                                                                                                                                                                                                                                                                                             |
| ASICEN の子プロセス (`/opt/asicen-userland/denpa-asicen`。上流のプレリリース v1.0.0-beta のソースから組む。Linux の amd64 と arm64) | PLEX PX-W3U3 などのユーザー空間ドライバ (試験的。実機では確かめていない)。エージェントが筐体ごとに起動する別のプログラム。上流の部品をつなぐ所 (`agent/asicen/`) は denpa が書いたもの  | <https://github.com/Khronos31/asicen-userland> のソースのアーカイブ (dtv-userland-core と libusb 1.0.30 を同梱) | **GPL-2.0-only** (上流は GPL-2.0-only と GPL-2.0-or-later の組み合わせ、`agent/asicen/` は GPL-2.0-only、dtv-userland-core の核は MIT、静的リンクの libusb は LGPL-2.1+)。**エージェントとは別のプログラムで、エージェントは MPL-2.0 のまま** ([下](#asicen-の子プロセス))。ライセンスの文書とソースの入手先は `/opt/asicen-userland/licenses/` |
| ASICEN ファームウェア (`/opt/asicen-userland/firmware/asicen-loader.bin`、16,384 バイト)                                            | 挿した直後の PX-W3U3 などに子プロセスが流し込む                                                                                                                                         | asicen-userland の配布物に入っているものをそのまま ([表の下](#asicen-のファームウェア))                         | **ライセンス無し・再配布の許諾は確かめられていない。** 上流と同じ判断で同梱している                                                                                                                                                                                                                                                             |
| 土台 (glibc・libssl・ca-certificates・libstdc++・tzdata)                                                                            | エージェントを動かす。libssl はエージェントのポートの HTTPS (denpa と証明書で確かめ合う) で常に使い、`CARD_URL` を https で指したときにも使う。ca-certificates はその相手の証明書の検証 | <https://github.com/GoogleContainerTools/distroless> (中身は Debian のパッケージ)                               | 組み方は Apache-2.0。中身はパッケージごと: glibc は LGPL-2.1+、OpenSSL は Apache-2.0、ca-certificates は MPL-2.0、libstdc++ は GPL-3.0+ (GCC Runtime Library Exception)、tzdata はパブリックドメイン                                                                                                                                            |

IT930x・Siano・DiB0700 のファームウェアは、エージェントの実行ファイルに埋め込んであります ([下](#チューナーエージェントに同梱するファームウェア))。

[px4-userland](https://github.com/Khronos31/px4-userland)・[siano-userland](https://github.com/Khronos31/siano-userland)・[asicen-userland](https://github.com/Khronos31/asicen-userland) (@Khronos31) は、
ホストにドライバを入れずにチューナーを使う形を先に示してくれた仕事です。このうち asicen-userland を、上の表のとおり同梱しています。

### ASICEN のファームウェア

**ASICEN のファームウェア (`asicen-loader.bin`) は、再配布の許諾を確かめられていません。上流と同じ判断で、エージェントのイメージと Android のアプリに同梱しています。**
**Windows と Mac のエージェントの配布物には入れません** (PLEX に許諾を問い合わせています。SignPath で署名する配布物に、許諾の分からないものを入れないため)。
Windows と Mac では、利用者が tuners.json の隣の `firmware/` に置いたものを使います (Xbox One Digital TV Tuner の復調のファームウェアと同じ。[tuners.md](tuners.md#ファームウェア))。
権利を持つ人から申し出があれば外します。分かっている事実は次のとおりです。

- ファームウェアは、PLEX の Windows 用ドライバ (`Loader.sys`) から上流 ([Khronos31/asicen-userland](https://github.com/Khronos31/asicen-userland)) が取り出した 16,384 バイトのイメージです。
  上流の配布アーカイブに入っているものをそのまま使います。イメージと APK を組むときに、SHA-256 が `5db39facda140bdcb3a238dad10da5aac752a1ba3aaf17e2239f8d79a0ad6a2a` であることを確かめます (`agent/asicen/build.sh`)。
  利用者が置いたものも、エージェントが同じ SHA-256 かを確かめてから使います
- チップの会社 ASICEN (昇亮科技股份有限公司 / Asicen Technology、台湾) は解散し、2017-02-23 に清算が完結したと登記されています。
  台湾の会社情報サイト (<https://www.twincn.com/item.aspx?no=80342850>) の記載で、経済部の公式の登記では確かめていません
- PLEX は 2026-11 の時点で、公式サイトの「旧製品ドライバ」のページ (<https://plex-net.co.jp/old-driver/>) で PX-W3U3・PX-W3U3 V2・PX-S3U2 の Windows 用ドライバを配っています。
  そのページにも、上流が調べた公式のパッケージにも、再配布を認める文はありません
- PLEX が以前配っていた Linux 用ドライバのモジュールには `license=GPL` の表示があり、同じファームウェアが埋め込まれています。
  それだけではファームウェア自体のライセンスは決まりません (上流の `NOTICES.md` の整理)
- 上流が添える通知 (`licenses/VENDOR-FIRMWARE-NOTICE.txt` など) は、配布物のままイメージ (`/opt/asicen-userland/licenses/`) と APK (`assets/licenses/asicen-userland/`) に置いてあります
- ファームウェアは機材に送るデータで、ホストで実行するコードではありません。GPL の及ぶ範囲の外の部品として扱います (上流の `NOTICES.md` も同じ)

### ASICEN の子プロセス

**ASICEN 系の機材は、エージェントとは別のプログラム `denpa-asicen` (GPL-2.0-only) が扱います。エージェント (MPL-2.0) はそれを子プロセスとして起動し、
標準入出力で選局の要求・状態・TS だけをやりとりします** ([agent.md](agent.md#asicen-userland-の作り))。
FSF は、パイプ・ソケット・コマンドラインの引数でのやりとりを、別のプログラムどうしの通信として扱っています (GPL の FAQ の「aggregate」と「plug-in」の項)。
やりとりする中身は、短い文の命令と、番号・機種の名前・受信機の方式の JSON と、放送の TS だけで、互いの内部の構造は渡しません。

- `denpa-asicen` は `agent/asicen/` (GPL-2.0-only。[agent/asicen/COPYING](../agent/asicen/COPYING)) と、上流の asicen-userland・dtv-userland-core・libusb を 1 つの実行ファイルにしたものです。
  asicen-userland には GPL-2.0-only のファイルと GPL-2.0-or-later のファイルがあり、取り込んだ px4-userland (`third_party/px4-userland/`。px4_drv から来た部分を含む) は GPL-2.0-only です。
  そのため `denpa-asicen` は全体を GPL-2.0-only の条件で配ります。上流のファイルは変えずに使い、`agent/asicen/` に写した上流の流れはその場所のコメントに書いてあります
- 中に入れるもののうち、dtv-userland-core の核 (MIT)、libusb (LGPL-2.1+。静的リンク。組み合わせ全体のソースと組み方を出すので、組み直しの条件も満たす)、
  C++ の実行時ライブラリ (Linux は libstdc++ と libgcc_s を読む。GCC Runtime Library Exception。Android と Windows は LLVM の libc++ を静的に入れる。Apache-2.0 WITH LLVM-exception。
  Windows は mingw-w64 の実行時ライブラリと winpthreads も静的に入れる。MIT 系) は GPL-2.0 の条件と組み合わせられます。OpenSSL は入れません
- **エージェントには GPL のコードを入れません。** エージェントの C# は MPL-2.0 のままで、上流の表や値も写していません。
  エージェントが使う OpenSSL (Apache-2.0。Linux のイメージは土台の libssl、Android は静的リンク) と .NET のランタイムは、エージェントのプロセスにだけ入ります
- 配布物 (Linux のイメージ・`denpa-aio`・Windows の zip・Mac の tar.gz・Android の APK) には、エージェントと `denpa-asicen` を別の実行ファイルとして並べて入れます (GPL-2.0 §2 の「同じ媒体に入れただけ」の集まり)。
  置き場は、イメージが `/opt/asicen-userland/`、Windows と Mac がエージェントの隣の `asicen/`、APK が `lib/<ABI>/libdenpa_asicen.so` (jniLibs は `lib*.so` の名前しか展開されないため) です
- **対応するソース**: `agent/asicen/` はリリースのタグのソースにあり、リリースに `denpa-asicen-<バージョン>-source.tar.gz` (`agent/asicen/` だけを固めたもの) も添えます。
  asicen-userland・dtv-userland-core・libusb は上流のソースのアーカイブ (SHA-256 は `agent/asicen/build.sh`) で、上流の置き場だけに頼らず、同じアーカイブを denpa のリリースにも添えます (`release.yml` の `asicen-source`)。
  組み方は `agent/asicen/build.sh` です。入手先は、どの配布物でも `denpa-asicen` の隣の `licenses/SOURCE.txt` (APK は `assets/licenses/asicen-userland/SOURCE.txt`) に書いてあります
- Windows の `denpa-asicen.exe` は SignPath の署名に送りません (理由は [install-windows.md](install-windows.md#コード署名))

**エージェントと同じプロセスに入れる形で起きる OpenSSL との組み合わせの問題は、この形で解きました。**
同じプロセスでは、GPL-2.0-only のコードと、OpenSSL (Apache-2.0) や .NET のランタイムに入っている Apache-2.0 のコードが 1 つのプログラムになり、FSF はこの組み合わせを認めていません。
OpenSSL を外しても .NET のランタイムの Apache-2.0 の部分が残るので、GPL のコードを別のプログラムに分けました。いまは、GPL の条件の及ぶ `denpa-asicen` に OpenSSL も Apache-2.0 のコードも入らず、
エージェントに GPL のコードは入りません。

### チューナーエージェントに同梱するファームウェア

| 名前                                                                | 何に                                                                                                                                                                                                                                  | 出どころ                                                                                                                                                                                                                                                                                                                                                           | ライセンス                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IT930x のファームウェア (`it930x-firmware.bin`、2,169 バイト)       | IT930x の機材 (USB ブリッジ IT930x) に、機材を開くたびに流し込む。エージェントの実行ファイルに埋め込み、エージェントが USB で直に送る (`It930xFirmware.cs`。ファイルには書き出さない)                                                 | ITE Tech. の IT930x の Linux ドライバの `api/brfirmware.h` にある `brFirmware_codes[]` (`V1_3_0_0`) をそのままバイト列に書き出したもの。SHA-256 `5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484` ([agent/Denpa.Agent/firmware/](../agent/Denpa.Agent/firmware/README.md))                                                                        | **ITE Tech. の再配布許諾** (無改変のままチューナーエージェントに同梱して再配布してよい。エージェントの MPL-2.0 はこのファイルには及ばない)                                                                                                                                                                                                                                      |
| Siano の ISDB-T のファームウェア (`isdbt_rio.inp`、85,840 バイト)   | PX-S1UD などの Siano RIO 系の機材に、ファームウェアが入っていないときに送る。エージェントの実行ファイルに埋め込み、エージェントが USB で直に送る (`SianoFirmware.cs`)。中身は解析しない                                               | [linux-firmware](https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git) のコミット `a2dcb924f0897368b0b4f305cbf9808cdda90ce0` (タグ `20261019`) の `isdbt_rio.inp` をそのまま。SHA-256 `054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818` ([agent/Denpa.Agent/firmware/](../agent/Denpa.Agent/firmware/README.md))           | **Siano の再配布許諾** (Siano Mobile Silicon。無改変のバイナリなら再配布可。解析は禁止。エージェントの MPL-2.0 はこのファイルには及ばない)。許諾の文面 `LICENCE.siano` を、イメージは `/usr/share/doc/denpa-agent/` に、Mac と Windows の配布物は実行ファイルの隣に、Android の APK は `assets/licenses/` に置く                                                                |
| DiB0700 のファームウェア (`dvb-usb-dib0700-1.20.fw`、33,768 バイト) | Xbox One Digital TV Tuner の USB ブリッジ (DiBcom DiB0700) に、ファームウェアが入っていないときに送る。エージェントの実行ファイルに埋め込み、エージェントが USB で直に送る (`Dib0700.cs`)。中身は解析せず、レコードの区切りだけを読む | [linux-firmware](https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git) のコミット `a2dcb924f0897368b0b4f305cbf9808cdda90ce0` (タグ `20261019`) の `dvb-usb-dib0700-1.20.fw` をそのまま。SHA-256 `74f5ffeb43767e1af6d379d6cc2e0efeaa54455d030bcd71d95f0f2a908c672a` ([agent/Denpa.Agent/firmware/](../agent/Denpa.Agent/firmware/README.md)) | **DiBcom の許諾 (ISC)**。linux-firmware の `WHENCE` は「Redistributable」としている。著作権表示と許諾の文面を添えることを求めるので、文面 `LICENSE.dib0700` を `LICENCE.siano` と同じ場所 (イメージの `/usr/share/doc/denpa-agent/`、Mac と Windows の配布物の実行ファイルの隣、Android の APK の `assets/licenses/`) に置く。エージェントの MPL-2.0 はこのファイルには及ばない |

IT930x のファームウェアの許諾は、ITE Tech. の Mike Huang 氏 (Marketing & Sales BU) から 2026-11-04 14:16 (日本時間) のメール
(Message-ID `<d1d67cb55ae74a32a6a232a172ccf622@ite.com.tw>`) で得ています。ITE の IT930x の Linux ドライバに入っているファームウェアのデータ
(`brfirmware.h`・`firmware.h`) を無改変のままチューナーエージェントに同梱して再配布してよい、という確認です。
同じメールで、ITE のドライバのコードをチューナーエージェントの中で MPL-2.0 として使い、変え、公開してよいことも確認しています。
IT930x のブリッジの層と内蔵カードリーダー (`It930x*.cs`。カードは SDK の `IT9300_bcas*` の手順) は、この確認のもとで ITE の SDK を元に書いたもので、MPL-2.0 です。
ファームウェアの区切りの表 (`It930xFirmware.Segments`) も SDK の `brFirmware_segments[]` を写したものです。SDK の中の Sony のコードは使っていません。
同じ機材の復調器 (CXD2856ER) とチューナー (CXD2858ER) の層 (`Cxd2856.cs`・`Cxd2858.cs`) は、クリーンルームで仕様書だけから書いたもので、MPL-2.0 です。
仕様書は別のエージェントが公開の資料から事実だけを書いたもの (denpa-spec の `cxd2856/spec.md`) で、コードを書く側は px4_drv・px4-userland・cxd28xx と SDK の Sony のコードを読んでいません。
書き込みの値の並びは仕様書に値のまま載っていたもので、チップに要る値として扱っています ([下](#リポジトリに写してあるもの借りた表))。
PX-Q3・PX-W3 系などの復調器 (TC90522) とチューナー (R850・RT710) の層 (`Tc90522.cs`・`R850.cs`・`Rt710.cs`) も同じ進め方で書いたもので、MPL-2.0 です。
仕様書は denpa-spec の `tc90522/spec.md` で、コードを書く側は px4_drv・px4-userland・PLEX の公開ドライバー・Linux カーネルのドライバーを読んでいません。GPL のコードは写していません。
PX-S1UD などの Siano RIO 系の機材をエージェントが USB で直に動かす層 (`Siano.cs`・`SianoMessage.cs`・`SianoFirmware.cs`・`SianoDevice.cs`・`SianoTs.cs`) も、
クリーンルームで仕様書だけから書いたもので、MPL-2.0 です。仕様書は別のエージェントが公開の資料から事実だけを書いたもの (denpa-spec の `siano/spec.md`) で、
コードを書く側は Linux カーネルの Siano のドライバ (`smsusb`・`smscoreapi`・`smsdvb` など) と siano-userland のコードを読んでいません。
ファームウェア (`isdbt_rio.inp`) は解析せず、上の表のファイルを、仕様書の手順で区切ってそのまま機材に送ります。
Xbox One Digital TV Tuner をエージェントが USB で直に動かす層 (`XboxOne.cs`・`Dib0700.cs`・`Mn88472.cs`・`Tda18250.cs`) も、クリーンルームで仕様書だけから書いたもので、MPL-2.0 です。
仕様書は別のエージェントが、GPL-2.0 のドライバ (kiwi-93 の xbox-one-isdbc-dkms と、mainline Linux の `dib0700`・`mn88472`・`tda18250` のドライバ) から事実だけを書き出したもので、
コードを書く側はそれらのドライバのコードを読んでいません。GPL のコードは写していません。
復調のファームウェア (`dvb-demod-mn88472-02.fw`) は再配布の許諾が分からないので同梱せず、利用者が置いたものを読みます ([tuner-xbox-one.md](tuner-xbox-one.md#置くファームウェア))。

### Mac に入れるもの (`install.sh`)

リリースに添えた `denpa-agent-<バージョン>-darwin-arm64.tar.gz` (上と同じ .NET の Native AOT のバイナリと、メニューバーのアプリ `denpa-tray`。
`denpa-tray` は denpa 本体と同じ AGPL-3.0 で、Swift で書き、OS の AppKit だけを使う) を入れます。
ファームウェア (IT930x・Siano・DiB0700) はエージェントに埋め込んであり、Siano と DiB0700 の許諾の文面 (`LICENCE.siano`・`LICENSE.dib0700`) を tar.gz に添えています。ASICEN 系の機材の子プロセス (`asicen/denpa-asicen`。GPL-2.0-only の別のプログラム。ad-hoc で署名する) と、そのライセンスの文書・対応するソースの入手先 (`asicen/licenses/`) も入れます ([上](#asicen-の子プロセス))。ASICEN のファームウェアは入れません (利用者が置く。[上](#asicen-のファームウェア))。
USB のカードリーダーは macOS の PCSC.framework (OS の一部) を呼びます。

**denpa 本体は、リリースに添えた `denpa-<バージョン>-darwin-arm64.tar.gz` を入れます** ([.github/workflows/macos-server.yml](../.github/workflows/macos-server.yml))。
Windows (下) と同じく、上のコンテナイメージ `denpa` と同じものを Mac 用にしたものです。アプリ・Denpa Font・ブラウザへ配るデコーダは
イメージと同じ段から写します。ライセンスの文書は tar.gz の `licenses/` と `ffmpeg/licenses/` に置きます。

| 名前                                                                                                  | 何に                                                                       | 出どころ                                                                                                                    | ライセンス                                                       |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Bun (`bun`。公式のリリースの `bun-darwin-aarch64.zip`)                                                | denpa 本体を動かす                                                         | <https://github.com/oven-sh/bun>                                                                                            | MIT (中の JavaScriptCore は LGPL-2.1)。`licenses/bun-LICENSE.md` |
| FFmpeg (`ffmpeg/`。CI の Mac のランナーで組み、libav* は静的リンク。ffprobe は読む部品だけで別に組む) | 上のイメージの ffmpeg と同じ                                               | <https://ffmpeg.org>                                                                                                        | イメージと同じく `--enable-gpl --enable-version3` で GPL-3.0+    |
| SVT-AV1・Opus (ソースから組み、静的リンク)                                                            | イメージと同じ                                                             | 上の表のとおり                                                                                                              | 上の表のとおり                                                   |
| x264・dav1d・zimg (ソースから組み、静的リンク。Debian trixie と同じバージョン)                        | H.264 のエンコード・AV1 のデコード・4K の局の HLG を SDR に直す (`zscale`) | <https://code.videolan.org/videolan/x264>・<https://code.videolan.org/videolan/dav1d>・<https://github.com/sekrit-twc/zimg> | GPL-2.0+・BSD-2-Clause・WTFPL。`ffmpeg/licenses/` に文書         |

VideoToolbox (GPU でのエンコード)・zlib・スレッド・C++ の標準ライブラリ (zimg が使う libc++) は macOS の一部を呼ぶので、tar.gz には入れません。
ffprobe は ffmpeg と同じソースから、読む部品 (デコーダ・デマクサ・パーサ・bsf) と dav1d・zlib だけで別に組みます (.github/ffmpeg-macos.sh)。SVT-AV1・Opus・x264 は ffmpeg にだけ入ります。
ソースは Dockerfile の `ffmpeg` 段と同じバージョンの上流の tarball と、.github/ffmpeg-macos.sh に書いた x264 のコミット・dav1d と zimg のバージョンです。

### Windows に入れるもの (`install.ps1`)

リリースに添えた `denpa-agent-<バージョン>-windows-x64.zip` (`denpa-agent.exe` と、通知領域のアイコンの `denpa-tray.exe`。
`denpa-tray.exe` は denpa 本体と同じ AGPL-3.0 の .NET の Native AOT のバイナリで、依存は足していない) を入れます。
ファームウェア (IT930x・Siano・DiB0700) は Mac と同じくエージェントに埋め込んであり、Siano と DiB0700 の許諾の文面 (`LICENCE.siano`・`LICENSE.dib0700`) を zip に添えています。
ASICEN 系の機材の子プロセス (`asicen\denpa-asicen.exe`。GPL-2.0-only の別のプログラム。Linux から llvm-mingw で組む。署名しない) と、そのライセンスの文書・対応するソースの入手先 (`asicen\licenses\`) も入れます ([上](#asicen-の子プロセス))。ASICEN のファームウェアは入れません (利用者が置く。[上](#asicen-のファームウェア))。カードリーダーは Windows の WinSCard (`winscard.dll`。OS の一部) を呼びます。

**同じ zip の `libwdi/` に、libwdi の `wdi-simple.exe` を別の実行ファイルとして入れます** (`install.ps1 -WinUsb` がチューナーのドライバを WinUSB に替えるときに起動する。
エージェントにはリンクしていない)。libwdi のリリースには Zadig しか無いので、タグとコミットを決めたソースからリリースのたびにビルドします
([scripts/build-wdi-simple.ps1](../scripts/build-wdi-simple.ps1)。バージョンとコミットもそこ)。

| 名前                                                                                       | 何に                                                                                    | 出どころ                                                                                                                                                                           | ライセンス                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| libwdi の `wdi-simple.exe` (ライブラリと、examples の `wdi-simple.c`・getopt を静的リンク) | チューナーのドライバを WinUSB に替える (ドライバのパッケージを作り、自己署名して入れる) | <https://github.com/pbatard/libwdi> のタグのソース。変えるのはビルドの設定だけ (x64 だけ。libusb-win32・libusbK・ARM64 用のインストーラを埋め込まない。`libwdi/README.txt` に書く) | **LGPL-3.0-or-later** (ライブラリも `wdi-simple.c` も、ソースの冒頭の表示のとおり。静的リンクする getopt (GNU C Library 由来) は LGPL-2.1+、`tokenizer.c` は LGPL-2+。`COPYING-LGPL` と `COPYING` を同じ場所に置く)                          |
| WinUSB のコインストーラー (`winusbcoinstaller2.dll`・`WdfCoInstaller01011.dll`)            | `wdi-simple.exe` に埋め込まれていて、ドライバのパッケージを作るときに書き出す           | Microsoft の Windows Driver Kit 8.0 の再配布物 (`wdfcoinstaller.msi`。上流の CI が Zadig のビルドに使うものと同じ。sha256 で確かめる)                                              | **Microsoft Windows Driver Frameworks 1.11 の許諾** (`REDIST.TXT` に並ぶファイルは、Windows で動かすプログラムの一部として、オブジェクトコードのまま配ってよい。許諾の 2.a。文面 `WDK-License.rtf` と一覧 `WDK-redist.txt` を同じ場所に置く) |

**denpa 本体は、リリースに添えた `denpa-<バージョン>-windows-x64.zip` を入れます** ([.github/workflows/windows-server.yml](../.github/workflows/windows-server.yml))。
中身は上のコンテナイメージ `denpa` と同じものを Windows 用にしたものです。アプリ (`app/`)・Denpa Font (`font/`)・ブラウザへ配るデコーダ (`mpeg2/`) は
イメージと同じ段 (Dockerfile の `app-files`・`denpa-font`・`mpeg2wasm`) から写します。ライセンスの文書は zip の `licenses/` と `ffmpeg/licenses/` に置きます。

| 名前                                                                                                  | 何に                                                                                                            | 出どころ                         | ライセンス                                                                          |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| Bun (`bun.exe`。公式のリリースの `bun-windows-x64-baseline.zip`)                                      | denpa 本体を動かす                                                                                              | <https://github.com/oven-sh/bun> | MIT (中の JavaScriptCore は LGPL-2.1)。`licenses/bun-LICENSE.md`                    |
| FFmpeg (`ffmpeg/`。MSYS2 の UCRT64 で組み、libav* は静的リンク。ffprobe は読む部品だけで別に組む)     | 上のイメージの ffmpeg と同じ                                                                                    | <https://ffmpeg.org>             | イメージと同じく `--enable-gpl --enable-version3` で GPL-3.0+                       |
| SVT-AV1・Opus (ソースから組み、libavcodec に静的リンク)                                               | イメージと同じ                                                                                                  | 上の表のとおり                   | 上の表のとおり                                                                      |
| x264・dav1d・zimg・zlib (MSYS2 のパッケージの DLL)                                                    | H.264 のエンコード・AV1 のデコード・4K の局の HLG を SDR に直す (`zscale`)・PNG                                 | <https://packages.msys2.org>     | GPL-2.0+・BSD-2-Clause・WTFPL・zlib                                                 |
| libvpl (DLL)・nv-codec-headers・AMF のヘッダ (MSYS2 のパッケージ。あとの 2 つは組むときのヘッダだけ)  | GPU でエンコードする (Intel の QSV・NVIDIA の NVENC・AMD の AMF)。ドライバのライブラリは GPU のドライバが入れる | <https://packages.msys2.org>     | MIT。`ffmpeg/licenses/` に文書                                                      |
| MinGW-w64 のランタイム (winpthreads・GCC の C++ の標準ライブラリなど。ffmpeg と zimg が読む DLL だけ) | スレッド・C++ の標準ライブラリなど                                                                              | <https://packages.msys2.org>     | パッケージのライセンスのとおり (MIT 系。GCC のものは GCC Runtime Library Exception) |

ffprobe.exe は ffmpeg.exe と同じソースから、読む部品 (デコーダ・デマクサ・パーサ・bsf) と dav1d・zlib だけで別に組みます。SVT-AV1・Opus・x264 と GPU のエンコーダは ffmpeg.exe にだけ入ります。
zip に入れる DLL は、組むときに ffmpeg.exe・ffprobe.exe の取り込み表から辿って決めます (.github/ffmpeg-windows.sh)。
CI は zip を作る前に、DLL が上の表のもの (x264・dav1d・zimg・zlib・libvpl・MinGW-w64 のランタイム) だけかを確かめます
(.github/workflows/windows-server.yml)。SVT-AV1 と Opus の DLL が入っていれば止まります。MSYS2 から写した DLL は、
そのパッケージのライセンスの文書を `ffmpeg/licenses/<パッケージ>/` に、パッケージとバージョンを `ffmpeg/licenses/msys2-packages.txt` に書きます。
パッケージに文書が無い x264 と zimg は、x264 には FFmpeg のソースにある GPLv2 の文を、zimg には上流の同じバージョンのタグの `COPYING` を置きます。
ソースは、自分で組むもの (FFmpeg・SVT-AV1・Opus) は Dockerfile の `ffmpeg` 段と同じバージョンの上流の tarball、MSYS2 のパッケージは
[msys2/MINGW-packages](https://github.com/msys2/MINGW-packages) の同じバージョンのものです。GPU のエンコーダ (NVENC・QSV・AMF) のヘッダとライブラリも MSYS2 のパッケージです。

### Android のアプリ

リリースに添える APK (`denpa-<バージョン>-android-arm64.apk`。パッケージは `io.github.danything.denpa`。組むのは [.github/workflows/android.yml](../.github/workflows/android.yml)) です。
アプリ (`android/`) は denpa と同じ AGPL-3.0-or-later です。常駐サービス・通知・USB・ソケット・子プロセスは Android の標準の API で書き、AndroidX も使いません。
APK に入る依存は、Kotlin で書くと付いてくる下の 2 つだけです。単体テストだけで使う JUnit (EPL-1.0) と org.json (Public Domain。android.jar の org.json は中身が無いため) は APK に入りません。

| 名前                                                                 | 何に                        | 出どころ                                        | ライセンス |
| -------------------------------------------------------------------- | --------------------------- | ----------------------------------------------- | ---------- |
| Kotlin の標準ライブラリ (`org.jetbrains.kotlin:kotlin-stdlib`)       | アプリの Kotlin のコード    | <https://github.com/JetBrains/kotlin>           | Apache-2.0 |
| JetBrains の注釈 (`org.jetbrains:annotations`。標準ライブラリが引く) | 型の注釈 (動作には使わない) | <https://github.com/JetBrains/java-annotations> | Apache-2.0 |

エージェントは `lib/<ABI>/libdenpa_agent.so` の名前で入れます。CI が `linux-bionic-arm64`・`linux-bionic-x64` の Native AOT で組み、リリースの APK には arm64 だけを入れます。
中身は上の `denpa-agent` と同じ .NET のバイナリで、ファームウェア (IT930x と Siano) も同じく埋め込んであります。
Android には OpenSSL が無いので、土台の libssl の代わりに OpenSSL を静的に入れます。
Siano と DiB0700 のファームウェアの許諾の文面 (`LICENCE.siano`・`LICENSE.dib0700`) と OpenSSL の `LICENSE.txt` (`LICENSE.openssl` の名前で) は、APK の `assets/licenses/` に入れています。

ASICEN 系の機材の子プロセスは、イメージと同じ `agent/asicen/build.sh` で NDK を使って組んだ実行ファイルを `lib/<ABI>/libdenpa_asicen.so` の名前で入れます (CI がエージェントと同じジョブで組む)。
エージェントとは別のプログラムで、エージェントが起動します ([上](#asicen-の子プロセス))。
ライセンスの文書と対応するソースの入手先 (`SOURCE.txt`) は `assets/licenses/asicen-userland/` に入れています。ファームウェアは `assets/asicen/asicen-loader.bin` に入れ、
アプリが起動のときに書き出します。扱いはイメージと同じです ([上](#asicen-のファームウェア))。

bun は、公式のリリースの Android 向けのビルド (`bun-linux-aarch64-android.zip`) の実行ファイルを組み直さずに、`lib/<ABI>/libbun.so` の名前で入れます
(`.github/bun-android.sh`。アーカイブは同じリリースの SHASUMS256.txt で確かめる)。CI のエミュレータ用の x86_64 の APK には `bun-linux-x64-android-baseline.zip` を入れます。
bun の `LICENSE.md` (静的に繋いだライブラリの一覧と、JavaScriptCore を組み直す手順がある) を APK の `assets/licenses/bun/` に入れています。

**denpa 本体は `assets/server.zip` に入れます。** Mac・Windows と同じく、上のコンテナイメージ `denpa` と同じものです。アプリ・Denpa Font・ブラウザへ配るデコーダは
イメージと同じ段 (Dockerfile の `native-files`) から写し、アプリが起動のときに書き出します。denpa の `LICENSE` は APK の `assets/licenses/` に入れています。

ffmpeg・ffprobe は、Mac と同じく CI が Dockerfile の `ffmpeg` 段と同じバージョンと部品で組みます (`.github/ffmpeg-android.sh`。NDK で組む)。
実行ファイルは `lib/<ABI>/libffmpeg.so`・`libffprobe.so` の名前で入れ、libav* は共有ライブラリ (`libavcodec.so` など) として同じ置き場に入れます。
SVT-AV1・Opus・x264・dav1d・zimg と NDK の libc++ (zimg が使う) は libav* に静的に繋ぎます。
**x264 が GPL なので、ffmpeg は GPL-3.0-or-later です。** ライセンスの文書、バージョンの一覧、組んだソースの入手先 (`SOURCE.txt`) を APK の `assets/licenses/ffmpeg/` に入れています。
ソースはどれも上流の配布物のままで、入手先は Mac と同じです (FFmpeg・SVT-AV1・Opus は上流の tarball、x264 はコミット、dav1d と zimg はバージョン)。
MediaCodec (GPU でのエンコード)・zlib は Android の一部 (`libmediandk.so`・`libz.so`) を呼ぶので、APK には入れません。

| 名前                                                                           | 何に                                                                                                           | 出どころ                                                                                 | ライセンス                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ASP.NET Core (linux の実行時パックの IL を AOT で埋める)                       | エージェントのポートの HTTPS (Kestrel)                                                                         | <https://github.com/dotnet/aspnetcore>                                                   | MIT                                                                                                                                        |
| OpenSSL (NDK で組み、静的リンク)                                               | エージェントのポートの HTTPS と、`CARD_URL` を https で指したとき                                              | <https://github.com/openssl/openssl> のリリースの tarball (`.github/openssl-android.sh`) | Apache-2.0。組み上がりの置き場に `LICENSE.txt` を写してあり、APK に入れて一緒に配る                                                        |
| ASICEN の子プロセス (`lib/<ABI>/libdenpa_asicen.so`。NDK で組む)               | PLEX PX-W3U3 などのユーザー空間ドライバ (試験的。実機では確かめていない)。エージェントが起動する別のプログラム | <https://github.com/Khronos31/asicen-userland> のソースのアーカイブ (イメージと同じ)     | **GPL-2.0-only** (イメージと同じ。NDK の libc++ を静的に入れる)。エージェントは MPL-2.0 のまま。`assets/licenses/asicen-userland/`         |
| Bun (`lib/<ABI>/libbun.so`。公式のリリースの Android 向けのビルド)             | denpa 本体を動かす                                                                                             | <https://github.com/oven-sh/bun>                                                         | MIT (中の JavaScriptCore は LGPL-2.1)。`assets/licenses/bun/LICENSE.md`                                                                    |
| FFmpeg (`lib/<ABI>/libffmpeg.so`・`libffprobe.so` と libav*。CI が NDK で組む) | 上のイメージの ffmpeg と同じ                                                                                   | <https://ffmpeg.org>                                                                     | イメージと同じく `--enable-gpl --enable-version3` で、全体は GPL-3.0-or-later。`assets/licenses/ffmpeg/`                                   |
| SVT-AV1・Opus・x264・dav1d・zimg (ソースから組み、libav* に静的リンク)         | 上の Mac の表と同じ                                                                                            | 上の Mac の表と同じ                                                                      | 上の Mac の表と同じ。`assets/licenses/ffmpeg/<名前>/`                                                                                      |
| NDK の libc++ (静的リンク)                                                     | zimg (C++)                                                                                                     | <https://android.googlesource.com/toolchain/llvm-project>                                | Apache-2.0 WITH LLVM-exception                                                                                                             |
| ASICEN ファームウェア (`assets/asicen/asicen-loader.bin`)                      | 挿した直後の PX-W3U3 などに子プロセスが流し込む                                                                | イメージと同じ上流の配布物から、そのまま (SHA-256 も同じ)                                | **ライセンス無し・再配布の許諾は確かめられていない。** イメージと同じ判断で同梱している ([上](#asicen-のファームウェアを同梱している判断)) |

### `denpa-aio`

上の `denpa` に、`denpa-agent` の実行ファイルと `/opt/asicen-userland`・Siano と DiB0700 の許諾の文面 (`/usr/share/doc/denpa-agent/`)
と、エージェントの土台の libssl・libcrypto・libzstd (それぞれの status.d と copyright も) を写しただけのもの (`.github/aio.Dockerfile`)。
中身もライセンスも上の 2 つと同じです (OpenSSL は Apache-2.0、zstd は BSD)。ASICEN の子プロセスも同じものを写します ([上](#asicen-の子プロセス))。

## リポジトリに写してあるもの・借りた表

| 名前                                  | 場所                                                                                                                                                                                                                         | 何に                                                                                                                                                                                                                                 | 出どころ                                                                                                                                                                                                                                                                                                                                                                                                  | ライセンス                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ARIB ロゴの CLUT (129 色)             | [src/lib/ts/logo-palette.ts](../src/lib/ts/logo-palette.ts)                                                                                                                                                                  | 局ロゴの PNG 化                                                                                                                                                                                                                      | node-aribts / @chinachu/aribts の `logo_clut.js` と同じ並び                                                                                                                                                                                                                                                                                                                                               | MIT (上流)                                                                                                        |
| ARIB 外字表                           | [packages/arib/src/aribtext-gaiji.ts](../packages/arib/src/aribtext-gaiji.ts)                                                                                                                                                | 番組名の「🈟」「🈑」など                                                                                                                                                                                                             | 字は字幕の表 (下の b24-tables.ts) を引く。番組表だけで違える数点 (楽器の略号の文字列・空きの埋め方) は epgdump_py (Yasumasa Murakami, 2011) → ariblib に引き継がれた表から                                                                                                                                                                                                                                | MIT (libaribcaption・ariblib。上流)                                                                               |
| 字幕の文字の表とデコード方法          | [packages/arib/src/b24-tables.ts](../packages/arib/src/b24-tables.ts) / [b24caption.ts](../packages/arib/src/b24caption.ts)                                                                                                  | 字幕を文字の配置にする (表は libaribcaption の b24_conv_tables.hpp / b24_gaiji_table.hpp / b24_colors.cpp / b24_drcs_conv.cpp を写したもので、いまは denpa が手で持つ。デコードの方法は decoder_impl.cpp を TypeScript に写したもの) | libaribcaption (Copyright (C) 2021 magicxqq)                                                                                                                                                                                                                                                                                                                                                              | MIT (上流)                                                                                                        |
| JIS X 0213 の対応表                   | [packages/arib/src/b24-tables.ts](../packages/arib/src/b24-tables.ts) の `KANJI_SEQUENCES`・`PLANE1_HIGH_ROWS`・`PLANE2` (作るのは [scripts/jisx0213.ts](../packages/arib/scripts/jisx0213.ts))                              | 字幕・番組表の JIS 互換漢字 1 面・2 面 (JIS X 0213:2004) を Unicode にする                                                                                                                                                           | x0213.org の jisx0213-2004-std.txt (Copyright (C) 2001 earthian@tama.or.jp / 2001 I'O / 2006, 2009 Project X0213。SHA-256 で留める)                                                                                                                                                                                                                                                                       | 「You can use, modify, distribute this table freely.」(表の冒頭の許諾。著作権表示は packages/arib/LICENSE に写す) |
| データ放送の通知の型                  | [packages/arib/src/bml-protocol.ts](../packages/arib/src/bml-protocol.ts)                                                                                                                                                    | デコードする側と描く側の取り決め・録画の隣の `.bml.jsonl` の形式 (前に録ったものを読めるよう、web-bml の `server/ws_api.ts` の型をそのまま写してある。著作権表示と許諾の文は [packages/arib/LICENSE](../packages/arib/LICENSE))      | web-bml (Copyright (c) 2022 otya)                                                                                                                                                                                                                                                                                                                                                                         | MIT                                                                                                               |
| 選局表の値と選局手順                  | [agent/Denpa.Agent/ChannelTable.cs](../agent/Denpa.Agent/ChannelTable.cs) / `Tuning.cs`                                                                                                                                      | チャンネル名 → 周波数、DVB の手順                                                                                                                                                                                                    | recisdb-rs の `channels.rs` / `dvbv5_channels_isdbs.conf` / `dvbv5.rs` を参照 (コードは写していない)                                                                                                                                                                                                                                                                                                      | GPL-3.0 (上流)                                                                                                    |
| C/N を dB にする近似式の係数          | [agent/Denpa.Agent/TunerSignal.cs](../agent/Denpa.Agent/TunerSignal.cs) の `Tc90522Db`                                                                                                                                       | PIX-DT295 と、IT930x の機材のうち TC90522 の機種の C/N (復調のレジスタの値) を dB にする                                                                                                                                             | recpt1 (stz2012/recpt1) の `recpt1core.c` が使う PT1・PT2 の C/N の近似式と同じ係数 (コードは写していない)                                                                                                                                                                                                                                                                                                | GPL-3.0 (上流)                                                                                                    |
| DiB8096 の係数表と並び                | [agent/Denpa.Agent/Dib8096.cs](../agent/Denpa.Agent/Dib8096.cs) の `Coefficients3/1/13`・`SegmentOrder`・`RampRf*`・`RampBb*`                                                                                                | ISDB-T のフィルタ係数、セグメントの並び、利得の段の表                                                                                                                                                                                | クリーンルームで書いた仕様書に値のまま載っていたもの。Linux の `dib8000.c` (`ana_fe_coeff_*`・`permu_seg`) / `dib0090.c` の表と同じ値 (コードは写していない。チップに要る値として扱う)                                                                                                                                                                                                                    | `dib8000.c` は GPL-2.0-only、`dib0090.c` は GPL-2.0-or-later (上流)                                               |
| CXD2856ER・CXD2858ER の書き込みの並び | [agent/Denpa.Agent/Cxd2856.cs](../agent/Denpa.Agent/Cxd2856.cs) / [Cxd2858.cs](../agent/Denpa.Agent/Cxd2858.cs) の `*Rows`・`InputLevel`・`IsdbsCnTable`・`IsdbsCnDb`・`IsdbsLevelDb`・`J83b*`                               | IT930x の機材の復調器とチューナーの初期化・地上波と衛星と J.83B の選局・スリープ・強度と C/N の計算 (仕様書の式)・衛星の C/N の表 (仕様書の付録 A)                                                                                   | クリーンルームで書いた仕様書 (denpa-spec の `cxd2856/spec.md`) に値のまま載っていたもの。仕様書は PLEX の公開ドライバー・px4_drv・cxd28xx の値を照らして書いてある (コードは写していない。チップに要る値として扱う)。衛星の C/N の表 (`IsdbsCnTable`) は Sony の表で、PLEX の公開ドライバーと px4_drv に同じ値で載っているもの。J.83B のチャンネルの周波数 (`ChannelTable` の `H01`〜`H105`) も仕様書の値 | px4_drv・cxd28xx は GPL-2.0 (上流)                                                                                |
| TC90522・R850・RT710 の書き込みの値   | [agent/Denpa.Agent/Tc90522.cs](../agent/Denpa.Agent/Tc90522.cs) の `*Rows`、[R850.cs](../agent/Denpa.Agent/R850.cs) の `Initial`・`ByRf`・`Plan`、[Rt710.cs](../agent/Denpa.Agent/Rt710.cs) の `Start*`・`Standby*`・`Gains` | IT930x の機材 (PX-Q3・PX-W3 系と受信機が 1 つの機種) の復調器の起動・選局・スリープ、チューナーの初期値・周波数ごとの値・待機の値・利得の表                                                                                          | クリーンルームで書いた仕様書 (denpa-spec の `tc90522/spec.md`) に値のまま載っていたもの。仕様書は px4_drv・px4-userland・PLEX の公開ドライバー・Linux カーネルの `tc90522.c` の値を照らして書いてある (コードは写していない。チップに要る値として扱う)。C/N の式は上の `Tc90522Db` と同じ                                                                                                                 | px4_drv・Linux カーネルの `tc90522.c` は GPL-2.0 (上流)                                                           |
| MN88472・TDA18250 の書き込みの値      | [agent/Denpa.Agent/Mn88472.cs](../agent/Denpa.Agent/Mn88472.cs) の `Rows`、[Tda18250.cs](../agent/Denpa.Agent/Tda18250.cs) の `InitRows`・`CrystalRow`・`BandRows`・`AgcRows`・`Divider`                                     | Xbox One Digital TV Tuner の復調とチューナーの初期化・ISDB-C の選局・PLL の分周の表・C/N の式                                                                                                                                        | クリーンルームで書いた仕様書に値のまま載っていたもの。仕様書は kiwi-93 の xbox-one-isdbc-dkms と mainline Linux のドライバが書く値を照らして書いてある (コードは写していない。チップに要る値として扱う)                                                                                                                                                                                                   | 元のドライバは GPL-2.0 (上流)                                                                                     |
| エンコード再試行の秒数 (0.2)          | [src/lib/server/config.ts](../src/lib/server/config.ts)                                                                                                                                                                      | 値だけ                                                                                                                                                                                                                               | EPGStation の `enc.js`                                                                                                                                                                                                                                                                                                                                                                                    | MIT (上流)                                                                                                        |
| 局と実況のチャンネルの対応表          | [src/lib/jikkyo/channels.ts](../src/lib/jikkyo/channels.ts) / [terrestrial.ts](../src/lib/jikkyo/terrestrial.ts)                                                                                                             | 局 → NX-Jikkyo のチャンネル (`jk1` など)                                                                                                                                                                                             | BS・CS は自作 (局の番号)。地上波は [KonomiTV](https://github.com/tsukumijima/KonomiTV) の `server/static/jikkyo_channels.json` から、NX-Jikkyo にチャンネルのある系列 (jk1〜14) の行を写した                                                                                                                                                                                                              | 地上波の表は MIT (Copyright (c) 2021-2026 tsukumi。表示は terrestrial.ts の冒頭)、ほかは AGPL (denpa と同じ)      |
| 実況の書き込みとコマンド              | [src/lib/jikkyo/post.ts](../src/lib/jikkyo/post.ts) / [command.ts](../src/lib/jikkyo/command.ts) / [nx.ts](../src/lib/jikkyo/nx.ts)                                                                                          | NX-Jikkyo への書き込みの手順・長さの上限・コマンドの色の表                                                                                                                                                                           | 自作。手順は NX-Jikkyo の Readme の「視聴セッション WebSocket」と `server/app/routers/websocket.py` の `postComment` を、長さの上限は DPlayer (tsukumijima さんの fork) の書き込みの欄の `maxlength`、色・位置・大きさの扱いは KonomiTV の `LiveCommentManager.ts`・`CommentUtils.ts` を読んで合わせた (コードは写していない)。色の値はニコニコのコマンドの色                                             | AGPL (denpa と同じ)                                                                                               |
| アイコン類                            | [static/](../static)                                                                                                                                                                                                         | PWA のアイコン                                                                                                                                                                                                                       | 自作                                                                                                                                                                                                                                                                                                                                                                                                      | AGPL (denpa と同じ)                                                                                               |

## ブラウザへ配る束・サーバの束に入る主なもの

`package.json` に runtime の `dependencies` は無く、adapter-bun が全部を `build/` に
まとめます (イメージにもそれだけを載せる)。**MIT がほとんどで、例外は Apache-2.0 の
`drizzle-orm` と、ISC の Lucide** (アイコンの図形)。

| 名前                                                                | 何に                                                                                                 | 出どころ                                                                            | ライセンス     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------- |
| Svelte / SvelteKit / adapter-bun                                    | 画面・ルーティング・サーバの束                                                                       | <https://github.com/sveltejs>                                                       | MIT            |
| Blades (Pico CSS を引き継いだもの)                                  | 見た目の土台                                                                                         | <https://blades.ninja>                                                              | MIT            |
| drizzle-orm                                                         | SQLite の読み書き (サーバの束)                                                                       | <https://github.com/drizzle-team/drizzle-orm>                                       | **Apache-2.0** |
| Lucide (`@iconify-json/lucide` から、使ったアイコンの `<svg>` だけ) | 画面のアイコン ([player.md](player.md#アイコンは-lucide-を組むときに埋め込みます))                   | <https://lucide.dev>                                                                | **ISC**        |
| unplugin-icons / @iconify/utils (組むときだけ。束には入らない)      | `~icons/*` を Svelte の部品に変える                                                                  | <https://github.com/unplugin/unplugin-icons> / <https://github.com/iconify/iconify> | MIT            |
| cookie / devalue / esm-env / clsx                                   | SvelteKit のランタイム (adapter-bun は静的ファイルを Bun の `routes` で配り、依存を束に持ち込まない) | 各上流                                                                              | MIT            |

**データ放送のエンジン** (`src/lib/bml/`。[stream.md](stream.md#データ放送の統合)) は自前で、依存を持たない。
規格 (ARIB STD-B24・TR-B14・TR-B15) を元に書いた。NVRAM の領域の表・郵便番号の範囲の読み方・
BinaryTable の検索の比べ方・既定のスタイルなど一部は、web-bml の振る舞いを読んで合わせたが、コードは写していない (下の「使っていないもの」)。

### ブラウザへ配るデコーダ

[Dockerfile](../Dockerfile) の `mpeg2wasm` 段で組み、イメージの `/opt/denpa/mpeg2` に置いて
`/api/live/mpeg2/` から配る WebAssembly ([stream.md](stream.md#放送そのままmpeg-2を送る))。
**`--enable-gpl` を付けずに組んでいる**ので、中の FFmpeg は LGPL のまま (denpa 自身は AGPL で、
どちらでも問題は無い)。ソースは Dockerfile が取ってくる FFmpeg の tarball と `wasm/decoder.c`。

| 名前                                                                                                    | 何に                                                            | 出どころ                                        | ライセンス                        |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- | --------------------------------- |
| FFmpeg (libavcodec の mpeg2video・aac・opus デコーダと mpegvideo parser、libswresample・libavutil だけ) | 放送の MPEG-2・AAC と互換モードの Opus をブラウザでデコードする | <https://ffmpeg.org>                            | LGPL-2.1+                         |
| emscripten のローダー (`decoder.mjs` に埋まる実行時の糊)                                                | WASM を worker に読み込む                                       | <https://github.com/emscripten-core/emscripten> | MIT / University of Illinois/NCSA |

## 使っていないもの (書いておく価値のあるもの)

- **web-bml (otya128, MIT)**。2026-10 までデータ放送を描いていた借りもの。自前のエンジン
  (`src/lib/bml/`) に置き換えて外した (es2・crc-32・css・fast-xml-parser・arib-mmt-tlv-ts・fflate も一緒に抜けた)。
  通知の型だけは録画との互換のために写して残している (上の「リポジトリに写してあるもの」)
- **@chinachu/aribts / aribb24.js / mpegts.js / hls.js / shaka-player**。検討したうえで
  自前実装にしたもの ([stream.md](stream.md))
- **@iconify/svelte / lucide-svelte**。アイコンは組むときに埋め込む unplugin-icons にした
  ([player.md](player.md#アイコンは-lucide-を組むときに埋め込みます))。`@iconify/svelte` は既定で
  Iconify の API からアイコンデータを取得し、LAN だけ・オフラインで開けない
- **OIDC のライブラリ**。入れていません ([auth.md](auth.md))
- **recisdb**。選局は自前で ioctl を呼びます。値の出どころとして上に書いてあります
