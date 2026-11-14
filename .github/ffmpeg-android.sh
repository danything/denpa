  # bzip2 か gzip かは tar が中身で見分ける (GNU tar も bsdtar も、ファイルから読むときは見分ける)
  tar -xf "$work/src.tar" --strip-components=1
#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリに入れる ffmpeg / ffprobe を NDK で組む (.github/workflows/android.yml)。
#
#   ANDROID_NDK_ROOT=<NDK> bash .github/ffmpeg-android.sh <入れ先> <arm64 | x86_64> [opus | svt-av1 | x264 | dav1d | zimg]
#
# **バージョンと組む部品は Dockerfile の `ffmpeg` 段から読む** (.github/ffmpeg-macos.sh と同じ。部品の一覧を 2 か所に書くと、
# 片方に足し忘れる)。読むのは FFMPEG_VERSION・SVT_AV1_VERSION・OPUS_VERSION と、`--enable-<種類>=<名前の並び>` の行。
# Android に無いもの (VA-API・NVENC・Rockchip MPP のエンコーダとフィルタ) は configure が黙って外す。patches/ の直しも Linux と同じく当てる。
# 設定は Linux と同じ `--enable-gpl --enable-version3` (GPL-3.0-or-later)。nonfree は入れない。
# x264・dav1d・zimg のバージョンは、Mac と同じく Linux のイメージ (Debian trixie のパッケージ) にそろえる (下の X264_COMMIT・DAV1D_VERSION・ZIMG_VERSION)。
#
# **依存は全部ソースから NDK で組み、静的に繋ぐ。** API は 29 (アプリの minSdk)。LOAD は 16 KB 境界にそろえる。
# zimg は C++ なので、NDK の libc++ を静的に繋ぐ (libc++_shared.so を APK に足さない)。
#
# **libav* は共有ライブラリで組み、ffmpeg と ffprobe の 2 つの実行ファイルが共有する** (Linux のイメージと同じ作り)。
# Mac と Windows は libav* を静的に繋ぎ、ffprobe を読む部品だけで別に組む (#2622)。Android は共有ライブラリにしたほうが小さい
# (ffprobe は 0.1 MB ほどの実行ファイルになり、libav* を 2 つ抱えない。大きさは docs/encode.md「Android でエンコードする」)。
# 実行ファイルは RUNPATH に `$ORIGIN` を書き、同じ置き場 (アプリの nativeLibraryDir) の libav* を読む。
#
# **自動で見つけるもの (`--disable-autodetect`) は全部切ってから、要るものだけ足す** (Mac・Windows と同じ理由)。
# スレッド (`pthreads`) と zlib (PNG のデコーダが使う。Android の libz.so) は明示する。
#
# **GPU のエンコーダは MediaCodec を組む** (h264_mediacodec・hevc_mediacodec・av1_mediacodec。docs/encode.md「Android でエンコードする」)。
# FFmpeg は JVM の無いプロセスでは NDK の AMediaCodec を使い (`ndk_codec`)、binder のスレッドも自分で立てる (compat/android/binder.c)。
# configure が JNI を求めるので `--enable-jni` も付ける (JVM が無ければ使われない)。繋ぐのは Android にある libmediandk.so と libandroid.so。
# Dockerfile の一覧に無い (Linux は組まない) ので、ここで足す。denpa の GPU の探し方 (src/lib/server/hwenc.ts) にはまだつないでいない
#
# 入れ先には APK に入れる形で置く (android/app/build.gradle.kts の DENPA_FFMPEG)。
#
#   jniLibs/<ABI>/libffmpeg.so・libffprobe.so  実行ファイル。Android は jniLibs の lib*.so しか実行させない
#   jniLibs/<ABI>/libav*.so・libsw*.so         ffmpeg と ffprobe が読む共有ライブラリ
#   assets/licenses/ffmpeg/                     同梱したもののライセンスの文書、バージョンの一覧、ソースの入手先 (SOURCE.txt)
#
# 依存の組み上がりは `deps/<名前>` (RUNNER_TEMP の下、ABI ごと) に置き、workflow が actions/cache に別々に置く
# (`# recipe:<名前>:begin` から `:end` までが鍵。.github/ffmpeg-macos.sh と同じ作り)。
# 3 つ目の引数に名前を渡すと、その依存だけ組んで終わる。入れ先に `.done` があれば組まない。
# ---------------------------------------------------------------------------
set -euo pipefail

mkdir -p "$1"
out=$(cd "$1" && pwd)
abi=$2
only=${3:-}
root=$(pwd)
: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT に NDK の置き場を渡してください}"
case "$abi" in
  arm64) triple=aarch64-linux-android; jni=arm64-v8a; arch=aarch64; meson_family=aarch64 ;;
  x86_64) triple=x86_64-linux-android; jni=x86_64; arch=x86_64; meson_family=x86_64 ;;
  *) echo "対応していない ABI: $abi" >&2; exit 1 ;;
esac
# アプリの minSdk (android/app/build.gradle.kts)
api=29

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
echo "ffmpeg ${FFMPEG_VERSION} / SVT-AV1 ${SVT_AV1_VERSION} / Opus ${OPUS_VERSION} ($abi)"

CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
temp=${RUNNER_TEMP:-/tmp}
prefix="$temp/ffmpeg-android-$abi-prefix"
work="$temp/ffmpeg-android-$abi-work"
deps="$temp/ffmpeg-android-$abi-deps"
rm -rf "$prefix" "$work"
mkdir -p "$prefix" "$work" "$deps"
jobs=$(nproc)

# NDK のツール。cmake は NDK の toolchain ファイル、x264・zimg・ffmpeg は clang を直に、dav1d は meson の cross ファイルで渡す
tc="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64"
export PATH="$tc/bin:$PATH"
cc="$tc/bin/$triple$api-clang"
cxx="$tc/bin/$triple$api-clang++"
# 16 KB のページの端末でも読めるように、LOAD を 16 KB 境界にそろえる。
# 静的に繋いだ依存 (x264・dav1d・SVT-AV1・Opus・zimg・libc++) のシンボルは libav* の外に出ない
# (FFmpeg が libav* ごとの version script で、外に出すのを av*・sw* の名前に絞っている。llvm-nm -D で確かめた)
page=-Wl,-z,max-page-size=16384
cmake_android=(
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake"
  -DANDROID_ABI="$jni" -DANDROID_PLATFORM="android-$api" -DANDROID_STL=c++_static
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
)
# pkg-config は組んだ依存だけを見る (組む機械の .pc を拾わない)
export PKG_CONFIG_LIBDIR="$deps/opus/lib/pkgconfig:$deps/svt-av1/lib/pkgconfig:$deps/x264/lib/pkgconfig:$deps/dav1d/lib/pkgconfig:$deps/zimg/lib/pkgconfig"

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
  cmake -S . -B build "${cmake_android[@]}" -DCMAKE_INSTALL_PREFIX="$deps/opus" \
    -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
  cmake --build build -j"$jobs"
  cmake --install build
  mkdir -p "$deps/opus/licenses/opus" && cp COPYING "$deps/opus/licenses/opus/"
  touch "$deps/opus/.done"
fi
# recipe:opus:end
if [ "$only" = opus ]; then exit 0; fi

# recipe:svt-av1:begin
# SVT-AV1。x86_64 のアセンブリは nasm で組む
if want svt-av1; then
  rm -rf "$deps/svt-av1"
  mkdir "$work/svtav1" && cd "$work/svtav1"
  fetch_tar "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz" z
  cmake -S . -B build "${cmake_android[@]}" -DCMAKE_INSTALL_PREFIX="$deps/svt-av1" -DBUILD_APPS=OFF -DBUILD_TESTING=OFF
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
  CC="$cc" AR=llvm-ar RANLIB=llvm-ranlib STRIP=llvm-strip ./configure --prefix="$deps/x264" --host="$triple" \
    --sysroot="$tc/sysroot" --enable-static --enable-pic --disable-cli
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
  cat > cross.txt << EOF
[binaries]
c = '$cc'
cpp = '$cxx'
ar = 'llvm-ar'
strip = 'llvm-strip'
nasm = 'nasm'
[host_machine]
system = 'android'
cpu_family = '$meson_family'
cpu = '$meson_family'
endian = 'little'
EOF
  meson setup build --cross-file cross.txt --buildtype=release --default-library=static --prefix="$deps/dav1d" --libdir=lib \
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
# リリースの tarball に configure は無いので autoreconf で作る。C++ の標準ライブラリは NDK の libc++ を静的に繋ぐ
# (zimg.pc の Libs.private。既定の -lstdc++ は NDK に無い。libm も C++ の標準ライブラリと一緒には繋がらないので足す)
ZIMG_VERSION=3.0.5
if want zimg; then
  rm -rf "$deps/zimg"
  mkdir "$work/zimg" && cd "$work/zimg"
  fetch_tar "https://github.com/sekrit-twc/zimg/archive/refs/tags/release-${ZIMG_VERSION}.tar.gz" z
  ./autogen.sh
  ./configure --prefix="$deps/zimg" --libdir="$deps/zimg/lib" --host="$triple" --enable-static --disable-shared --with-pic \
    CC="$cc" CXX="$cxx" AR=llvm-ar RANLIB=llvm-ranlib STL_LIBS="-lc++_static -lc++abi -lm"
  make -j"$jobs"
  make install
  mkdir -p "$deps/zimg/licenses/zimg" && cp COPYING "$deps/zimg/licenses/zimg/"
  touch "$deps/zimg/.done"
fi
# recipe:zimg:end
if [ "$only" = zimg ]; then exit 0; fi

# 入れ先のうち、この ABI の置き場とライセンスの文書だけを書き直す (2 つの ABI を同じ入れ先に重ねられる)
licenses="$out/assets/licenses/ffmpeg"
lib="$out/jniLibs/$jni"
rm -rf "$licenses" "$lib"
mkdir -p "$licenses" "$lib"
for dep in opus svt-av1 x264 dav1d zimg; do cp -R "$deps/$dep/licenses/." "$licenses/"; done

# FFmpeg (キャッシュの鍵はこのスクリプト全体。ここから下を変えても、上の依存は組み直さない)
src="$work/ffmpeg"
mkdir "$src" && cd "$src"
fetch_tar "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" j
for p in "$root"/patches/ffmpeg-*.patch; do [ -e "$p" ] || continue; patch -p1 --fuzz=0 < "$p"; done
"$src/configure" \
  --prefix="$prefix" \
  --enable-cross-compile \
  --target-os=android \
  --arch="$arch" \
  --cc="$cc" \
  --cxx="$cxx" \
  --nm=llvm-nm \
  --ar=llvm-ar \
  --ranlib=llvm-ranlib \
  --strip=llvm-strip \
  --sysroot="$tc/sysroot" \
  --pkg-config=pkg-config \
  --extra-ldflags="$page" \
  --enable-gpl \
  --enable-version3 \
  --enable-shared \
  --disable-static \
  --pkg-config-flags="--static" \
  --disable-autodetect \
  --enable-pthreads \
  --enable-zlib \
  --enable-libopus \
  --enable-libsvtav1 \
  --enable-libx264 \
  --enable-libdav1d \
  --enable-libzimg \
  --enable-jni \
  --enable-mediacodec \
  --disable-everything \
  --disable-network \
  --disable-doc \
  --disable-debug \
  "${components[@]}" \
  --enable-encoder=h264_mediacodec,hevc_mediacodec,av1_mediacodec \
  --enable-decoder=h264_mediacodec,hevc_mediacodec,av1_mediacodec,mpeg2_mediacodec
# 実行ファイルの RUNPATH に `$ORIGIN` を書く。configure に渡すと、configure の試しのリンクでシェルが `$$` を展開してしまうので、
# 書き出した config.mak に足す (make が `$$` を `$` にし、シェルには引用符の中で渡る)
echo "LDEXEFLAGS += -Wl,-rpath,'\$\$ORIGIN'" >> ffbuild/config.mak
make -j"$jobs"
make install
mkdir -p "$licenses/ffmpeg" && cp "$src/COPYING.GPLv3" "$src/LICENSE.md" "$licenses/ffmpeg/"

# 実行ファイルは lib<名前>.so に、共有ライブラリは SONAME (Android の configure はバージョン番号を付けない) のまま入れる
install -m 755 "$prefix/bin/ffmpeg" "$lib/libffmpeg.so"
install -m 755 "$prefix/bin/ffprobe" "$lib/libffprobe.so"
for so in "$prefix"/lib/lib*.so; do install -m 755 "$so" "$lib/"; done
llvm-strip --strip-unneeded "$lib"/*.so

# 繋ぐのは同梱の libav* と Android にあるものだけ。動的リンカは Android のもの、実行ファイルは RUNPATH が $ORIGIN、LOAD は 16 KB 以上
system="libc.so libm.so libdl.so liblog.so libz.so libmediandk.so libandroid.so"
for f in "$lib"/*.so; do
  name=$(basename "$f")
  for needed in $(llvm-readelf -d "$f" | sed -nE 's/.*\(NEEDED\).*\[(.+)\]/\1/p'); do
    if [[ " $system " != *" $needed "* ]] && [ ! -e "$lib/$needed" ]; then
      echo "$name が同梱していない $needed に繋いでいます" >&2
      exit 1
    fi
  done
  for align in $(llvm-readelf -lW "$f" | awk '$1 == "LOAD" { print $NF }'); do
    [ "$((align))" -ge 16384 ] || { echo "$name の LOAD が 16 KB 境界にそろっていません ($align)" >&2; exit 1; }
  done
done
# libav* が外に出すのは av*・sw* の名前だけ (静的に繋いだ依存のシンボルが出ていない)
leaked=$(llvm-nm -D --defined-only "$lib"/libav*.so "$lib"/libsw*.so | awk 'NF == 3 && $2 ~ /^[TDBRVW]$/ { print $3 }' | grep -vE '^(av|sw)' || true)
if [ -n "$leaked" ]; then echo "libav* が依存のシンボルを外に出しています:" >&2; echo "$leaked" | head >&2; exit 1; fi
for exe in libffmpeg.so libffprobe.so; do
  llvm-readelf -l "$lib/$exe" | grep -F '[Requesting program interpreter: /system/bin/linker64]'
  llvm-readelf -d "$lib/$exe" | grep -E '\(RUNPATH\).*\[\$ORIGIN\]'
done

# 組み込んだか (configure は依存が見つからないと黙って外す)。エミュレータや端末でなくても、一覧は実行ファイルの中の文字列で分かる
for name in libx264 libsvtav1 libopus libdav1d h264_mediacodec hevc_mediacodec av1_mediacodec zscale tonemap setparams; do
  grep -qF "$name" "$lib/libavcodec.so" "$lib/libavfilter.so" || { echo "ffmpeg に $name が組み込まれていません" >&2; exit 1; }
done

printf 'ffmpeg %s\nSVT-AV1 %s\nOpus %s\nx264 %s\ndav1d %s\nzimg %s\n' \
  "$FFMPEG_VERSION" "$SVT_AV1_VERSION" "$OPUS_VERSION" "$X264_COMMIT" "$DAV1D_VERSION" "$ZIMG_VERSION" > "$licenses/versions.txt"
# GPL の求めに合わせ、組んだソースの入手先を添える (どれも上流の配布物のまま。組み方はこのスクリプト)
cat > "$licenses/SOURCE.txt" << EOF
ffmpeg・ffprobe と libav* は、次のソースを .github/ffmpeg-android.sh (denpa のリポジトリ https://github.com/danything/denpa の同じバージョンのタグ) で組んだものです。
denpa は FFmpeg に直しを当てていません (patches/ が空のとき)。当てたときは、同じタグの patches/ にあります。

FFmpeg $FFMPEG_VERSION   https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2
SVT-AV1 $SVT_AV1_VERSION https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz
Opus $OPUS_VERSION      https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz
x264 $X264_COMMIT https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/x264-${X264_COMMIT}.tar.bz2
dav1d $DAV1D_VERSION     https://downloads.videolan.org/pub/videolan/dav1d/${DAV1D_VERSION}/dav1d-${DAV1D_VERSION}.tar.xz
zimg $ZIMG_VERSION      https://github.com/sekrit-twc/zimg/archive/refs/tags/release-${ZIMG_VERSION}.tar.gz
EOF
ls -l "$lib" "$licenses"
du -cb "$lib"/*.so | tail -1
