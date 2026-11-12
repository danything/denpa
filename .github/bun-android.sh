#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリに入れる bun を、公式のリリースから取って並べる (.github/workflows/android.yml)。
#
#   bash .github/bun-android.sh <入れ先> <arm64 | x86_64>...
#
# 公式の Android 版 (bionic 向け。動的リンカは /system/bin/linker64、API 28、LOAD は 16 KB 境界) をそのまま使う。組み直しはしない。
# 入れ先には APK に入れる形で置く (android/app/build.gradle.kts の DENPA_BUN)。
#
#   jniLibs/<ABI>/libbun.so        実行ファイル。Android は jniLibs の lib*.so しか実行させない
#   assets/licenses/bun/LICENSE.md bun のライセンス (中に静的に繋いだライブラリの一覧がある)
#
# x86_64 は CI のエミュレータ用で、baseline (AVX2 を使わない版) を入れる。エミュレータの CPU が AVX2 を見せるとは限らないため。
# アーカイブと LICENSE.md の SHA-256 は下に固定する (アーカイブは上流の SHASUMS256.txt にも同じ値がある)。バージョンを上げるときは一緒に入れ替える。
# Renovate は別の PR に分け、自動ではマージしない (renovate.json。PR は SHA-256 が合わずに CI で落ちる)。
# **denpa の Dockerfile の bun (`oven/bun`) とバージョンがずれていたら止める。** APK の denpa 本体はコンテナと同じ bun で動かすため
# (Renovate がどちらか片方を上げた PR は、もう片方を揃えるまで CI が落ちる)
# ---------------------------------------------------------------------------
set -euo pipefail

# renovate: datasource=github-releases depName=oven-sh/bun extractVersion=^bun-v(?<version>.*)$
BUN_VERSION=1.4.4
BUN_ARCHIVE_SHA256_ARM64=d72e42c60e895ccbc16144bb1e0e0ad7ee384841c35b5501a7ec28b4d6d759c9
BUN_ARCHIVE_SHA256_X86_64=a7ee2956033938c14a7fc10ce7cc0c755acd688340c2a218adc75ff6ca767ded
BUN_LICENSE_SHA256=362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd

out=$1
shift
[ "$#" -gt 0 ] || { echo "ABI を 1 つ以上渡してください (arm64・x86_64)" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)

docker=$(grep -oP 'oven/bun:\K[^-\s@]+' "$root/Dockerfile" | head -1)
if [ "$docker" != "$BUN_VERSION" ]; then
  echo "::error::Dockerfile の bun ($docker) と、Android のアプリに入れる bun ($BUN_VERSION) のバージョンが違います。揃えてください (.github/bun-android.sh)"
  exit 1
fi

base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() { curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$2" "$1"; }

mkdir -p "$out/assets/licenses/bun"
fetch "https://raw.githubusercontent.com/oven-sh/bun/bun-v$BUN_VERSION/LICENSE.md" "$work/LICENSE.md"
echo "$BUN_LICENSE_SHA256  $work/LICENSE.md" | sha256sum -c -
cp "$work/LICENSE.md" "$out/assets/licenses/bun/LICENSE.md"

for abi in "$@"; do
  case "$abi" in
    arm64) name=bun-linux-aarch64-android; jni=arm64-v8a; sum=$BUN_ARCHIVE_SHA256_ARM64 ;;
    x86_64) name=bun-linux-x64-android-baseline; jni=x86_64; sum=$BUN_ARCHIVE_SHA256_X86_64 ;;
    *) echo "対応していない ABI: $abi" >&2; exit 1 ;;
  esac
  fetch "$base/$name.zip" "$work/$name.zip"
  echo "$sum  $work/$name.zip" | sha256sum -c -
  unzip -q "$work/$name.zip" "$name/bun" -d "$work"
  mkdir -p "$out/jniLibs/$jni"
  install -m 755 "$work/$name/bun" "$out/jniLibs/$jni/libbun.so"
done
find "$out" -type f -exec ls -l {} +
