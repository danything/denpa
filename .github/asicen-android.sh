#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリに入れる asicen-userland (PX-W3U3 などの ASICEN 系。試験的) を、APK に入れる形に並べる (.github/workflows/android.yml)。
#
#   bash .github/asicen-android.sh <入れ先> <組んだもの> <arm64 | x86_64>...
#
# <組んだもの>/<arm64 | x86_64>/asicen/ は、android.yml の agent ジョブが agent/asicen/build.sh --android <ABI> --firmware で組んだもの
# (子プロセス・ファームウェア・ライセンスの文書)。上流のバージョンと SHA-256 は build.sh に固定してある。入れ先には APK に入れる形で置く
# (android/app/build.gradle.kts の DENPA_ASICEN)。
#
#   jniLibs/<ABI>/libdenpa_asicen.so    子プロセス (denpa-asicen)。エージェントが起動する (nativeLibraryDir に展開される。
#                                       jniLibs は lib*.so の名前のものしか展開されないので、この名前にする)
#   assets/asicen/asicen-loader.bin     ファームウェア。アプリが起動のときに filesDir に書き出す
#   assets/licenses/asicen-userland/    ライセンスの文書と、対応するソースの入手先 (SOURCE.txt)
# ---------------------------------------------------------------------------
set -euo pipefail

out=$1
built=$2
shift 2
[ "$#" -gt 0 ] || { echo "ABI を 1 つ以上渡してください (arm64・x86_64)" >&2; exit 1; }

licenses="$out/assets/licenses/asicen-userland"
mkdir -p "$out/assets/asicen" "$licenses"
for abi in "$@"; do
  case "$abi" in
    arm64) jni=arm64-v8a ;;
    x86_64) jni=x86_64 ;;
    *) echo "対応していない ABI: $abi" >&2; exit 1 ;;
  esac
  from="$built/$abi/asicen"
  mkdir -p "$out/jniLibs/$jni"
  install -m 755 "$from/denpa-asicen" "$out/jniLibs/$jni/libdenpa_asicen.so"
  # ファームウェアとライセンスの文書は ABI に依らない (build.sh が同じ配布物から写す)
  install -m 644 "$from/firmware/asicen-loader.bin" "$out/assets/asicen/"
  cp "$from/licenses/"* "$licenses/"
done
find "$out" -type f | sort
