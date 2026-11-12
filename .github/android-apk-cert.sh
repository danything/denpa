#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# APK を署名した証明書の SHA-256 を、決めた値と突き合わせる (.github/workflows/android.yml)。
#
#   bash .github/android-apk-cert.sh <APK> <SHA-256>
#
# SHA-256 は大文字・小文字とコロンの有無を問わない (`9C:FA:…` と `9cfa…` のどちらでもよい)。
# build-tools の apksigner で署名を確かめ、出力にある `certificate SHA-256 digest:` の行をすべて比べる。
# apksigner は行の先頭の形をバージョンで変える (36 までは `Signer #1 certificate …`、37 からは方式ごとの `V2 Signer: certificate …`) ので、
# 先頭は見ない。1 行も無いとき、方式 (v2・v3) のどれか 1 つでも違う値のとき、v2・v3 のどちらでも確かめられなかったときは止める。
# keytool -printcert -jarfile は使わない。読めるのは v1 (JAR) の署名だけで、minSdk 29 の APK には v1 の署名が付かない
# ---------------------------------------------------------------------------
set -euo pipefail

apk=$1
want=$(printf '%s' "$2" | tr -d ':' | tr '[:upper:]' '[:lower:]')
if ! printf '%s' "$want" | grep -Eqx '[0-9a-f]{64}'; then
  echo "::error::比べる SHA-256 の形式が違います: $2"
  exit 1
fi

apksigner=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner
out=$("$apksigner" verify --verbose --print-certs "$apk")
printf '%s\n' "$out"

# v2・v3 のどちらかで確かめられていること (v1 だけの署名は Android 11 以降で入れられない)
if ! printf '%s\n' "$out" | grep -Eq '^Verified using v(2|3|3\.1) scheme .*: true$'; then
  echo "::error::v2・v3 のどちらの方式でも署名を確かめられませんでした"
  exit 1
fi

digests=$(printf '%s\n' "$out" | sed -nE 's/.*certificate SHA-256 digest: *([0-9A-Fa-f:]+) *$/\1/p' | tr -d ':' | tr '[:upper:]' '[:lower:]')
if [ -z "$digests" ]; then
  echo "::error::apksigner の出力に証明書の SHA-256 がありません"
  exit 1
fi
bad=0
while IFS= read -r got; do
  if [ "$got" != "$want" ]; then
    echo "::error::署名した証明書の SHA-256 が違います (署名: $got、決めた値: $want)"
    bad=1
  fi
done <<< "$digests"
[ "$bad" = 0 ]
echo "署名した証明書の SHA-256 は決めた値と同じです ($(printf '%s\n' "$digests" | wc -l) 行): $want"
