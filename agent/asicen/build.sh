#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-only
# ---------------------------------------------------------------------------
# libdenpa_asicen.so (asicen-userland を組み込んだ共有ライブラリ。denpa_asicen.h) を組む。
#
#   bash agent/asicen/build.sh <出力先> [--mock] [--android arm64|x86_64] [--firmware]
#
#   <出力先>/libdenpa_asicen.so        ライブラリ
#   <出力先>/firmware/asicen-loader.bin ファームウェア (--firmware のとき)
#   <出力先>/licenses/                  ライセンスの文書と、対応するソースの入手先 (SOURCE.txt。--firmware のとき)
#
# --mock は偽の機材で開く関数を足す (テスト用。配るものには付けない)。--android は NDK (ANDROID_NDK_HOME) で組む。
# 要るもの: curl・cmake・ninja・make と C/C++ のコンパイラ (Linux) か NDK (Android)。
#
# **上流のバージョンと SHA-256 はここ 1 か所に固定する** (agent/Dockerfile と .github/asicen-android.sh はここを呼ぶ)。
# 上流のソースのアーカイブ (libusb と dtv-userland-core を同梱したもの) から組み、上流のファイルは変えない。
# ファームウェアはソースのアーカイブに入っていないので、バイナリの配布物 (linux-glibc-x86_64。ファームウェアと通知は arch に依らない) から写す。
# バージョンを上げるときは、denpa_asicen.cpp に写した起動の流れを上流の asicend_hardware.cpp と比べ直し、下の SHA-256 を入れ替える
# (Renovate は PR を出すだけで、自動ではマージしない。SHA-256 が合わずに CI で落ちる)。
#
# ファームウェアは再配布の許諾を確かめられていない。上流と同じ判断で同梱している (docs/licenses.md「ASICEN のファームウェアを同梱している判断」)
# ---------------------------------------------------------------------------
set -euo pipefail

# renovate: datasource=github-releases depName=Khronos31/asicen-userland extractVersion=^v(?<version>.*)$ versioning=semver
ASICEN_USERLAND_VERSION=1.0.0-beta
ASICEN_SOURCE_SHA256=3d9f4a67786921e27dc3fcc866bb708b9ac911358a7c9024fccf0685adb747a3
ASICEN_ARCHIVE_SHA256=7e2264adee65cb3d0616b19550a36ff299098bcca8f350cec6155b434c0390da
ASICEN_FIRMWARE_SHA256=5db39facda140bdcb3a238dad10da5aac752a1ba3aaf17e2239f8d79a0ad6a2a

usage() { echo "bash $0 <出力先> [--mock] [--android arm64|x86_64] [--firmware]" >&2; exit 2; }
[ "$#" -ge 1 ] || usage
out=$1
shift
mock=OFF
android=
firmware=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mock) mock=ON; shift ;;
    --android) [ "$#" -ge 2 ] || usage; android=$2; shift 2 ;;
    --firmware) firmware=1; shift ;;
    *) usage ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
# タグのプレリリースの部分 (-beta) を落としたものがアーカイブの名前 (上流のリリースノートの「既知の問題」)
release=${ASICEN_USERLAND_VERSION%%-*}
base="https://github.com/Khronos31/asicen-userland/releases/download/v$ASICEN_USERLAND_VERSION"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() { curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 -o "$2" "$1"; }
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)

source_archive="asicen-userland-$release-source.tar.gz"
fetch "$base/$source_archive" "$work/$source_archive"
echo "$ASICEN_SOURCE_SHA256  $work/$source_archive" | sha256sum -c -
mkdir "$work/src"
tar -xzf "$work/$source_archive" -C "$work/src"

# libusb は同梱の 1.0.30 を、udev を使わない静的ライブラリにして中に入れる (上流の配布物と同じ。コンテナには udev が無い)
cmake_args=()
libusb_env=()
case "$android" in
  "") ;;
  arm64) triple=aarch64-linux-android; abi=arm64-v8a ;;
  x86_64) triple=x86_64-linux-android; abi=x86_64 ;;
  *) echo "対応していない ABI: $android" >&2; exit 1 ;;
esac
if [ -n "$android" ]; then
  ndk=${ANDROID_NDK_HOME:?ANDROID_NDK_HOME に NDK を渡してください}
  toolchain=$(echo "$ndk"/toolchains/llvm/prebuilt/*)
  # API 24 は上流の Android の配布物と同じ。アプリの minSdk (29) より低いので、どの端末でも読み込める
  libusb_env=(CC="$toolchain/bin/${triple}24-clang" AR="$toolchain/bin/llvm-ar" RANLIB="$toolchain/bin/llvm-ranlib")
  libusb_host=(--host="$triple")
  cmake_args=(-DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" -DANDROID_ABI="$abi"
    -DANDROID_PLATFORM=android-24 -DCMAKE_ANDROID_STL_TYPE=c++_static -DANDROID_STL=c++_static)
else
  libusb_host=()
fi
cp -a "$work/src/third_party/libusb-1.0.30" "$work/libusb"
(
  cd "$work/libusb"
  env "${libusb_env[@]}" CFLAGS="-O2 -fPIC" ./configure "${libusb_host[@]}" --prefix="$work/prefix" --libdir="$work/prefix/lib" \
    --disable-shared --enable-static --with-pic --disable-udev --disable-examples-build --disable-tests-build \
    --disable-dependency-tracking > "$work/libusb-configure.log" || { cat "$work/libusb-configure.log" >&2; exit 1; }
  make -j"$jobs" > /dev/null
  make install > /dev/null
)

cmake -S "$here" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DASICEN_SOURCE="$work/src/repository" \
  -DASICEN_LIBUSB_INCLUDE_DIR="$work/prefix/include/libusb-1.0" \
  -DASICEN_LIBUSB_LIBRARY="$work/prefix/lib/libusb-1.0.a" \
  -DDENPA_ASICEN_MOCK="$mock" "${cmake_args[@]}"
cmake --build "$work/build" --target denpa_asicen -j "$jobs"

mkdir -p "$out"
library="$work/build/libdenpa_asicen.so"
if [ -n "$android" ]; then
  "$toolchain/bin/llvm-strip" --strip-unneeded "$library"
elif [ "$mock" = OFF ]; then
  strip --strip-unneeded "$library"
fi
install -m 755 "$library" "$out/libdenpa_asicen.so"

[ "$firmware" = 1 ] || exit 0

archive="asicen-userland-$release-linux-glibc-x86_64.tar.gz"
fetch "$base/$archive" "$work/$archive"
echo "$ASICEN_ARCHIVE_SHA256  $work/$archive" | sha256sum -c -
mkdir "$work/binary"
tar -xzf "$work/$archive" -C "$work/binary"
echo "$ASICEN_FIRMWARE_SHA256  $work/binary/firmware/asicen-loader.bin" | sha256sum -c -
mkdir -p "$out/firmware" "$out/licenses"
install -m 644 "$work/binary/firmware/asicen-loader.bin" "$out/firmware/"
install -m 644 "$work/binary/licenses/VENDOR-FIRMWARE-NOTICE.txt" "$out/licenses/"
install -m 644 "$here/COPYING" "$out/licenses/COPYING"
install -m 644 "$work/src/repository/NOTICES.md" "$work/src/repository/THIRD_PARTY_NOTICES.md" "$out/licenses/"
install -m 644 "$work/src/third_party/libusb-1.0.30/COPYING" "$out/licenses/COPYING.libusb"
if [ -n "$android" ]; then
  # libc++ (LLVM。Apache-2.0 WITH LLVM-exception) を静的に入れている
  install -m 644 "$ndk/NOTICE" "$out/licenses/NOTICE.ndk"
fi

# GPL-2.0 のものを配るので、対応するソースの入手先を添える (docs/licenses.md「asicen-userland を組み込んだエージェント」)
cat > "$out/licenses/SOURCE.txt" <<EOF
libdenpa_asicen.so (GPL-2.0-only) links asicen-userland $ASICEN_USERLAND_VERSION (GPL-2.0), dtv-userland-core and
libusb 1.0.30 (LGPL-2.1-or-later) into the denpa tuner agent process. The agent executable and this library are
distributed together under the terms of the GNU General Public License, version 2 (see COPYING).

Corresponding source:
  denpa (the agent, MPL-2.0, and agent/asicen/, GPL-2.0-only): https://github.com/danything/denpa
    (the source archive of the same release tag)
  asicen-userland, dtv-userland-core and libusb: $source_archive
    $base/$source_archive
    SHA-256 $ASICEN_SOURCE_SHA256
    (the denpa release also carries a copy of this archive)
  Build: bash agent/asicen/build.sh <out> [--android <abi>] --firmware

firmware/asicen-loader.bin is a separate vendor component, not covered by the GPL (see VENDOR-FIRMWARE-NOTICE.txt).
EOF
