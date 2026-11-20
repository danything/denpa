
#!/usr/bin/env bash
# Android 用 Bun を公式リリースから取得して APK 用に配置する。
# Usage: bash .github/bun-android.sh <出力先> <arm64 | x86_64>...
#
# Android 公式版 (bionic / API 28 / 16 KB LOAD) をそのまま使用。
# x86_64 は AVX2 非依存の baseline 版。
# SHA-256 は公式 SHASUMS256.txt から取得して検証する。
# Dockerfile の oven/bun とバージョンが異なる場合は停止する。
set -euo pipefail

# renovate: datasource=github-releases depName=oven-sh/bun extractVersion=^bun-v(?<version>.*)$
BUN_VERSION=1.4.5

out=$1
shift
[ "$#" -gt 0 ] || { echo "ABI を 1 つ以上渡してください (arm64・x86_64)" >&2; exit 1; }

root=$(cd "$(dirname "$0")/.." && pwd)
docker=$(grep -oP 'oven/bun:\K[^-\s@]+' "$root/Dockerfile" | head -1)

[ "$docker" = "$BUN_VERSION" ] || {
  echo "::error::Dockerfile の bun ($docker) と Android Bun ($BUN_VERSION) のバージョンが違います"
  exit 1
}

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
