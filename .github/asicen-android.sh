#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリに入れる asicen-userland (PX-W3U3 などの ASICEN 系。試験的) を、上流のリリースから取って並べる (.github/workflows/android.yml)。
#
#   bash .github/asicen-android.sh <入れ先> <arm64 | x86_64>...
#
# 上流の Android 版 (Termux 用の android-aarch64・android-x86_64) をそのまま使う。組み直しはしない。入れ先には APK に入れる形で置く
# (android/app/build.gradle.kts の DENPA_ASICEN)。
#
#   jniLibs/<ABI>/libasicend.so・libasicenctl.so   実行ファイル。Android は jniLibs の lib*.so しか実行させない
#   assets/asicen/asicen-loader.bin               ファームウェア。アプリが起動のときに filesDir に書き出す
#   assets/licenses/asicen-userland/              ライセンスの文書と、ソースの入手先 (SOURCE.txt)
#
# **バージョンは agent/Dockerfile の ASICEN_USERLAND_VERSION と、test.yml の ASICEN_USERLAND_REF (模擬のデーモンを組むコミット) にそろえる。**
# ずれていたら止まる。アーカイブの manifest.json の source_ref (上流が組んだコミット) も ASICEN_USERLAND_REF と突き合わせる。
# アーカイブとファームウェアの SHA-256 は下に固定する (上流の SHA256SUMS にも同じ値がある)。バージョンを上げるときは一緒に入れ替える。
# 上げ方は agent/Dockerfile の説明と同じ (Renovate は Dockerfile と同じグループの PR にまとめ、自動ではマージしない)
# ---------------------------------------------------------------------------
set -euo pipefail

# renovate: datasource=github-releases depName=Khronos31/asicen-userland extractVersion=^v(?<version>.*)$ versioning=semver
ASICEN_USERLAND_VERSION=1.0.0-beta
ASICEN_ARCHIVE_SHA256_ARM64=bdf6a89d82418df5047a830dff708ce4ca4ec940afd857d747427d4be6e1101d
ASICEN_ARCHIVE_SHA256_X86_64=d4b448288f0c1570326069aaaf8d4561502f4f39155620aa207f19345e60206f
ASICEN_SOURCE_SHA256=3d9f4a67786921e27dc3fcc866bb708b9ac911358a7c9024fccf0685adb747a3
ASICEN_FIRMWARE_SHA256=5db39facda140bdcb3a238dad10da5aac752a1ba3aaf17e2239f8d79a0ad6a2a

out=$1
shift
[ "$#" -gt 0 ] || { echo "ABI を 1 つ以上渡してください (arm64・x86_64)" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)

docker=$(sed -nE 's/^ARG ASICEN_USERLAND_VERSION=(.+)$/\1/p' "$root/agent/Dockerfile")
if [ "$docker" != "$ASICEN_USERLAND_VERSION" ]; then
  echo "agent/Dockerfile の ASICEN_USERLAND_VERSION ($docker) と、ここのバージョン ($ASICEN_USERLAND_VERSION) が違います" >&2
  exit 1
fi
ref=$(sed -nE 's/^ +ASICEN_USERLAND_REF: ([0-9a-f]{40})$/\1/p' "$root/.github/workflows/test.yml")
[ -n "$ref" ] || { echo "test.yml に ASICEN_USERLAND_REF がありません" >&2; exit 1; }

base="https://github.com/Khronos31/asicen-userland/releases/download/v$ASICEN_USERLAND_VERSION"
# アーカイブの名前はタグのプレリリースの部分 (-beta) を落としたもの (agent/Dockerfile と同じ)
release=${ASICEN_USERLAND_VERSION%%-*}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() { curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$2" "$1"; }
# ソースのアーカイブは取らずに、上流の SHA256SUMS の値が SOURCE.txt に書く値と同じことだけを見る
fetch "$base/SHA256SUMS" "$work/SHA256SUMS"
grep -qxE "$ASICEN_SOURCE_SHA256 [ *]asicen-userland-${ASICEN_USERLAND_VERSION%%-*}-source\.tar\.gz" "$work/SHA256SUMS"

licenses="$out/assets/licenses/asicen-userland"
mkdir -p "$out/assets/asicen" "$licenses"
for abi in "$@"; do
  case "$abi" in
    arm64) platform=android-aarch64; jni=arm64-v8a; sum=$ASICEN_ARCHIVE_SHA256_ARM64 ;;
    x86_64) platform=android-x86_64; jni=x86_64; sum=$ASICEN_ARCHIVE_SHA256_X86_64 ;;
    *) echo "対応していない ABI: $abi" >&2; exit 1 ;;
  esac
  archive="asicen-userland-$release-$platform.tar.gz"
  fetch "$base/$archive" "$work/$archive"
  echo "$sum  $work/$archive" | sha256sum -c -
  mkdir "$work/$abi"
  tar -xzf "$work/$archive" -C "$work/$abi"
  source_ref=$(jq -r '.source_ref' "$work/$abi/manifest.json")
  if [ "$source_ref" != "$ref" ]; then
    echo "$archive は $source_ref から組まれていて、test.yml の ASICEN_USERLAND_REF ($ref) と違います" >&2
    exit 1
  fi
  test "$(jq -r '.platform' "$work/$abi/manifest.json")" = "$platform"
  echo "$ASICEN_FIRMWARE_SHA256  $work/$abi/firmware/asicen-loader.bin" | sha256sum -c -

  mkdir -p "$out/jniLibs/$jni"
  install -m 755 "$work/$abi/asicend" "$out/jniLibs/$jni/libasicend.so"
  install -m 755 "$work/$abi/asicenctl" "$out/jniLibs/$jni/libasicenctl.so"
  cp "$work/$abi/firmware/asicen-loader.bin" "$out/assets/asicen/"
  # 機種ごとに違うのは DEPENDENCY-NOTICE.txt (何の機種の配布物か) だけ。ほかは同じ文書
  cp "$work/$abi/DEPENDENCY-NOTICE.txt" "$licenses/DEPENDENCY-NOTICE-$platform.txt"
  cp "$work/$abi/LICENSE" "$work/$abi/THIRD_PARTY_NOTICES.md" "$licenses/"
  cp "$work/$abi/libusb/COPYING" "$licenses/COPYING.libusb"
  cp "$work/$abi/licenses/VENDOR-FIRMWARE-NOTICE.txt" "$licenses/"
  cp "$work/$abi/ndk/NOTICE" "$licenses/NOTICE.ndk"
  cp "$work/$abi/ndk/NOTICE.toolchain" "$licenses/NOTICE.ndk-toolchain"
done

# GPLv2 の実行ファイルを配るので、対応するソースの入手先を添える (docs/licenses.md「Android のアプリ」)
cat > "$licenses/SOURCE.txt" <<EOF
asicen-userland $ASICEN_USERLAND_VERSION (GPL-2.0)
https://github.com/Khronos31/asicen-userland

The asicend and asicenctl executables in this app (lib/<ABI>/libasicend.so, libasicenctl.so) are the unmodified
Android release binaries of asicen-userland $ASICEN_USERLAND_VERSION, built from commit $ref.
Corresponding source:
  $base/asicen-userland-$release-source.tar.gz
  SHA-256 $ASICEN_SOURCE_SHA256
  https://github.com/Khronos31/asicen-userland/tree/$ref
firmware/asicen-loader.bin is a separate vendor component (see VENDOR-FIRMWARE-NOTICE.txt).
EOF
find "$out" -type f | sort
