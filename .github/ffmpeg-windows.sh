#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Windows (x64) 用の ffmpeg / ffprobe を組む。MSYS2 の UCRT64 の中で流す (.github/workflows/windows-server.yml)。
#
#   bash .github/ffmpeg-windows.sh <出力先>
#
# **バージョンと組む部品は Dockerfile の `ffmpeg` 段から読む** (Renovate が上げるのはそちらだけ。
# 部品の一覧を 2 か所に書くと、片方に足し忘れる)。読むのは FFMPEG_VERSION・SVT_AV1_VERSION・OPUS_VERSION と、
# `--enable-<種類>=<名前の並び>` の行。Windows に無いもの (VA-API・Rockchip MPP のエンコーダとフィルタ) は
# configure が黙って外す。NVENC (h264_nvenc など) は Dockerfile の一覧にあるので、Windows でも組まれる。
# patches/ の直しも Linux と同じく当てる。
#
# Linux と同じく、SVT-AV1 と Opus はソースから組んで libavcodec に静的に繋ぎ、x264・dav1d・zimg は配布物
# (MSYS2 のパッケージの DLL。Linux は Debian のもの) を使う。MSYS2 に opus・svt-av1 のパッケージが入っていると、組むときに
# そちらの DLL を拾う。そのため x264 は CLI のパッケージ (MSYS2 の ffmpeg を通して opus・svt-av1 も入れる) ではなく、
# ライブラリだけの libx264 を入れる (.github/workflows/windows-server.yml。zip に入る DLL は、そこの bundle で決めた一覧と比べる)。
# **libav* は Linux と違って静的に繋ぐ** (ffmpeg.exe と ffprobe.exe が
# それぞれ抱える)。DLL にすると、libavfilter の DLL が libavformat の関数 (metadata フィルタの avio_closep) を解決できず組めない
# (Linux の共有ライブラリは解決を実行時まで待つので組める)。
#
# **ffprobe は ffmpeg とは別に、読む部品だけで組む。** 同じ configure で組むと、libavcodec の部品の一覧が全部のエンコーダ
# (SVT-AV1・Opus・x264 と GPU のもの) を指しているので、エンコードしない ffprobe.exe にもそれが静的に入り、ffmpeg.exe と同じ大きさになる。
# ffprobe に入れるのは Dockerfile の一覧のうちデコーダ・デマクサ・パーサ・bsf・プロトコルと、デコーダの使う dav1d・zlib だけで、
# エンコーダ・マクサ・フィルタ・libavfilter・libavdevice は入れない。読める部品が ffmpeg と同じかは、組んだあとで一覧を比べる。
# ライセンスの設定 (`--enable-gpl --enable-version3`) は ffmpeg とそろえる
#
# **自動で見つけるもの (`--disable-autodetect`) は全部切ってから、要るものだけ足す。** 切らないと、MSYS2 に
# 入っているものや Windows の API (Media Foundation・D3D11 など) を configure が勝手に繋ぎ、ランナーの中身しだいで
# 出来上がりが変わる。スレッド (`w32threads`) と zlib (PNG のデコーダが使う) は自動で見つけるものに入っているので、明示する。
#
# **GPU のエンコーダは NVENC・QSV・AMF を組む** (`gpu`。docs/encode.md「Windows でエンコードする」)。どれもドライバのライブラリは
# 実行時に読むので、配布物には足さない。ヘッダとライブラリは MSYS2 のパッケージで、ライセンスは GPL-3.0-or-later のままにできるもの
# (nonfree にしない): nv-codec-headers (MIT。ffnvcodec-headers)、AMF のヘッダ (MIT。amf-headers)、libvpl (MIT。DLL)。
# QSV は Direct3D 11 のデバイスを子にして開くので `--enable-d3d11va` も要る。QSV と AMF のエンコーダは Dockerfile の
# 一覧に無い (Linux は組まない) ので、ここで足す
#
# 出力先には ffmpeg.exe・ffprobe.exe・それらが読む DLL と、licenses/ (同梱したもののライセンスの文書と、
# MSYS2 のパッケージのバージョンの一覧) を置く。DLL は実行ファイルの取り込み表 (objdump) から辿り、
# Windows に最初からあるもの以外で見つからないものがあれば止める
# ---------------------------------------------------------------------------
set -euo pipefail

out=$(realpath -m "$1")
# 2 つ目の引数 (opus か svt-av1) を渡すと、その依存だけ組んで終わる。workflow が組み終えた直後にキャッシュへ保存するため
# (ffmpeg のビルドが落ちても、組み終えた依存は残る)。渡さなければ全部組む
only=${2:-}
root=$(pwd)
# Dockerfile の ffmpeg 段だけを読む (mpeg2wasm 段にも --enable-decoder= の行があるので)
stage=$(awk '/^FROM .* AS ffmpeg$/ { f = 1; next } /^FROM / { f = 0 } f' Dockerfile)
value() { sed -nE "s/^(ARG|ENV) $1=(.+)$/\2/p" <<< "$stage" | head -1; }
FFMPEG_VERSION=$(value FFMPEG_VERSION)
SVT_AV1_VERSION=$(value SVT_AV1_VERSION)
OPUS_VERSION=$(value OPUS_VERSION)
mapfile -t components < <(grep -oE -- '--enable-(decoder|encoder|hwaccel|demuxer|muxer|parser|bsf|filter|indev|protocol)=[^ ]+' <<< "$stage")
gpu=(
  --enable-ffnvcodec
  --enable-nvenc
  --enable-libvpl
  --enable-d3d11va
  --enable-amf
)
# エンコーダは `--disable-everything` より後ろに置く (前に置くと、その場で全部外れる)
gpu_encoders=(
  --enable-encoder=h264_qsv,hevc_qsv,av1_qsv,h264_amf,hevc_amf,av1_amf
)
for name in FFMPEG_VERSION SVT_AV1_VERSION OPUS_VERSION; do
  if [ -z "${!name}" ]; then echo "Dockerfile の ffmpeg 段に $name がありません" >&2; exit 1; fi
done
if [ "${#components[@]}" -lt 10 ]; then echo "Dockerfile の ffmpeg 段から部品の一覧を読めません" >&2; exit 1; fi
echo "ffmpeg ${FFMPEG_VERSION} / SVT-AV1 ${SVT_AV1_VERSION} / Opus ${OPUS_VERSION}"

CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
temp=$(cygpath -u "${RUNNER_TEMP:-/tmp}")
prefix="$temp/ffmpeg-prefix"
probe_prefix="$temp/ffprobe-prefix"
work="$temp/ffmpeg-work"
rm -rf "$prefix" "$probe_prefix" "$work" "$out"
mkdir -p "$prefix" "$probe_prefix" "$work" "$out/licenses"
# Opus と SVT-AV1 は ffmpeg とは別の入れ先 (`deps/<名前>`) に組む (下)
deps="$temp/ffmpeg-deps"
mkdir -p "$deps"
export PKG_CONFIG_PATH="$deps/opus/lib/pkgconfig:$deps/svt-av1/lib/pkgconfig"
jobs=$(nproc)

# ファイルに落としてから開く。パイプで渡すと、ダウンロードが途中で切れたとき、curl の再試行が最初からやり直しても tar は壊れた入力で落ちる
fetch_tar() {
  $CURL -o "$work/src.tar" "$1"
  tar -x"$2" -f "$work/src.tar" --strip-components=1
  rm -f "$work/src.tar"
}

# **Opus と SVT-AV1 は、それぞれ actions/cache に別々に置く** (.github/workflows/windows-server.yml)。キャッシュの鍵は
# バージョンと、`# recipe:<名前>:begin` から `:end` までの組み方。ffmpeg の configure の引数だけを変えたときは、この 2 つを組み直さない。
# 入れ先に `.done` があれば組まない (キャッシュが当たった)。ライセンスの文書も入れ先に置き、最後に出力先へ写す

# recipe:opus:begin
# Opus (Dockerfile と同じく、パケットの欠けを補う機能は既定のまま切って組む)
if { [ -z "$only" ] || [ "$only" = opus ]; } && [ ! -e "$deps/opus/.done" ]; then
  rm -rf "$deps/opus"
  mkdir "$work/opus" && cd "$work/opus"
  fetch_tar "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz" z
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$deps/opus" -DBUILD_SHARED_LIBS=OFF \
    -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
  cmake --build build -j"$jobs"
  cmake --install build
  mkdir -p "$deps/opus/licenses/opus" && cp COPYING "$deps/opus/licenses/opus/"
  touch "$deps/opus/.done"
fi
# recipe:opus:end
if [ "$only" = opus ]; then exit 0; fi

# recipe:svt-av1:begin
# SVT-AV1
if { [ -z "$only" ] || [ "$only" = svt-av1 ]; } && [ ! -e "$deps/svt-av1/.done" ]; then
  rm -rf "$deps/svt-av1"
  mkdir "$work/svtav1" && cd "$work/svtav1"
  fetch_tar "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz" z
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$deps/svt-av1" -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF
  cmake --build build -j"$jobs"
  cmake --install build
  mkdir -p "$deps/svt-av1/licenses/svt-av1" && cp LICENSE.md PATENTS.md "$deps/svt-av1/licenses/svt-av1/"
  touch "$deps/svt-av1/.done"
fi
# recipe:svt-av1:end
if [ "$only" = svt-av1 ]; then exit 0; fi
cp -r "$deps/opus/licenses/." "$deps/svt-av1/licenses/." "$out/licenses/"

# FFmpeg (キャッシュの鍵はこのスクリプト全体。ここから下を変えても、上の Opus と SVT-AV1 は組み直さない)。
# ffmpeg と ffprobe は同じソースから、別々の場所で組む (configure の出力をソースの中に書かない)
src="$work/ffmpeg"
mkdir "$src" && cd "$src"
fetch_tar "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" j
for p in "$root"/patches/ffmpeg-*.patch; do [ -e "$p" ] || continue; patch -p1 --fuzz=0 < "$p"; done
mkdir "$work/build-ffmpeg" && cd "$work/build-ffmpeg"
"$src/configure" \
  --prefix="$prefix" \
  --enable-gpl \
  --enable-version3 \
  --disable-shared \
  --enable-static \
  --pkg-config-flags="--static" \
  --disable-autodetect \
  --enable-w32threads \
  --enable-zlib \
  --enable-libopus \
  --enable-libsvtav1 \
  --enable-libx264 \
  --enable-libdav1d \
  --enable-libzimg \
  "${gpu[@]}" \
  --disable-ffprobe \
  --disable-everything \
  --disable-network \
  --disable-doc \
  "${components[@]}" \
  "${gpu_encoders[@]}"
make -j"$jobs"
make install
# GPU のエンコーダが組み込まれているか (GPU が無いランナーでも `-encoders` には載る)。無ければ configure が黙って外している
encoders=$("$prefix/bin/ffmpeg.exe" -hide_banner -encoders)
for e in h264_nvenc hevc_nvenc av1_nvenc h264_qsv hevc_qsv av1_qsv h264_amf hevc_amf av1_amf; do
  grep -qw "$e" <<< "$encoders" || { echo "ffmpeg に $e が組み込まれていません" >&2; exit 1; }
done
# 4K の局の HLG を SDR に直すフィルタ (uhd.HLG_TO_SDR)。zscale は libzimg が無いと configure が黙って外す
filters=$("$prefix/bin/ffmpeg.exe" -hide_banner -filters)
for f in setparams zscale tonemap; do
  grep -qw "$f" <<< "$filters" || { echo "ffmpeg に $f が組み込まれていません" >&2; exit 1; }
done
mkdir -p "$out/licenses/ffmpeg" && cp "$src/COPYING.GPLv3" "$src/LICENSE.md" "$out/licenses/ffmpeg/"

# ffprobe (読む部品だけ。冒頭の説明)
mapfile -t probe_components < <(printf '%s\n' "${components[@]}" | grep -E -- '^--enable-(decoder|demuxer|parser|bsf|protocol)=')
mkdir "$work/build-ffprobe" && cd "$work/build-ffprobe"
"$src/configure" \
  --prefix="$probe_prefix" \
  --enable-gpl \
  --enable-version3 \
  --disable-shared \
  --enable-static \
  --pkg-config-flags="--static" \
  --disable-autodetect \
  --enable-w32threads \
  --enable-zlib \
  --enable-libdav1d \
  --disable-programs \
  --enable-ffprobe \
  --disable-avdevice \
  --disable-avfilter \
  --disable-everything \
  --disable-network \
  --disable-doc \
  "${probe_components[@]}"
make -j"$jobs"
make install
# ffprobe が読める部品が ffmpeg と同じか (configure は、組めない部品を黙って外す)。デコーダとデマクサは行ごと比べる
# (名前・説明・印が同じになる)。lavfi は ffmpeg の入力の装置 (libavdevice) で、`-demuxers` に載るが ffprobe には組まない。
# bsf は、ffmpeg にはマクサとエンコーダが自分で足すもの (mpegts の hevc_mp4toannexb など) も載るので、Dockerfile の一覧にあるものだけを見る
for kind in decoders demuxers; do
  missing=$(comm -23 <("$prefix/bin/ffmpeg.exe" -hide_banner "-$kind" | tr -d '\r' | LC_ALL=C sort) \
    <("$probe_prefix/bin/ffprobe.exe" -hide_banner "-$kind" | tr -d '\r' | LC_ALL=C sort) | grep -vw lavfi || true)
  if [ -n "$missing" ]; then
    echo "ffprobe に、ffmpeg にある $kind がありません:" >&2
    echo "$missing" >&2
    exit 1
  fi
done
bsfs=$("$probe_prefix/bin/ffprobe.exe" -hide_banner -bsfs | tr -d '\r')
for b in $(printf '%s\n' "${probe_components[@]}" | sed -nE 's/^--enable-bsf=//p' | tr ',' ' '); do
  grep -qx "$b" <<< "$bsfs" || { echo "ffprobe に bsf の $b が組み込まれていません" >&2; exit 1; }
done

# 実行ファイルと、それが読む DLL。DLL は取り込み表から辿る (Windows の API の集まり api-ms-win-* と、
# System32 にあるものは置かない)。見つからないものがあれば止める (起動してからエンコードで落ちるより早く分かる)
cp "$prefix/bin/ffmpeg.exe" "$probe_prefix/bin/ffprobe.exe" "$out/"
declare -A seen=()
queue=("$out/ffmpeg.exe" "$out/ffprobe.exe")
from_msys=()
while [ "${#queue[@]}" -gt 0 ]; do
  file=${queue[0]}
  queue=("${queue[@]:1}")
  while read -r dll; do
    key=${dll,,}
    [ -n "${seen[$key]:-}" ] && continue
    seen[$key]=1
    case "$key" in api-ms-win-* | ext-ms-*) continue ;; esac
    if [ -e "$prefix/bin/$dll" ]; then
      cp "$prefix/bin/$dll" "$out/"
    elif [ -e "/ucrt64/bin/$dll" ]; then
      cp "/ucrt64/bin/$dll" "$out/"
      from_msys+=("/ucrt64/bin/$dll")
    elif [ -n "$(find /c/Windows/System32 -maxdepth 1 -iname "$dll" -print -quit)" ]; then
      continue
    else
      echo "$(basename "$file") が読む $dll が見つかりません" >&2
      exit 1
    fi
    queue+=("$out/$dll")
  done < <(objdump -p "$file" | sed -nE 's/^\s*DLL Name: (.+)$/\1/p' | tr -d '\r')
done

# MSYS2 から写した DLL と、静的に繋いだ MSYS2 のライブラリのパッケージの、ライセンスの文書とバージョン
for lib in lib/libx264.a lib/libdav1d.a lib/libzimg.a lib/libz.a lib/libwinpthread.a lib/libvpl.a include/ffnvcodec/nvEncodeAPI.h include/AMF/core/Version.h; do
  if [ -e "/ucrt64/$lib" ]; then from_msys+=("/ucrt64/$lib"); fi
done
: > "$out/licenses/msys2-packages.txt"
for file in "${from_msys[@]}"; do
  name=
  pkg=$(pacman -Qqo "$file")
  pacman -Q "$pkg" >> "$out/licenses/msys2-packages.txt"
  mapfile -t texts < <(pacman -Qlq "$pkg" | grep -E '/share/licenses/.+[^/]$' || true)
  # ライブラリだけを分けたパッケージ (libx264) は、文書を元のパッケージ (x264) が持っている
  base=${pkg/x86_64-lib/x86_64-}
  if [ "${#texts[@]}" -eq 0 ] && [ "$base" != "$pkg" ] && pacman -Q "$base" > /dev/null 2>&1; then
    mapfile -t texts < <(pacman -Qlq "$base" | grep -E '/share/licenses/.+[^/]$' || true)
  fi
  # それでも無ければ、名前の似た文書の置き場 (libwinpthread → /ucrt64/share/licenses/winpthreads など) を探す
  if [ "${#texts[@]}" -eq 0 ]; then
    name=${pkg#mingw-w64-ucrt-x86_64-}
    name=${name#lib}
    name=${name%-git}
    mapfile -t texts < <(find /ucrt64/share/licenses -type f -ipath "*/${name}*/*" 2>/dev/null || true)
  fi
  # x264 は MSYS2 のパッケージに文書が入っていない。ライセンスは GPL-2.0-or-later だけなので、FFmpeg のソースにある GPLv2 の文を置く
  if [ "${#texts[@]}" -eq 0 ] && [ "${name:-}" = x264 ]; then texts=("$work/ffmpeg/COPYING.GPLv2"); fi
  # zimg も MSYS2 のパッケージに文書が入っていない。上流の同じバージョンのタグ (release-<バージョン>) から COPYING (WTFPL) を取る
  if [ "${#texts[@]}" -eq 0 ] && [ "${name:-}" = zimg ]; then
    version=$(pacman -Q "$pkg" | awk '{ print $2 }')
    version=${version%-*}
    mkdir -p "$work/zimg-license"
    $CURL -o "$work/zimg-license/COPYING" "https://raw.githubusercontent.com/sekrit-twc/zimg/release-${version}/COPYING"
    texts=("$work/zimg-license/COPYING")
  fi
  # winpthreads は MinGW-w64 の一部で、文書は MinGW-w64 の CRT のパッケージにある
  if [ "${#texts[@]}" -eq 0 ] && [[ "${name:-}" == winpthread* ]]; then
    mapfile -t texts < <(find /ucrt64/share/licenses/crt -type f 2>/dev/null || true)
  fi
  if [ "${#texts[@]}" -eq 0 ]; then
    echo "$pkg にライセンスの文書がありません (/ucrt64/share/licenses の中身: $(ls /ucrt64/share/licenses | tr '\n' ' '))" >&2
    exit 1
  fi
  mkdir -p "$out/licenses/${pkg#mingw-w64-ucrt-x86_64-}"
  cp "${texts[@]}" "$out/licenses/${pkg#mingw-w64-ucrt-x86_64-}/"
done
sort -u -o "$out/licenses/msys2-packages.txt" "$out/licenses/msys2-packages.txt"
printf 'ffmpeg %s\nSVT-AV1 %s\nOpus %s\n' "$FFMPEG_VERSION" "$SVT_AV1_VERSION" "$OPUS_VERSION" > "$out/licenses/versions.txt"

# 置いたものだけで動くか (MSYS2 の DLL の置き場を PATH から外す)。エンコーダは試しに 1 秒ずつ流す
cd "$out"
export PATH="/c/Windows/System32:/c/Windows"
./ffmpeg.exe -hide_banner -version
./ffprobe.exe -hide_banner -loglevel error -version > /dev/null
# SVT-AV1 が Dockerfile と同じバージョンか (preset と crf の効き方はバージョンで変わる。src/lib/server/encoder.ts)。
# SVT-AV1 が標準エラーに出すバージョンの行で見る
./ffmpeg.exe -hide_banner -loglevel error -f lavfi -i testsrc2=s=320x240:r=30:d=1 -f lavfi -i sine=d=1 \
  -c:v libsvtav1 -preset 12 -c:a libopus -f matroska -y "$work/av1.mkv" 2> "$work/av1.log" || { /usr/bin/cat "$work/av1.log" >&2; exit 1; }
/usr/bin/grep -qF "SVT-AV1 Encoder Lib ${SVT_AV1_VERSION}" "$work/av1.log" || {
  /usr/bin/cat "$work/av1.log" >&2
  echo "ffmpeg が読む SVT-AV1 が ${SVT_AV1_VERSION} ではありません" >&2
  exit 1
}
./ffmpeg.exe -hide_banner -loglevel error -f lavfi -i testsrc2=s=320x240:r=30:d=1 -c:v libx264 -f null -
./ffmpeg.exe -hide_banner -loglevel error -c:v libdav1d -i "$work/av1.mkv" -f null -
/usr/bin/ls -la "$out"
