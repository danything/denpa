#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Mac (Apple Silicon) 用の ffmpeg / ffprobe を組む。CI の macOS のランナーで流す (.github/workflows/macos-server.yml)。
#
#   bash .github/ffmpeg-macos.sh <出力先> [opus | svt-av1 | x264 | dav1d | zimg]
#
# **バージョンと組む部品は Dockerfile の `ffmpeg` 段から読む** (.github/ffmpeg-windows.sh と同じ。部品の一覧を 2 か所に書くと、
# 片方に足し忘れる)。読むのは FFMPEG_VERSION・SVT_AV1_VERSION・OPUS_VERSION と、`--enable-<種類>=<名前の並び>` の行。
# Mac に無いもの (VA-API・NVENC・Rockchip MPP のエンコーダとフィルタ) は configure が黙って外す。patches/ の直しも Linux と同じく当てる。
# 設定は Linux と同じ `--enable-gpl --enable-version3` (GPL-3.0-or-later)。nonfree は入れない。
#
# **依存は全部ソースから組み、静的に繋ぐ。** Linux は x264 と dav1d を Debian の、Windows は MSYS2 のパッケージから取るが、
# Mac の Homebrew のものは Homebrew の置き場 (/opt/homebrew) に繋がり、Homebrew の無い Mac では動かない。
# x264・dav1d・zimg のバージョンは、Linux のイメージ (Debian trixie のパッケージ) と同じものにそろえる (下の X264_COMMIT・DAV1D_VERSION・ZIMG_VERSION。
# Dockerfile の土台の Debian を上げたら、ここも合わせる)。libav* も静的に繋ぐ (ffmpeg と ffprobe がそれぞれ抱える。Windows と同じ)。
# **ffprobe は ffmpeg とは別に、読む部品だけで組む** (.github/ffmpeg-windows.sh と同じ。エンコーダが ffprobe にも静的に入らないように)。
# 出来上がりが繋ぐのは macOS に最初からあるもの (/usr/lib と /System/Library) だけで、ほかに繋いでいれば止める。
#
# **自動で見つけるもの (`--disable-autodetect`) は全部切ってから、要るものだけ足す** (Windows と同じ理由。ランナーに入っているもので
# 出来上がりが変わらないように)。スレッド (`pthreads`) と zlib (PNG のデコーダが使う。macOS の /usr/lib/libz) は明示する。
#
# **GPU のエンコーダは VideoToolbox を組む** (h264_videotoolbox・hevc_videotoolbox。docs/encode.md「Mac でエンコードする」)。
# VideoToolbox は macOS の一部で、配布物には何も足さない。Dockerfile の一覧に無い (Linux は組まない) ので、ここで足す。
#
# 出力先には ffmpeg・ffprobe (ad-hoc 署名 `codesign -s -`) と licenses/ (同梱したもののライセンスの文書と、バージョンの一覧) を置く。
# 依存の組み上がりは `deps/<名前>` に置き、workflow が actions/cache に別々に置く (`# recipe:<名前>:begin` から `:end` までが鍵)。
# 2 つ目の引数に名前を渡すと、その依存だけ組んで終わる (workflow が組み終えた直後に保存するため)。入れ先に `.done` があれば組まない。
#
# macOS の /bin/bash は 3.2 なので、4 以降の書き方 (連想配列・mapfile など) は使わない (ランナーの bash が新しくても)。
# ---------------------------------------------------------------------------
set -euo pipefail

mkdir -p "$1"
out=$(cd "$1" && pwd)
only=${2:-}
root=$(pwd)
# Dockerfile の ffmpeg 段だけを読む (mpeg2wasm 段にも --enable-decoder= の行があるので)
stage=$(awk '/^FROM .* AS ffmpeg$/ { f = 1; next } /^FROM / { f = 0 } f' Dockerfile)
value() { sed -nE "s/^(ARG|ENV) $1=(.+)$/\2/p" <<< "$stage" | head -1; }
FFMPEG_VERSION=$(value FFMPEG_VERSION)
SVT_AV1_VERSION=$(value SVT_AV1_VERSION)
OPUS_VERSION=$(value OPUS_VERSION)
components=()
while IFS= read -r line; do components+=("$line"); done < <(
  grep -oE -- '--enable-(decoder|encoder|hwaccel|demuxer|muxer|parser|bsf|filter|indev|protocol)=[^ ]+' <<< "$stage"
)
for name in FFMPEG_VERSION SVT_AV1_VERSION OPUS_VERSION; do
  if [ -z "${!name}" ]; then echo "Dockerfile の ffmpeg 段に $name がありません" >&2; exit 1; fi
done
if [ "${#components[@]}" -lt 10 ]; then echo "Dockerfile の ffmpeg 段から部品の一覧を読めません" >&2; exit 1; fi
echo "ffmpeg ${FFMPEG_VERSION} / SVT-AV1 ${SVT_AV1_VERSION} / Opus ${OPUS_VERSION}"

# 組んだものが動く macOS の下限。ランナーの SDK の既定 (ランナーの macOS) のままだと、それより古い macOS で起動できない
export MACOSX_DEPLOYMENT_TARGET=13.0
CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
temp=${RUNNER_TEMP:-/tmp}
prefix="$temp/ffmpeg-prefix"
probe_prefix="$temp/ffprobe-prefix"
work="$temp/ffmpeg-work"
deps="$temp/ffmpeg-deps"
rm -rf "$prefix" "$probe_prefix" "$work"
mkdir -p "$prefix" "$probe_prefix" "$work" "$deps"
# pkg-config は組んだ依存だけを見る (Homebrew の .pc を拾わない)
export PKG_CONFIG_LIBDIR="$deps/opus/lib/pkgconfig:$deps/svt-av1/lib/pkgconfig:$deps/x264/lib/pkgconfig:$deps/dav1d/lib/pkgconfig:$deps/zimg/lib/pkgconfig"
jobs=$(sysctl -n hw.ncpu)

# ファイルに落としてから開く (パイプで渡すと、途中で切れたダウンロードを curl が最初から取り直しても tar は壊れた入力で落ちる)
fetch_tar() {
  $CURL -o "$work/src.tar" "$1"
  tar -x"$2" -f "$work/src.tar" --strip-components=1
  rm -f "$work/src.tar"
}

# x264 のソース。code.videolan.org に届かないときは、GitHub のミラー (mirror/x264。同じコミット) から取る。
# 2026-11-14 に code.videolan.org へ繋がらず、Android の ffmpeg が組めなかった
fetch_x264() {
  if ! $CURL -o "$work/src.tar" "https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/x264-${X264_COMMIT}.tar.bz2"; then
    echo "code.videolan.org から x264 を取れないので、GitHub のミラーから取ります" >&2
    $CURL -o "$work/src.tar" "https://github.com/mirror/x264/archive/${X264_COMMIT}.tar.gz"
  fi
  # bzip2 か gzip かは tar が中身で見分ける (GNU tar も bsdtar も、ファイルから読むときは見分ける)
  tar -xf "$work/src.tar" --strip-components=1
  rm -f "$work/src.tar"
}
# この依存を組むか (引数で 1 つだけ頼まれたら、それだけ)。組み上がり (`.done`) があれば組まない
want() { { [ -z "$only" ] || [ "$only" = "$1" ]; } && [ ! -e "$deps/$1/.done" ]; }

# recipe:opus:begin
# Opus (Dockerfile と同じく、パケットの欠けを補う機能は既定のまま切って組む)
if want opus; then
  rm -rf "$deps/opus"
  mkdir "$work/opus" && cd "$work/opus"
  fetch_tar "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz" z
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$deps/opus" -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
  cmake --build build -j"$jobs"
  cmake --install build
  mkdir -p "$deps/opus/licenses/opus" && cp COPYING "$deps/opus/licenses/opus/"
  touch "$deps/opus/.done"
fi
# recipe:opus:end
if [ "$only" = opus ]; then exit 0; fi

# recipe:svt-av1:begin
# SVT-AV1
if want svt-av1; then
  rm -rf "$deps/svt-av1"
  mkdir "$work/svtav1" && cd "$work/svtav1"
  fetch_tar "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz" z
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$deps/svt-av1" -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF
  cmake --build build -j"$jobs"
  cmake --install build
  mkdir -p "$deps/svt-av1/licenses/svt-av1" && cp LICENSE.md PATENTS.md "$deps/svt-av1/licenses/svt-av1/"
  touch "$deps/svt-av1/.done"
fi
# recipe:svt-av1:end
if [ "$only" = svt-av1 ]; then exit 0; fi

# recipe:x264:begin
# x264。Debian trixie の libx264 (2:0.164.3108+git31e19f9) と同じコミット。コマンドの x264 は組まない
X264_COMMIT=31e19f92f00c7003fa115047ce50978bc98c3a0d
if want x264; then
  rm -rf "$deps/x264"
  mkdir "$work/x264" && cd "$work/x264"
  fetch_x264
  ./configure --prefix="$deps/x264" --enable-static --enable-pic --disable-cli
  make -j"$jobs"
  make install
  mkdir -p "$deps/x264/licenses/x264" && cp COPYING "$deps/x264/licenses/x264/"
  touch "$deps/x264/.done"
fi
# recipe:x264:end
if [ "$only" = x264 ]; then exit 0; fi

# recipe:dav1d:begin
# dav1d。Debian trixie の libdav1d と同じバージョン。コマンドとテストは組まない
DAV1D_VERSION=1.5.1
if want dav1d; then
  rm -rf "$deps/dav1d"
  mkdir "$work/dav1d" && cd "$work/dav1d"
  fetch_tar "https://downloads.videolan.org/pub/videolan/dav1d/${DAV1D_VERSION}/dav1d-${DAV1D_VERSION}.tar.xz" J
  meson setup build --buildtype=release --default-library=static --prefix="$deps/dav1d" --libdir=lib \
    -Denable_tools=false -Denable_tests=false
  meson compile -C build
  meson install -C build
  mkdir -p "$deps/dav1d/licenses/dav1d" && cp COPYING "$deps/dav1d/licenses/dav1d/"
  touch "$deps/dav1d/.done"
fi
# recipe:dav1d:end
if [ "$only" = dav1d ]; then exit 0; fi

# recipe:zimg:begin
# zimg (zscale が使う。4K の局の HLG を SDR に直す uhd.HLG_TO_SDR)。Debian trixie の libzimg と同じバージョン。
# リリースの tarball に configure は無いので autoreconf で作る。C++ のライブラリなので、静的に繋ぐときに要る C++ の標準ライブラリを
# macOS のもの (libc++) にする (zimg.pc の Libs.private。既定は -lstdc++ で、macOS の SDK には無い)
ZIMG_VERSION=3.0.5
if want zimg; then
  rm -rf "$deps/zimg"
  mkdir "$work/zimg" && cd "$work/zimg"
  fetch_tar "https://github.com/sekrit-twc/zimg/archive/refs/tags/release-${ZIMG_VERSION}.tar.gz" z
  LIBTOOLIZE=glibtoolize ./autogen.sh
  ./configure --prefix="$deps/zimg" --libdir="$deps/zimg/lib" --enable-static --disable-shared STL_LIBS=-lc++
  make -j"$jobs"
  make install
  mkdir -p "$deps/zimg/licenses/zimg" && cp COPYING "$deps/zimg/licenses/zimg/"
  touch "$deps/zimg/.done"
fi
# recipe:zimg:end
if [ "$only" = zimg ]; then exit 0; fi

rm -rf "$out"
mkdir -p "$out/licenses"
for dep in opus svt-av1 x264 dav1d zimg; do cp -R "$deps/$dep/licenses/." "$out/licenses/"; done

# FFmpeg (キャッシュの鍵はこのスクリプト全体。ここから下を変えても、上の依存は組み直さない)。
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
  --enable-pthreads \
  --enable-zlib \
  --enable-libopus \
  --enable-libsvtav1 \
  --enable-libx264 \
  --enable-libdav1d \
  --enable-libzimg \
  --enable-videotoolbox \
  --disable-ffprobe \
  --disable-everything \
  --disable-network \
  --disable-doc \
  "${components[@]}" \
  --enable-encoder=h264_videotoolbox,hevc_videotoolbox
make -j"$jobs"
make install
# VideoToolbox のエンコーダが組み込まれているか (GPU の見えないランナーでも `-encoders` には載る)。無ければ configure が黙って外している
encoders=$("$prefix/bin/ffmpeg" -hide_banner -encoders)
for e in h264_videotoolbox hevc_videotoolbox libx264 libsvtav1 libopus; do
  grep -qw "$e" <<< "$encoders" || { echo "ffmpeg に $e が組み込まれていません" >&2; exit 1; }
done
# 4K の局の HLG を SDR に直すフィルタ (uhd.HLG_TO_SDR)。zscale は libzimg が無いと configure が黙って外す
filters=$("$prefix/bin/ffmpeg" -hide_banner -filters)
for f in setparams zscale tonemap; do
  grep -qw "$f" <<< "$filters" || { echo "ffmpeg に $f が組み込まれていません" >&2; exit 1; }
done
mkdir -p "$out/licenses/ffmpeg" && cp "$src/COPYING.GPLv3" "$src/LICENSE.md" "$out/licenses/ffmpeg/"

# ffprobe。読む部品 (Dockerfile の一覧のうちデコーダ・デマクサ・パーサ・bsf・プロトコル) と、デコーダの使う dav1d・zlib だけで組む。
# エンコーダ・マクサ・フィルタ・libavfilter・libavdevice は入れない。ライセンスの設定は ffmpeg とそろえる
probe_components=()
while IFS= read -r line; do probe_components+=("$line"); done < <(
  printf '%s\n' "${components[@]}" | grep -E -- '^--enable-(decoder|demuxer|parser|bsf|protocol)='
)
mkdir "$work/build-ffprobe" && cd "$work/build-ffprobe"
"$src/configure" \
  --prefix="$probe_prefix" \
  --enable-gpl \
  --enable-version3 \
  --disable-shared \
  --enable-static \
  --pkg-config-flags="--static" \
  --disable-autodetect \
  --enable-pthreads \
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
# ffprobe が読める部品が ffmpeg と同じか (.github/ffmpeg-windows.sh と同じ見方。lavfi は ffmpeg の入力の装置で、ffprobe には組まない。
# bsf はマクサとエンコーダが自分で足すものが ffmpeg に載るので、Dockerfile の一覧にあるものだけを見る)
for kind in decoders demuxers; do
  missing=$(comm -23 <("$prefix/bin/ffmpeg" -hide_banner "-$kind" | LC_ALL=C sort) \
    <("$probe_prefix/bin/ffprobe" -hide_banner "-$kind" | LC_ALL=C sort) | grep -vw lavfi || true)
  if [ -n "$missing" ]; then
    echo "ffprobe に、ffmpeg にある $kind がありません:" >&2
    echo "$missing" >&2
    exit 1
  fi
done
bsfs=$("$probe_prefix/bin/ffprobe" -hide_banner -bsfs)
for b in $(printf '%s\n' "${probe_components[@]}" | sed -nE 's/^--enable-bsf=//p' | tr ',' ' '); do
  grep -qx "$b" <<< "$bsfs" || { echo "ffprobe に bsf の $b が組み込まれていません" >&2; exit 1; }
done
cp "$prefix/bin/ffmpeg" "$probe_prefix/bin/ffprobe" "$out/"

# 繋いでいるのが macOS に最初からあるものだけか (組んだ依存も Homebrew のものも、外のライブラリとして残っていないか)
for bin in ffmpeg ffprobe; do
  otool -L "$out/$bin"
  if otool -L "$out/$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
    echo "$bin が macOS の外のライブラリに繋いでいます" >&2
    exit 1
  fi
done
# ad-hoc 署名 (Apple Silicon は署名の無い実行ファイルを起動しない。リンカが付けた署名を、codesign の署名に付け直す)
codesign --force -s - "$out/ffmpeg" "$out/ffprobe"
codesign -v "$out/ffmpeg" "$out/ffprobe"

printf 'ffmpeg %s\nSVT-AV1 %s\nOpus %s\nx264 %s\ndav1d %s\nzimg %s\n' \
  "$FFMPEG_VERSION" "$SVT_AV1_VERSION" "$OPUS_VERSION" "$X264_COMMIT" "$DAV1D_VERSION" "$ZIMG_VERSION" > "$out/licenses/versions.txt"

# 動くか。エンコーダは試しに 1 秒ずつ流す
cd "$out"
./ffmpeg -hide_banner -version
./ffprobe -hide_banner -loglevel error -version > /dev/null
./ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=s=320x240:r=30:d=1 -f lavfi -i sine=d=1 \
  -c:v libsvtav1 -preset 12 -c:a libopus -f matroska -y "$work/av1.mkv"
./ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=s=320x240:r=30:d=1 -c:v libx264 -f null -
./ffmpeg -hide_banner -loglevel error -c:v libdav1d -i "$work/av1.mkv" -f null -
ls -la "$out"
