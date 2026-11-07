#!/usr/bin/env bash
# 試し: Linux のランナーで mingw-w64 を使い、Windows 用の ffmpeg をクロスコンパイルして時間を測る。
#   bash .github/ffmpeg-windows-cross.sh <出力先>
set -euo pipefail
start=$(date +%s)
out=$(realpath -m "$1")
root=$(pwd)
stage=$(awk '/^FROM .* AS ffmpeg$/ { f = 1; next } /^FROM / { f = 0 } f' Dockerfile)
value() { sed -nE "s/^(ARG|ENV) $1=(.+)$/\2/p" <<< "$stage" | head -1; }
FFMPEG_VERSION=$(value FFMPEG_VERSION)
SVT_AV1_VERSION=$(value SVT_AV1_VERSION)
OPUS_VERSION=$(value OPUS_VERSION)
mapfile -t components < <(grep -oE -- '--enable-(decoder|encoder|hwaccel|demuxer|muxer|parser|bsf|filter|indev|protocol)=[^ ]+' <<< "$stage")

TRIPLE=x86_64-w64-mingw32
CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
work=$(mktemp -d)
prefix="$work/prefix"
mkdir -p "$prefix" "$out"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=
export CC=$TRIPLE-gcc-posix CXX=$TRIPLE-g++-posix AR=$TRIPLE-ar RANLIB=$TRIPLE-ranlib STRIP=$TRIPLE-strip RC=$TRIPLE-windres
jobs=$(nproc)

fetch_tar() { # url flag dir
  mkdir -p "$work/$3" && cd "$work/$3"
  $CURL -o src.tar "$1"
  tar -x"$2" -f src.tar --strip-components=1
}

cat > "$work/toolchain.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER $CC)
set(CMAKE_CXX_COMPILER $CXX)
set(CMAKE_RC_COMPILER $RC)
set(CMAKE_FIND_ROOT_PATH $prefix)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
EOF
cmk() { cmake -S . -B build -G Ninja -DCMAKE_TOOLCHAIN_FILE="$work/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF "$@" && cmake --build build -j"$jobs" && cmake --install build; }
t() { echo "[time] $1 $(( $(date +%s) - start ))s"; }

fetch_tar "https://zlib.net/current/zlib.tar.gz" z zlib || fetch_tar "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz" z zlib
cmk -DZLIB_BUILD_EXAMPLES=OFF; rm -f "$prefix"/lib/libzlib.dll.a; ls "$prefix/lib"; [ -e "$prefix/lib/libz.a" ] || cp "$prefix/lib/libzlibstatic.a" "$prefix/lib/libz.a"; t zlib

fetch_tar "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz" z opus
cmk -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF; t opus

fetch_tar "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz" z svtav1
cmk -DBUILD_APPS=OFF; t svtav1

fetch_tar "https://github.com/intel/libvpl/archive/refs/tags/v2.17.0.tar.gz" z vpl
cmk -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TOOLS=OFF -DINSTALL_EXAMPLE_CODE=OFF; t libvpl

fetch_tar "https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2" j x264
./configure --host=$TRIPLE --cross-prefix=$TRIPLE- --prefix="$prefix" --enable-static --disable-cli --disable-opencl
make -j"$jobs"; make install; t x264

fetch_tar "https://code.videolan.org/videolan/dav1d/-/archive/1.5.1/dav1d-1.5.1.tar.bz2" j dav1d
cat > cross.txt <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
windres = '$RC'
pkg-config = 'pkg-config'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
meson setup build --cross-file cross.txt --prefix="$prefix" --default-library=static -Denable_tools=false -Denable_tests=false
ninja -C build install; t dav1d

fetch_tar "https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/n13.0.19.0.tar.gz" z nvh
make PREFIX="$prefix" install
fetch_tar "https://github.com/GPUOpen-LibrariesAndSDKs/AMF/archive/refs/tags/v1.5.3.tar.gz" z amf
mkdir -p "$prefix/include/AMF" && cp -r amf/public/include/core amf/public/include/components "$prefix/include/AMF/"
t headers

fetch_tar "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" j ffmpeg
for p in "$root"/patches/ffmpeg-*.patch; do [ -e "$p" ] || continue; patch -p1 --fuzz=0 < "$p"; done
./configure --prefix="$prefix" --enable-cross-compile --arch=x86_64 --target-os=mingw32 --cross-prefix=$TRIPLE- \
  --cc=$CC --cxx=$CXX --pkg-config=pkg-config \
  --enable-gpl --enable-version3 --disable-shared --enable-static --pkg-config-flags="--static" \
  --extra-libs="-lstdc++" --extra-ldflags="-static" --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" \
  --disable-autodetect --enable-w32threads --enable-zlib --enable-libopus --enable-libsvtav1 --enable-libx264 --enable-libdav1d \
  --enable-ffnvcodec --enable-nvenc --enable-libvpl --enable-d3d11va --enable-amf \
  --disable-everything --disable-network --disable-doc \
  "${components[@]}" --enable-encoder=h264_qsv,hevc_qsv,av1_qsv,h264_amf,hevc_amf,av1_amf
t configure
make -j"$jobs"; make install; t ffmpeg
cp "$prefix/bin/ffmpeg.exe" "$prefix/bin/ffprobe.exe" "$out/"
for e in h264_nvenc hevc_nvenc av1_nvenc h264_qsv hevc_qsv av1_qsv h264_amf hevc_amf av1_amf; do
  if grep -aq "$e" "$out/ffmpeg.exe"; then echo "encoder ok: $e"; else echo "encoder MISSING: $e"; fi
done
$TRIPLE-objdump -p "$out/ffmpeg.exe" | grep "DLL Name" | sort -u
ls -la "$out"
t total
