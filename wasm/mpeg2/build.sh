#!/bin/bash
# 放送の MPEG-2 と AAC (と、画面の canvas で描く経路の Opus) をデコードする WebAssembly を組む (docs/stream.md#放送そのままmpeg-2を送る)。
#
#   build.sh <FFmpeg のソース> <出口>
#
# emscripten/emsdk の中で動かす (Dockerfile の `mpeg2wasm` 段)。出口に
# decoder.mjs (ローダー) と decoder.wasm ができる。
#
# **組むのは mpeg2video のデコーダと、フレームの区切りを探す parser と、AAC・Opus のデコーダだけ。**
# 他は全部切る (`--disable-everything`)。AAC はブラウザの AudioDecoder に任せていたが、
# https でしか出てこず iPhone の Safari には iOS 26 まで無いので、こちらでデコードする。
# AAC の parser は組まない — ADTS の区切りと時刻は JS (ts/pes.ts の AdtsSplitter) が付ける。
#
# **Opus のデコーダも組む** (AV1 と組んで送られてくる fMP4 の音。ライブ・追っかけを canvas で
# 描く経路 — 車載ブラウザなど <video> が止まる端末向け)。Opus のデコーダは swresample を当てにする
# (SILK の 8〜24kHz を 48kHz に揃える) ので、swresample だけは切らずに残す
#
# - `--disable-asm` … x86 の手書きアセンブリは wasm では使えない
# - スレッドも SIMD も使わない。スレッド版は SharedArrayBuffer のために COOP/COEP
#   (crossOriginIsolated) を全ページに要求することになり、denpa の画面 (データ放送の
#   中継・ロゴ・別オリジンの Hybridcast) と噛み合わない。実測で 1 本でも 1080i を
#   実時間の 3 倍でデコードできたので払う理由が無い。SIMD も 1 割ほどしか変わらなかった
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
    --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale \
    --disable-everything --enable-decoder=mpeg2video,aac,opus --enable-parser=mpegvideo \
    --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
    --extra-cflags=-O3 >configure.log
emmake make -j"$(nproc)" >make.log 2>&1 || { tail -50 make.log; exit 1; }
emmake make install >/dev/null

mkdir -p "$OUT"
# **ローダーは ES の module にして、ワーカーの中からだけ読む** (ENVIRONMENT=worker)。
# ファイルの読み書き (FILESYSTEM) は使わないので外す — それだけで 40KB ほど縮む
emcc -O3 "$HERE/decoder.c" -I"$PREFIX/include" -L"$PREFIX/lib" -lavcodec -lswresample -lavutil \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=1GB \
    -sENVIRONMENT=worker -sFILESYSTEM=0 \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDecoder \
    -sEXPORTED_FUNCTIONS=_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32 \
    -o "$OUT/decoder.mjs"
ls -l "$OUT"
rm -rf "$WORK"
