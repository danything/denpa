#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-only
# ---------------------------------------------------------------------------
# denpa-asicen (エージェントが起動する ASICEN 系の機材の子プロセス。main.cpp) を組む。
#
#   bash agent/asicen/build.sh <出力先> [--mock] [--android arm64|x86_64 | --windows] [--firmware]
#
#   <出力先>/denpa-asicen (Windows は denpa-asicen.exe)   子プロセス
#   <出力先>/licenses/                  ライセンスの文書と、対応するソースの入手先 (SOURCE.txt)
#   <出力先>/firmware/asicen-loader.bin ファームウェア (--firmware のとき。Linux のイメージと Android だけ)
#
# 組む先は、引数が無ければこの機械 (Linux か macOS)、--android は NDK (ANDROID_NDK_HOME)、--windows は Linux から
# llvm-mingw で Windows (x64) 向けに (上流の scripts/build-windows.sh と同じ toolchain)。libusb と上流の部品は中に入れる。
# --mock は偽の機材で開く --mock を足す (テスト用。配るものには付けない)。
# 要るもの: curl・cmake・ninja・make と C/C++ のコンパイラ (Linux・macOS)、NDK (Android)。
#
# **上流のバージョンと SHA-256 はここ 1 か所に固定する** (agent/Dockerfile・.github/asicen-android.sh・windows-agent.yml・release.yml はここを呼ぶ)。
# 上流のソースのアーカイブ (libusb と dtv-userland-core を同梱したもの) から組み、上流のファイルは変えない。
# ファームウェアはソースのアーカイブに入っていないので、バイナリの配布物 (linux-glibc-x86_64。ファームウェアと通知は arch に依らない) から写す。
# **Windows と macOS の配布物にはファームウェアを入れない** (再配布の許諾を確かめている途中。利用者が置く。docs/licenses.md)。
# バージョンを上げるときは、denpa_asicen.cpp に写した起動の流れを上流の asicend_hardware.cpp と比べ直し、下の SHA-256 を入れ替える
# (Renovate は PR を出すだけで、自動ではマージしない。SHA-256 が合わずに CI で落ちる)。
# ---------------------------------------------------------------------------
set -euo pipefail

# renovate: datasource=github-releases depName=Khronos31/asicen-userland extractVersion=^v(?<version>.*)$ versioning=semver
ASICEN_USERLAND_VERSION=1.0.0-beta
ASICEN_SOURCE_SHA256=3d9f4a67786921e27dc3fcc866bb708b9ac911358a7c9024fccf0685adb747a3
ASICEN_ARCHIVE_SHA256=7e2264adee65cb3d0616b19550a36ff299098bcca8f350cec6155b434c0390da
ASICEN_FIRMWARE_SHA256=5db39facda140bdcb3a238dad10da5aac752a1ba3aaf17e2239f8d79a0ad6a2a
# Windows 向けの toolchain (上流の scripts/build-windows.sh と同じもの)
LLVM_MINGW_VERSION=20250910
LLVM_MINGW_SHA256=f83556c9ffa4d4291fadea1a0776c1383332dacdf4d7fbdf974c2928cb32c6f7

usage() { echo "bash $0 <出力先> [--mock] [--android arm64|x86_64 | --windows] [--firmware]" >&2; exit 2; }
[ "$#" -ge 1 ] || usage
out=$1
shift
mock=OFF
android=
windows=0
firmware=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mock) mock=ON; shift ;;
    --android) [ "$#" -ge 2 ] || usage; android=$2; shift 2 ;;
    --windows) windows=1; shift ;;
    --firmware) firmware=1; shift ;;
    *) usage ;;
  esac
done
macos=0
if [ -z "$android" ] && [ "$windows" = 0 ] && [ "$(uname -s)" = Darwin ]; then macos=1; fi
if [ "$firmware" = 1 ] && { [ "$windows" = 1 ] || [ "$macos" = 1 ]; }; then
  echo "Windows と macOS の配布物にはファームウェアを入れません" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
# タグのプレリリースの部分 (-beta) を落としたものがアーカイブの名前 (上流のリリースノートの「既知の問題」)
release=${ASICEN_USERLAND_VERSION%%-*}
base="https://github.com/Khronos31/asicen-userland/releases/download/v$ASICEN_USERLAND_VERSION"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() { curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 -o "$2" "$1"; }
verify() {
  local actual
  if command -v sha256sum > /dev/null; then actual=$(sha256sum "$2" | cut -d' ' -f1); else actual=$(shasum -a 256 "$2" | cut -d' ' -f1); fi
  [ "$actual" = "$1" ] || { echo "SHA-256 が違います: $2 ($actual)" >&2; exit 1; }
}
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)

source_archive="asicen-userland-$release-source.tar.gz"
fetch "$base/$source_archive" "$work/$source_archive"
verify "$ASICEN_SOURCE_SHA256" "$work/$source_archive"
mkdir "$work/src"
tar -xzf "$work/$source_archive" -C "$work/src"

# libusb は同梱の 1.0.30 を静的ライブラリにして中に入れる (上流の配布物と同じ。コンテナには udev が無い)
cmake_args=()
libusb_env=()
libusb_host=()
program=denpa-asicen
strip_tool=(strip)
case "$android" in
  "") ;;
  arm64) triple=aarch64-linux-android; abi=arm64-v8a ;;
  x86_64) triple=x86_64-linux-android; abi=x86_64 ;;
  *) echo "対応していない ABI: $android" >&2; exit 1 ;;
esac
if [ -n "$android" ]; then
  ndk=${ANDROID_NDK_HOME:?ANDROID_NDK_HOME に NDK を渡してください}
  toolchain=$(echo "$ndk"/toolchains/llvm/prebuilt/*)
  # API 24 は上流の Android の配布物と同じ。アプリの minSdk (29) より低いので、どの端末でも動く
  libusb_env=(CC="$toolchain/bin/${triple}24-clang" AR="$toolchain/bin/llvm-ar" RANLIB="$toolchain/bin/llvm-ranlib")
  libusb_host=(--host="$triple")
  cmake_args=(-DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" -DANDROID_ABI="$abi"
    -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static)
  strip_tool=("$toolchain/bin/llvm-strip")
elif [ "$windows" = 1 ]; then
  llvm="llvm-mingw-$LLVM_MINGW_VERSION-ucrt-ubuntu-22.04-x86_64"
  fetch "https://github.com/mstorsjo/llvm-mingw/releases/download/$LLVM_MINGW_VERSION/$llvm.tar.xz" "$work/$llvm.tar.xz"
  verify "$LLVM_MINGW_SHA256" "$work/$llvm.tar.xz"
  tar -xJf "$work/$llvm.tar.xz" -C "$work"
  bin="$work/$llvm/bin"
  # libusb の configure は資源のコンパイラ (x86_64-w64-mingw32-windres) を PATH から探す (上流の build-windows.sh と同じ)
  export PATH="$bin:$PATH"
  libusb_env=(CC="$bin/x86_64-w64-mingw32-clang" AR="$bin/llvm-ar" RANLIB="$bin/llvm-ranlib")
  libusb_host=(--host=x86_64-w64-mingw32)
  cmake_args=(-DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64
    -DCMAKE_C_COMPILER="$bin/x86_64-w64-mingw32-clang" -DCMAKE_CXX_COMPILER="$bin/x86_64-w64-mingw32-clang++"
    -DCMAKE_RC_COMPILER="$bin/llvm-rc")
  program=denpa-asicen.exe
  strip_tool=("$bin/llvm-strip")
elif [ "$macos" = 1 ]; then
  strip_tool=(strip -x)
fi
cp -pR "$work/src/third_party/libusb-1.0.30" "$work/libusb"
(
  cd "$work/libusb"
  # 依存の追跡は切らない (切ると Windows の資源ファイルを llvm-rc が組めない)
  env "${libusb_env[@]}" CFLAGS="-O2 -fPIC" ./configure "${libusb_host[@]}" --prefix="$work/prefix" --libdir="$work/prefix/lib" \
    --disable-shared --enable-static --with-pic --disable-udev --disable-examples-build --disable-tests-build \
    > "$work/libusb-configure.log" || { cat "$work/libusb-configure.log" >&2; exit 1; }
  make -j"$jobs" > /dev/null
  make install > /dev/null
)
# 静的な libusb が要る OS のライブラリ (macOS の IOKit・CoreFoundation・Security など) は、libusb の組み上がりから読む
libs_private=$(sed -n 's/^Libs\.private:[[:space:]]*//p' "$work/prefix/lib/pkgconfig/libusb-1.0.pc")
if [ -n "$libs_private" ]; then cmake_args+=(-DASICEN_LIBUSB_LINK_LIBRARIES="$libs_private"); fi

cmake -S "$here" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DASICEN_SOURCE="$work/src/repository" \
  -DASICEN_LIBUSB_INCLUDE_DIR="$work/prefix/include/libusb-1.0" \
  -DASICEN_LIBUSB_LIBRARY="$work/prefix/lib/libusb-1.0.a" \
  -DDENPA_ASICEN_MOCK="$mock" "${cmake_args[@]}"
cmake --build "$work/build" --target denpa-asicen -j "$jobs"

mkdir -p "$out/licenses"
built="$work/build/$program"
# Windows の exe は、C++ の実行時ライブラリ・winpthreads・libusb の DLL を読まないこと (中に入れた。exe 1 つで動く)
if [ "$windows" = 1 ]; then
  dlls=$("$bin/llvm-objdump" -p "$built" | sed -n 's/.*DLL Name: //p')
  echo "$program が読む DLL: $(echo "$dlls" | tr '\n' ' ')"
  if echo "$dlls" | grep -iE '^(libc\+\+|libunwind|libwinpthread-1|libusb-1\.0)\.dll$'; then
    echo "$program が Windows に無い DLL (上) を読みます" >&2
    exit 1
  fi
fi
if [ "$mock" = OFF ]; then "${strip_tool[@]}" "$built"; fi
# macOS (arm64) は署名の無い実行ファイルを動かさない。strip で外れたリンカの ad-hoc 署名を付け直す
if [ "$macos" = 1 ]; then codesign --force --sign - "$built"; fi
install -m 755 "$built" "$out/$program"

install -m 644 "$here/COPYING" "$out/licenses/COPYING"
install -m 644 "$work/src/repository/NOTICES.md" "$work/src/repository/THIRD_PARTY_NOTICES.md" "$out/licenses/"
install -m 644 "$work/src/third_party/libusb-1.0.30/COPYING" "$out/licenses/COPYING.libusb"
if [ -n "$android" ]; then
  # libc++ (LLVM。Apache-2.0 WITH LLVM-exception) を静的に入れている
  install -m 644 "$ndk/NOTICE" "$out/licenses/NOTICE.ndk"
elif [ "$windows" = 1 ]; then
  # libc++・mingw-w64 の実行時ライブラリ・winpthreads を静的に入れている
  install -m 644 "$work/$llvm/LICENSE.TXT" "$out/licenses/LICENSE.llvm-mingw"
  for license in COPYING.MinGW-w64-runtime.txt COPYING.winpthreads.txt; do
    install -m 644 "$work/$llvm/x86_64-w64-mingw32/share/mingw32/$license" "$out/licenses/"
  done
fi

# GPL-2.0 のものを配るので、対応するソースの入手先を添える (docs/licenses.md「ASICEN の子プロセス」)
{
  echo "$program (GPL-2.0-only) is a separate program that the denpa tuner agent starts as a child process."
  echo "It contains asicen-userland $ASICEN_USERLAND_VERSION (GPL-2.0), dtv-userland-core and libusb 1.0.30 (LGPL-2.1-or-later)."
  echo "It talks to the agent only through its standard input and output (tuning requests, status and the transport stream)."
  echo
  echo "Corresponding source:"
  echo "  agent/asicen/ (main.cpp, denpa_asicen.cpp, build.sh; GPL-2.0-only): https://github.com/danything/denpa"
  echo "    (the source archive of the same release tag; the release also carries denpa-asicen-<version>-source.tar.gz)"
  echo "  asicen-userland, dtv-userland-core and libusb: $source_archive"
  echo "    $base/$source_archive"
  echo "    SHA-256 $ASICEN_SOURCE_SHA256"
  echo "    (the denpa release also carries a copy of this archive)"
  echo "  Build: bash agent/asicen/build.sh <out> [--android <abi> | --windows] [--firmware]"
} > "$out/licenses/SOURCE.txt"

if [ "$firmware" = 0 ]; then exit 0; fi

archive="asicen-userland-$release-linux-glibc-x86_64.tar.gz"
fetch "$base/$archive" "$work/$archive"
verify "$ASICEN_ARCHIVE_SHA256" "$work/$archive"
mkdir "$work/binary"
tar -xzf "$work/$archive" -C "$work/binary"
verify "$ASICEN_FIRMWARE_SHA256" "$work/binary/firmware/asicen-loader.bin"
mkdir -p "$out/firmware"
install -m 644 "$work/binary/firmware/asicen-loader.bin" "$out/firmware/"
install -m 644 "$work/binary/licenses/VENDOR-FIRMWARE-NOTICE.txt" "$out/licenses/"
printf '\nfirmware/asicen-loader.bin is a separate vendor component, not covered by the GPL (see VENDOR-FIRMWARE-NOTICE.txt).\n' >> "$out/licenses/SOURCE.txt"
