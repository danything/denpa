#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Windows (x64) 用の ffmpeg / ffprobe を組む。MSYS2 の UCRT64 の中で流す (.github/workflows/windows-server.yml)。
#
#   bash .github/ffmpeg-windows.sh <出力先>
#
# **バージョンと組む部品は Dockerfile の `ffmpeg` 段から読む** (Renovate が上げるのはそちらだけ。
# 部品の一覧を 2 か所に書くと、片方に足し忘れる)。読むのは FFMPEG_VERSION・SVT_AV1_VERSION・OPUS_VERSION と、
# `--enable-<種類>=<名前の並び>` の行。Windows に無いもの (VA-API・NVENC・Rockchip MPP のエンコーダとフィルタ) は
# configure が黙って外す。patches/ の直しも Linux と同じく当てる。
#
# Linux と同じく、SVT-AV1 と Opus はソースから組んで libavcodec に静的に繋ぎ、x264 と dav1d は配布物
# (MSYS2 のパッケージ。Linux は Debian のもの) を使う。**libav* は Linux と違って静的に繋ぐ** (ffmpeg.exe と ffprobe.exe が
# それぞれ抱える)。DLL にすると、libavfilter の DLL が libavformat の関数 (metadata フィルタの avio_closep) を解決できず組めない
# (Linux の共有ライブラリは解決を実行時まで待つので組める)。
#
# **自動で見つけるもの (`--disable-autodetect`) は全部切ってから、要るものだけ足す。** 切らないと、MSYS2 に
# 入っているものや Windows の API (Media Foundation・D3D11 など) を configure が勝手に繋ぎ、ランナーの中身しだいで
# 出来上がりが変わる。スレッド (`w32threads`) と zlib (PNG のデコーダが使う) は自動で見つけるものに入っているので、明示する。
# GPU のエンコーダ (NVENC・QSV・AMF) はまだ組まない (足すときは、ここに `--enable-…` を足す)
#
# 出力先には ffmpeg.exe・ffprobe.exe・それらが読む DLL と、licenses/ (同梱したもののライセンスの文書と、
# MSYS2 のパッケージのバージョンの一覧) を置く。DLL は実行ファイルの取り込み表 (objdump) から辿り、
# Windows に最初からあるもの以外で見つからないものがあれば止める
# ---------------------------------------------------------------------------
set -euo pipefail

out=$(realpath -m "$1")
root=$(pwd)
# Dockerfile の ffmpeg 段だけを読む (mpeg2wasm 段にも --enable-decoder= の行があるので)
stage=$(awk '/^FROM .* AS ffmpeg$/ { f = 1; next } /^FROM / { f = 0 } f' Dockerfile)
value() { sed -nE "s/^(ARG|ENV) $1=(.+)$/\2/p" <<< "$stage" | head -1; }
FFMPEG_VERSION=$(value FFMPEG_VERSION)
SVT_AV1_VERSION=$(value SVT_AV1_VERSION)
OPUS_VERSION=$(value OPUS_VERSION)
mapfile -t components < <(grep -oE -- '--enable-(decoder|encoder|hwaccel|demuxer|muxer|parser|bsf|filter|indev|protocol)=[^ ]+' <<< "$stage")
for name in FFMPEG_VERSION SVT_AV1_VERSION OPUS_VERSION; do
  if [ -z "${!name}" ]; then echo "Dockerfile の ffmpeg 段に $name がありません" >&2; exit 1; fi
done
if [ "${#components[@]}" -lt 10 ]; then echo "Dockerfile の ffmpeg 段から部品の一覧を読めません" >&2; exit 1; fi
echo "ffmpeg ${FFMPEG_VERSION} / SVT-AV1 ${SVT_AV1_VERSION} / Opus ${OPUS_VERSION}"

CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
temp=$(cygpath -u "${RUNNER_TEMP:-/tmp}")
prefix="$temp/ffmpeg-prefix"
work="$temp/ffmpeg-work"
rm -rf "$prefix" "$work" "$out"
mkdir -p "$prefix" "$work" "$out/licenses"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
jobs=$(nproc)

# Opus (Dockerfile と同じく、パケットの欠けを補う機能は既定のまま切って組む)
mkdir "$work/opus" && cd "$work/opus"
$CURL "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz" | tar -xz --strip-components=1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF \
  -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
cmake --build build -j"$jobs"
cmake --install build
mkdir -p "$out/licenses/opus" && cp COPYING "$out/licenses/opus/"

# SVT-AV1
mkdir "$work/svtav1" && cd "$work/svtav1"
$CURL "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz" | tar -xz --strip-components=1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF
cmake --build build -j"$jobs"
cmake --install build
mkdir -p "$out/licenses/svt-av1" && cp LICENSE.md PATENTS.md "$out/licenses/svt-av1/"

# FFmpeg
mkdir "$work/ffmpeg" && cd "$work/ffmpeg"
$CURL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" | tar -xj --strip-components=1
for p in "$root"/patches/ffmpeg-*.patch; do [ -e "$p" ] || continue; patch -p1 --fuzz=0 < "$p"; done
./configure \
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
  --disable-everything \
  --disable-network \
  --disable-doc \
  "${components[@]}"
make -j"$jobs"
make install
mkdir -p "$out/licenses/ffmpeg" && cp COPYING.GPLv3 LICENSE.md "$out/licenses/ffmpeg/"

# 実行ファイルと、それが読む DLL。DLL は取り込み表から辿る (Windows の API の集まり api-ms-win-* と、
# System32 にあるものは置かない)。見つからないものがあれば止める (起動してからエンコードで落ちるより早く分かる)
cp "$prefix/bin/ffmpeg.exe" "$prefix/bin/ffprobe.exe" "$out/"
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
for lib in libx264.a libdav1d.a libz.a libwinpthread.a; do
  if [ -e "/ucrt64/lib/$lib" ]; then from_msys+=("/ucrt64/lib/$lib"); fi
done
: > "$out/licenses/msys2-packages.txt"
for file in "${from_msys[@]}"; do
  pkg=$(pacman -Qqo "$file")
  pacman -Q "$pkg" >> "$out/licenses/msys2-packages.txt"
  mapfile -t texts < <(pacman -Qlq "$pkg" | grep -E '/share/licenses/.+[^/]$' || true)
  if [ "${#texts[@]}" -eq 0 ]; then echo "$pkg にライセンスの文書がありません" >&2; exit 1; fi
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
./ffmpeg.exe -hide_banner -loglevel error -f lavfi -i testsrc2=s=320x240:r=30:d=1 -f lavfi -i sine=d=1 \
  -c:v libsvtav1 -preset 12 -c:a libopus -f matroska -y "$work/av1.mkv"
./ffmpeg.exe -hide_banner -loglevel error -f lavfi -i testsrc2=s=320x240:r=30:d=1 -c:v libx264 -f null -
./ffmpeg.exe -hide_banner -loglevel error -c:v libdav1d -i "$work/av1.mkv" -f null -
/usr/bin/ls -la "$out"
