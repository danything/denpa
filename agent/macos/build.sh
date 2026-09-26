#!/bin/sh
# macOS (Apple Silicon) 向けのエージェントを1つの tar.gz に束ねる。Homebrew の formula
# (HomebrewFormula/denpa-agent.rb) が取ってくるもの。
#
# **中身は agent/Dockerfile と同じ顔ぶれ** (エージェント・libaribb25・px4-userland と
# ファームウェア・siano-userland)。版とハッシュは Dockerfile の ARG から読む — Renovate が
# 上げるのはあちらだけなので、ここに書き写すと片方だけ古くなる。
#
# libaribb25 だけは macOS の配布物が無いので、ここで組む (pcsc-lite は Homebrew のもの)。
# px4-userland / siano-userland の darwin 版は libusb を Homebrew の場所
# (/opt/homebrew/opt/libusb) から引くので、formula の depends_on で揃える。
#
# 使い方 (macOS。brew で pcsc-lite と pkgconf、.NET 10 SDK が要る):
#
#   agent/macos/build.sh <版> <出力先>
set -eu

version="$1"
mkdir -p "$2"
out=$(cd "$2" && pwd)
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage="$work/denpa-agent-$version"
mkdir -p "$stage"

arg() { sed -n "s/^ARG $1=//p" "$root/agent/Dockerfile"; }

# 配布元の SHA256SUMS で確かめてから展開する (Dockerfile と同じ)
fetch() {
  base="$1" archive="$2" dest="$3"
  (cd "$work" && curl -fsSLO "$base/$archive" && curl -fsSL -o "$archive.sums" "$base/SHA256SUMS" &&
    grep " \*\{0,1\}$archive\$" "$archive.sums" | shasum -a 256 -c -)
  mkdir -p "$dest"
  tar -xzf "$work/$archive" -C "$dest"
}

check() { echo "$1  $2" | shasum -a 256 -c -; }

# --- エージェント ---------------------------------------------------------
dotnet publish "$root/agent/Denpa.Agent/Denpa.Agent.csproj" -c Release -r osx-arm64 -o "$work/publish"
cp "$work/publish/denpa-agent" "$stage/"

# --- libaribb25 -----------------------------------------------------------
# find_package(PCSC) は WITH_PCSC_PACKAGE を決める前に走るので、外から渡す。
#
# **pcsc-lite の wintypes.h は __APPLE__ で形が変わる。** LPTSTR / LPCTSTR を定義せず、
# DWORD も 32 ビットになる。libaribb25 は Linux の形 (unsigned long) で書いてあり、
# 名前が無いところで止まるので足す (CMakeLists が CMAKE_C_FLAGS を上書きするので
# project() の直後に差し込む)。幅の食い違いは、長さを 0 か小さな値で初期化してから
# 渡しているので little endian では下位 32 ビットに正しく入る — 実機のカードでは未確認
b25="$(arg ARIBB25_VERSION)"
git clone -q --depth 1 --branch "v$b25" https://github.com/tsukumijima/libaribb25 "$work/libaribb25"
printf '%s\n' 'add_compile_definitions("LPTSTR=char*" "LPCTSTR=const char*")' > "$work/b25-apple.cmake"
PKG_CONFIG_PATH="$(brew --prefix pcsc-lite)/lib/pkgconfig" \
  cmake -S "$work/libaribb25" -B "$work/libaribb25/build" -DCMAKE_BUILD_TYPE=Release \
  -DWITH_PCSC_PACKAGE=libpcsclite -DCMAKE_PROJECT_INCLUDE="$work/b25-apple.cmake" >/dev/null
cmake --build "$work/libaribb25/build" --target aribb25-shared
# エージェントは自分の隣から dlopen する (LibraryImport("aribb25"))
cp -L "$work/libaribb25/build/libaribb25.dylib" "$stage/libaribb25.dylib"
cp "$work/libaribb25/LICENSE" "$stage/LICENSE.libaribb25"
otool -L "$stage/libaribb25.dylib"

# --- px4-userland とファームウェア -----------------------------------------
px4="$(arg PX4_USERLAND_VERSION)"
fetch "https://github.com/Khronos31/px4-userland/releases/download/v$px4" \
  "px4-userland-$px4-darwin-arm64.tar.gz" "$stage/px4-userland"
mkdir -p "$stage/px4-userland/firmware"
curl -fsSL -o "$stage/px4-userland/firmware/it930x-firmware.bin" \
  "https://raw.githubusercontent.com/tsukumijima/px4_drv/$(arg PX4_DRV_COMMIT)/etc/it930x-firmware.bin"
check "$(arg IT930X_FIRMWARE_SHA256)" "$stage/px4-userland/firmware/it930x-firmware.bin"

# --- siano-userland (ファームウェアはアーカイブに入っている) -----------------
siano="$(arg SIANO_USERLAND_VERSION)"
fetch "https://github.com/Khronos31/siano-userland/releases/download/v$siano" \
  "siano-ts-$siano-darwin-arm64.tar.gz" "$stage/siano-userland"
check "$(arg ISDBT_RIO_SHA256)" "$stage/siano-userland/firmware/isdbt_rio.inp"

cp "$root/LICENSE" "$stage/LICENSE"
tarball="$out/denpa-agent-$version-darwin-arm64.tar.gz"
tar -czf "$tarball" -C "$work" "denpa-agent-$version"
shasum -a 256 "$tarball"
