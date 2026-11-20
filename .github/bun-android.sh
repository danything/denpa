#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリに入れる bun を、bun の公式リリースから取って並べる (.github/workflows/android.yml)。
#
#   bash .github/bun-android.sh <入れ先> <arm64 | x86_64>...
#
# 公式の Android 向けのビルド (bionic・API 28・LOAD は 16 KB) をそのまま使う。x86_64 は CI のエミュレータ用で、
# AVX2 を使わない baseline のビルドを入れる。
# **バージョンは Dockerfile の oven/bun から読む。** APK の denpa 本体もコンテナと同じ bun で動かすため、
# 別に書かず、Renovate が Dockerfile を上げればここも上がる。zip は同じリリースの SHASUMS256.txt で照らす
# ---------------------------------------------------------------------------
set -euo pipefail

out=$1
shift
[ "$#" -gt 0 ] || { echo "ABI を 1 つ以上渡してください (arm64・x86_64)" >&2; exit 1; }

root=$(cd "$(dirname "$0")/.." && pwd)
BUN_VERSION=$(grep -oP 'oven/bun:\K[^-\s@]+' "$root/Dockerfile" | head -1)
[ -n "$BUN_VERSION" ] || { echo "::error::Dockerfile から bun のバージョンを読めません"; exit 1; }

base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() {
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$2" "$1"
}

fetch "$base/SHASUMS256.txt" "$work/SHA256SUMS"

verify() {
  local sum
  sum=$(awk -v n="$1" '$2 == n || $2 == "*" n { print $1 }' "$work/SHA256SUMS")
  [[ "$sum" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "::error::SHA-256 が見つかりません: $1"; exit 1; }
  echo "$sum  $2" | sha256sum -c -
}

mkdir -p "$out/assets/licenses/bun"
fetch "https://raw.githubusercontent.com/oven-sh/bun/bun-v$BUN_VERSION/LICENSE.md" "$work/LICENSE.md"
cp "$work/LICENSE.md" "$out/assets/licenses/bun/"

for abi in "$@"; do
  case "$abi" in
    arm64) name=bun-linux-aarch64-android; jni=arm64-v8a ;;
    x86_64) name=bun-linux-x64-android-baseline; jni=x86_64 ;;
    *) echo "対応していない ABI: $abi" >&2; exit 1 ;;
  esac

  fetch "$base/$name.zip" "$work/$name.zip"
  verify "$name.zip" "$work/$name.zip"
  unzip -q "$work/$name.zip" "$name/bun" -d "$work"

  mkdir -p "$out/jniLibs/$jni"
  install -m 755 "$work/$name/bun" "$out/jniLibs/$jni/libbun.so"
done

find "$out" -type f -exec ls -l {} +
