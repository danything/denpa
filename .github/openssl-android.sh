#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android 向けのエージェントに入れる OpenSSL を、NDK で静的ライブラリに組む (.github/workflows/android.yml)。
#
#   ANDROID_NDK_ROOT=<NDK> bash .github/openssl-android.sh <arm64 | x86_64> <入れ先>
#
# Android には OpenSSL が無い (端末の libssl は BoringSSL で、名前も中身も違う)。エージェントは `StaticOpenSslLinking` で
# 入れ先の lib/libssl.a・libcrypto.a を実行ファイルに入れる (agent/Denpa.Agent/Denpa.Agent.csproj)。入れ先は `OPENSSL_ROOT_DIR` に渡す。
#
# **3.5 系 (LTS) に留める。** .NET 11 の暗号の部品は 3.x で確かめられている。4.x に上げるときは、Android の CI で TLS を確かめ直す
# (renovate.json の packageRules)。API レベルは NDK の targets と同じ 24 (.NET 11 の bionic の下限)。
#
# 要らないもの (コマンド・テスト・文書・共有ライブラリ・読み込むモジュール) は組まない。入れ先に `.done` があれば組まない。
# ---------------------------------------------------------------------------
set -euo pipefail

# renovate: datasource=github-releases depName=openssl/openssl extractVersion=^openssl-(?<version>.+)$
OPENSSL_VERSION=3.5.9
# リリースのアーカイブの SHA-256 (上流の openssl-<バージョン>.tar.gz.sha256 と同じ値)。バージョンを上げるときは一緒に入れ替える
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

abi=$1
out=$2
case "$abi" in
  arm64 | x86_64) ;;
  *) echo "対応していない ABI: $abi" >&2; exit 1 ;;
esac
if [ -f "$out/.done" ]; then
  echo "OpenSSL ($abi) は組んであります"
  exit 0
fi
: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT に NDK の置き場を渡してください}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive="openssl-$OPENSSL_VERSION.tar.gz"
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$work/$archive" \
  "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/$archive"
echo "$OPENSSL_SHA256  $work/$archive" | sha256sum -c -
mkdir "$work/src"
tar -xzf "$work/$archive" -C "$work/src" --strip-components=1

mkdir -p "$out"
out=$(cd "$out" && pwd)
export PATH="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"
cd "$work/src"
./Configure "android-$abi" -D__ANDROID_API__=24 \
  no-shared no-module no-apps no-tests no-docs \
  --prefix="$out" --libdir=lib
make -j"$(nproc)" >/dev/null
make install_sw >/dev/null
cp LICENSE.txt "$out/LICENSE.txt"
test -f "$out/lib/libssl.a"
test -f "$out/lib/libcrypto.a"
touch "$out/.done"
