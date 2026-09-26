#!/bin/bash
# 放送の MPEG-2 を解く WebAssembly を組む (docs/stream.md §5.5)。
#
#   build.sh <FFmpeg のソース> <出口>
#
# emscripten/emsdk の中で動かす (Dockerfile の `mpeg2wasm` 段)。出口に
# decoder.mjs (読み込み口) と decoder.wasm ができる。
#
# **組むのは mpeg2video の復号器と、絵の区切りを探す parser だけ。** 他は全部切る
# (`--disable-everything`)。音声の AAC はブラウザの AudioDecoder が解けるので持ち込まない。
#
# - `--disable-asm` … x86 の手書きアセンブリは wasm では使えない
# - スレッドも SIMD も使わない。スレッド版は SharedArrayBuffer のために COOP/COEP
#   (crossOriginIsolated) を全ページに要求することになり、denpa の画面 (データ放送の
#   中継・ロゴ・別オリジンの Hybridcast) と噛み合わない。実測で 1 本でも 1080i を
#   実時間の 3 倍で解けたので払う理由が無い。SIMD も 1 割ほどしか変わらなかった
set -euo pipefail
SRC=$1
OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
PREFIX=$WORK/prefix

cd "$WORK"
emconfigure "$SRC/configure" \
    --prefix="$PREFIX" --target-os=none --arch=x86_32 --enable-cross-compile \
    --disable-asm --disable-inline-asm --disable-x86asm --disable-stripping \
    --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect \
    --disable-autodetect --disable-network --disable-pthreads \
    --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample --disable-swscale \
    --disable-everything --enable-decoder=mpeg2video --enable-parser=mpegvideo \
    --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
    --extra-cflags=-O3 >configure.log
emmake make -j"$(nproc)" >make.log 2>&1 || { tail -50 make.log; exit 1; }
emmake make install >/dev/null

mkdir -p "$OUT"
# **読み込み口は ES の module にして、ワーカーの中からだけ読む** (ENVIRONMENT=worker)。
# ファイルの読み書き (FILESYSTEM) は使わないので外す — それだけで 40KB ほど縮む
emcc -O3 "$HERE/decoder.c" -I"$PREFIX/include" -L"$PREFIX/lib" -lavcodec -lavutil \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=1GB \
    -sENVIRONMENT=worker -sFILESYSTEM=0 \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDecoder \
    -sEXPORTED_FUNCTIONS=_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32 \
    -o "$OUT/decoder.mjs"
ls -l "$OUT"
rm -rf "$WORK"
