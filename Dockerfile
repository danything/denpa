# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# ---------------------------------------------------------------------------
# 依存の解決だけを分ける。ソースを変えてもここは再実行されない
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
# ワークスペース (packages/) の package.json も、依存を解くのに要る
COPY packages/arib/package.json packages/arib/
RUN bun install

# ---------------------------------------------------------------------------
# 放送の MPEG-2・AAC と、互換モードの Opus をブラウザでデコードする WebAssembly (docs/stream.md#デコーダ)
#
# **ブラウザには MPEG-2 のデコーダが無い**ので、FFmpeg を組んで持ち込む。出てくるのは decoder.mjs と
# decoder.wasm の2つで (大きさは docs/stream.md#デコーダ)、どの arch で組んでも中身は同じ (wasm なので)。
# **置き場はアプリの外** (/opt/denpa/mpeg2) — 開発と E2E の compose はソースを /app に被せるので、
# /app の中に置くと隠れる。配るのは `/api/live/mpeg2/<名前>` (MPEG2_DIR を読む)。
#
# FFmpeg は下の `ffmpeg` 段と同じバージョンに揃える (Renovate が同じ PR で2か所とも上げる)。
# 組むのは要るデコーダだけなので、2分ほどで終わる
#
# **組むのは mpeg2video のデコーダと、フレームの区切りを探す parser と、AAC・Opus のデコーダだけ。**
# 他は全部切る (`--disable-everything`)。AAC の parser は組まない — ADTS の区切りと時刻は JS
# (packages/arib/src/pes.ts の AdtsSplitter) が付ける。Opus は AV1 と組んで送られてくる fMP4 の音 (互換モード)。
# Opus のデコーダは swresample を当てにする (SILK の 8〜24kHz を 48kHz に揃える) ので、swresample だけは切らずに残す
#
# - `--disable-asm` … x86 の手書きアセンブリは wasm では使えない
# - スレッドは使わない。SharedArrayBuffer のために COOP/COEP (crossOriginIsolated) が要り、効くのは
#   https の Chrome・Edge・Firefox だけで、重くて困るはずの iPhone・iPad には効かない
#   (docs/stream.md「スライスのスレッドを見送った理由」)
# - **SIMD は付けておく** (`-msimd128`。コンパイラが自動でベクトルにする)。MPEG-2 では測っても差が揺れの中だった
#   (FFmpeg の WASM の SIMD は HEVC にしか無い。docs/stream.md「組み方を変えて測ったこと」)。今のブラウザはどれも対応している
# - **LTO を掛ける** (`-flto`)。デコードが 2〜8% 速くなり、brotli 後はかえって 2 KB ほど縮む (同じ節)
# - **ローダーは ES の module にして、ワーカーの中からだけ読む** (`ENVIRONMENT=worker`)。
#   ファイルの読み書き (`FILESYSTEM`) は使わないので外す — それだけで 40KB ほど縮む
# ---------------------------------------------------------------------------
FROM docker.io/emscripten/emsdk:6.0.13@sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a AS mpeg2wasm
# renovate: datasource=github-tags depName=FFmpeg/FFmpeg extractVersion=^n(?<version>.*)$
ARG FFMPEG_VERSION=9.0.2
COPY wasm/decoder.c /src/decoder.c
RUN <<'EOF'
#!/bin/bash
set -euo pipefail
mkdir /tmp/ffmpeg /tmp/build
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" | tar -xj --strip-components=1 -C /tmp/ffmpeg
cd /tmp/build
emconfigure /tmp/ffmpeg/configure \
  --prefix=/tmp/build/prefix --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-stripping \
  --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect \
  --disable-autodetect --disable-network --disable-pthreads \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale \
  --disable-everything --enable-decoder=mpeg2video,aac,opus --enable-parser=mpegvideo \
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
  --extra-cflags="-O3 -msimd128 -flto" >configure.log
emmake make -j"$(nproc)" >make.log 2>&1 || { tail -50 make.log; exit 1; }
emmake make install >/dev/null
mkdir -p /opt/denpa/mpeg2
emcc -O3 -msimd128 -flto /src/decoder.c -I/tmp/build/prefix/include -L/tmp/build/prefix/lib -lavcodec -lswresample -lavutil \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=1GB \
  -sENVIRONMENT=worker -sFILESYSTEM=0 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDecoder \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32 \
  -o /opt/denpa/mpeg2/decoder.mjs
ls -l /opt/denpa/mpeg2
rm -rf /tmp/ffmpeg /tmp/build
EOF

# 組んだ2つだけを取り出す段。**CI の E2E はイメージを使わずランナーで回す**ので、
# `docker buildx build --target mpeg2wasm-out --output type=local,dest=…` でここだけ手元へ出す
# (上の段をそのまま出すと emsdk ごと 3GB 出てくる)
FROM scratch AS mpeg2wasm-out
COPY --from=mpeg2wasm /opt/denpa/mpeg2 /

# ---------------------------------------------------------------------------
# データ放送と字幕、画面の放送の字を描くブラウザに渡す字 (Denpa Font。danything/denpa-font のリリースの woff2。
# `/api/font/denpa-font.woff2` が配る)。BML は**等幅・丸ゴシック・ARIB外字**を要求していて、
# この1本が3つとも満たす (借りている側は Kosugi を 4.4MB ぶん抱えているが、外字は入っていない)。
# **留めるのはタグだけ** (Renovate はタグだけ上げればよい)。中身は同じリリースの SHA256SUMS で照らす。
# 画面はこのタグを URL に付けて1年持たせる (vite.config.ts がこの行を読む)。配る側は VERSION と
# 照らし、合うときだけ immutable にする (src/lib/server/font.ts)。
# 段を分けてあるのは、本番イメージと画像を撮るイメージ (下の `docs` 段) の両方に同じものを置くため
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS denpa-font
# renovate: datasource=github-releases depName=danything/denpa-font
ARG DENPA_FONT_VERSION=v3.4
ADD --chmod=644 https://github.com/danything/denpa-font/releases/download/${DENPA_FONT_VERSION}/SHA256SUMS \
    https://github.com/danything/denpa-font/releases/download/${DENPA_FONT_VERSION}/denpa-font.woff2 \
    /usr/share/denpa-font/
RUN cd /usr/share/denpa-font && grep ' denpa-font.woff2$' SHA256SUMS | sha256sum -c - && rm SHA256SUMS && \
    printf '%s\n' "$DENPA_FONT_VERSION" > VERSION

# ---------------------------------------------------------------------------
# 開発用。compose からソースを bind mount して使う
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
# **ブラウザへ配るデコーダ** (上の `mpeg2wasm` 段)。/app の外に置くので bind mount に隠れない
COPY --from=mpeg2wasm /opt/denpa/mpeg2 /opt/denpa/mpeg2
COPY . .
EXPOSE 5173
CMD ["bun", "run", "dev", "--host", "0.0.0.0", "--port", "5173"]

# ---------------------------------------------------------------------------
# E2E用。Playwright のブラウザを入れる
# ---------------------------------------------------------------------------
FROM dev AS test
ENV CI=1
RUN bunx playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*
CMD ["bun", "run", "test"]

# ---------------------------------------------------------------------------
# README・docs の画像を撮る (scripts/capture-docs.ts。docs/development.md「README の画像」)。
# E2E のイメージに、画像に出る字と、本物の ffmpeg (作り物の録画を組み、撮った画像を WebP にする) を足す
# ---------------------------------------------------------------------------
FROM test AS docs
RUN apt-get update && \
    apt-get -y --no-install-recommends install ffmpeg && \
    rm -rf /var/lib/apt/lists/*
# 画面の字。app.css が最初に挙げる BIZ UDPゴシックは Windows には入っているが、ここには無い。
# OFL で配られているもの (google/fonts) をコミットで留め、中身を照らす
ARG BIZ_UD_COMMIT=6ce172f74aa355ea43eb964fa4a91570a4d3064d
ADD --chmod=644 https://raw.githubusercontent.com/google/fonts/${BIZ_UD_COMMIT}/ofl/bizudpgothic/BIZUDPGothic-Regular.ttf \
    https://raw.githubusercontent.com/google/fonts/${BIZ_UD_COMMIT}/ofl/bizudpgothic/BIZUDPGothic-Bold.ttf \
    /usr/share/fonts/truetype/biz-ud/
RUN cd /usr/share/fonts/truetype/biz-ud && \
    printf '%s  %s\n' \
      258d7156c165f2ff774b6efee637c22c3b950de0d8a10e501137061bc8085d01 BIZUDPGothic-Regular.ttf \
      30eba52fc837e8b62c97d4b82e6706583149fb7294e3712dd71a655eaea80a90 BIZUDPGothic-Bold.ttf | sha256sum -c - && \
    fc-cache -f
# 放送の字 (Denpa Font)。本番と同じものを同じ場所に置く (`/api/font/denpa-font.woff2` が読む)
COPY --from=denpa-font /usr/share/denpa-font /usr/share/denpa-font
ENV FFPROBE=/usr/bin/ffprobe
CMD ["bun", "scripts/capture-docs.ts"]

# ---------------------------------------------------------------------------
# ffmpeg (自前ビルド。AV1 libsvtav1/dav1d + H.264 x264 + Opus + Intel GPU (VA-API/QSV)。
# 上流に投げる直しがあれば patches/ から当てる。ARIB 字幕はデコードせずに写すだけなので
# デコーダ (libaribcaption) は組み込まない — `-c:s copy` にデコーダは要らない)
# ---------------------------------------------------------------------------
# **土台のイメージはどれも digest で固定する** (debian は ffmpeg / runtime-libs / denpa-font で同じもの。
# agent/Dockerfile も同じ)。タグだけだと月に何度か中身が入れ替わり、CI は `pull: true` なので
# その日の push が — CSS を1行直しただけでも — ffmpeg の組み直し (10分強) に巻き込まれる。
# 固定しておけば組み直すのは Renovate が digest を上げる PR のときだけになる
FROM docker.io/library/debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS ffmpeg
SHELL ["/bin/bash", "-c"]
# **arch ごとに、その arch のランナーで組む** (CI は amd64 と arm64 を別の機械で。QEMU で
# ffmpeg を組むと何倍も掛かる)。digest は複数 arch の索引を指しているので、上の FROM は
# 組む arch のものを引く。違うのは Intel の QSV だけ (下の説明)
ARG TARGETARCH

# ダウンロードは CI で切られることがあるので必ずリトライさせる。
# 一度これで ffmpeg の取得に失敗してデプロイが止まった
ENV CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"

# libvpl-dev / libva-dev は Intel の GPU (QSV) 向け (docs/encode.md「GPU でエンコードする」)。
# ffmpeg に libvpl (QSV = h264_qsv / av1_qsv) を組み込み、実行イメージにドライバを
# 入れてある。コンテナから /dev/dri が見えれば、起動時に src/lib/server/hwenc.ts が試しのエンコードで
# 見つけて使い、無ければソフトウェア (libsvtav1 / libx264) でエンコードする。
# **libva は QSV の下に必ずいる** (Linux では libvpl → libmfx-gen → libva → /dev/dri)。
# vaapi も有効にしてあるのは、QSV が初期化できない機種の逃げ道 (h264_vaapi) のため
#
# **QSV (libvpl) は amd64 だけ。** Debian の libvpl / libmfx-gen / intel-media-va-driver は
# amd64 にしか無い (Intel の GPU が載る arm の機械は無い)。arm64 では libvpl を外して組み、
# VA-API だけ残す — 起動時の試しのエンコード (src/lib/server/hwenc.ts) で QSV が落ちて、VA-API か
# ソフトウェアでエンコードするだけなので、denpa の側は何も変えない
ENV DEV="curl ca-certificates build-essential cmake pkg-config nasm patch zlib1g-dev libopus-dev libx264-dev libdav1d-dev libva-dev"

# renovate: datasource=github-tags depName=FFmpeg/FFmpeg extractVersion=^n(?<version>.*)$
ENV FFMPEG_VERSION=9.0.2
# SVT-AV1 は**上流の最新をソースから組む** (Debian trixie のパッケージは 2 系で古い。
# 3 系以降は速度も画質も別物)。libavcodec の .so に静的に繋ぐので、SVT-AV1 の共有ライブラリは要らない
# (そのために `-DCMAKE_POSITION_INDEPENDENT_CODE=ON` で組む)
# renovate: datasource=gitlab-tags depName=AOMediaCodec/SVT-AV1 registryUrl=https://gitlab.com
ARG SVT_AV1_VERSION=v4.2.0

# **上流に投げるつもりの直しだけを当てる** (patches/README.md。いまは無い)。`--fuzz=0` は、
# ffmpeg を上げて当たらなくなったら黙ってずれて当たるより、ビルドを止めてほしいため
COPY patches/ /patches/

# **libav* は共有ライブラリで組む** (`--enable-shared --disable-static`)。静的に組むと ffmpeg と
# ffprobe がそれぞれ libav* と SVT-AV1 を丸ごと抱え、同じ中身 (37MB ずつ) がイメージに2つ入る。
# ライブラリは /usr/local/lib に置き、`--enable-rpath` で ffmpeg / ffprobe にその場所を書き込む
# (ld.so の既定の検索先ではないので、ldconfig や LD_LIBRARY_PATH に頼らない)。
# 実行イメージへ運ぶものは /out にまとめる。.so のバージョン付きの symlink は運ばず、実行時に読まれる
# SONAME の名前 (libavcodec.so.63 など) の実体だけを置く — COPY で symlink を辿ると同じ中身が並ぶため
RUN case "${TARGETARCH}" in \
      amd64) qsv_dev=libvpl-dev qsv_flag=--enable-libvpl ;; \
      arm64) qsv_dev="" qsv_flag="" ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    apt-get update && \
    apt-get -y --no-install-recommends install $DEV $qsv_dev && \
    mkdir /tmp/svtav1 && cd /tmp/svtav1 && \
    $CURL https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz | tar -xz --strip-components=1 && \
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON && \
    cmake --build build -j$(nproc) && cmake --install build && \
    mkdir /tmp/ffmpeg_sources && cd /tmp/ffmpeg_sources && \
    $CURL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 && \
    for p in /patches/ffmpeg-*.patch; do [ -e "$p" ] || continue; patch -p1 --fuzz=0 < "$p"; done && \
    ./configure \
      --enable-gpl \
      --enable-shared \
      --disable-static \
      --enable-rpath \
      --pkg-config-flags="--static" \
      --enable-libopus \
      --enable-libsvtav1 \
      --enable-libx264 \
      --enable-libdav1d \
      --enable-vaapi \
      $qsv_flag \
    && \
    make -j$(nproc) && make install && \
    mkdir -p /out/bin /out/lib && \
    cp /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /out/bin/ && \
    for lib in /usr/local/lib/lib*.so.*; do \
      case "${lib##*.so.}" in *.*) ;; *) cp -L "$lib" /out/lib/ ;; esac; \
    done && \
    rm -rf /var/lib/apt/lists/* /tmp/*

# ---------------------------------------------------------------------------
# 本番ビルド
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# 本番イメージの土台 (distroless。Debian 13 = trixie から glibc・libstdc++・zlib・ca-certificates・
# tzdata など要るものだけを置いたもの)。下の `runtime-libs` 段が「土台にもうあるライブラリ」を
# 見分けるのにも使うので、段に名前を付けておく
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian13:latest@sha256:d74d144baa124dd9defd01d71872bb56c49d4441dba6153ccf790364f97e64b1 AS distroless

# ---------------------------------------------------------------------------
# 本番イメージへ写すライブラリを集める段。**本番イメージにはシェルも apt も無い**ので、
# ここで Debian のパッケージを入れて ffmpeg を置き、要るファイルだけを /rootfs にまとめる。
# 土台は ffmpeg 段と同じ digest (どちらも trixie なので、glibc のバージョンは distroless と揃う)
#
# libvpl2 + libmfx-gen1.2 (QSV のランタイム) + libva* + intel-media-va-driver (iHD) は
# Intel の GPU (QSV / VA-API) 向け (上の ffmpeg 段の説明)。GPU の無い機械でも害は無い
# (起動時の試しのエンコードが落ちて、ソフトウェアでエンコードするだけ)。**Intel の4つは amd64 だけ**
# (ffmpeg 段の説明。arm64 の Debian には無い)。libva は arm64 にも入れる。
# i965-va-driver は iHD が対応しない古い世代 (Haswell など) の内蔵 GPU 用。
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS runtime-libs
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) intel="libvpl2 intel-media-va-driver i965-va-driver libmfx-gen1.2" ;; \
      arm64) intel="" ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    apt-get update && \
    apt-get -y --no-install-recommends install \
      libopus0 libx264-164 libdav1d7 \
      libva2 libva-drm2 $intel && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ffmpeg / ffprobe と、2つが共有する libav* (`ffmpeg` 段の説明)
COPY --from=ffmpeg /out/bin/ /usr/local/bin/
COPY --from=ffmpeg /out/lib/ /usr/local/lib/

# /rootfs に写すもの:
# - ffmpeg / ffprobe / libav* と、それらが繋ぐライブラリ (ldd で辿る)
# - **dlopen で読むもの** (ldd には出ない): libva のドライバ (dri/ の iHD・i965) と、libvpl が読む
#   QSV のランタイム (libmfx-gen.so.1.2 と、それがさらに読む libmfx-gen/)。ドライバはディレクトリ
#   ごと写し、それらが繋ぐライブラリも ldd で辿る
# **土台 (distroless) にもうあるもの (glibc・libstdc++・zlib など) は写さない** (名前で見分ける)。
# 写したライブラリのパッケージの記録 (status.d) と copyright も置く — distroless と同じ置き方で、
# 脆弱性の検査やライセンスの確かめが中身を読めるように。
# 依存が見つからなければここでビルドを止める (起動してからエンコードで落ちるより早く分かる)
RUN --mount=type=bind,from=distroless,target=/distroless \
    shopt -s nullglob && \
    ffmpeg -hide_banner -version > /dev/null && ffprobe -hide_banner -version > /dev/null && \
    lib="/usr/lib/$(uname -m)-linux-gnu" && \
    mkdir -p /rootfs/usr/local/bin /rootfs/usr/local/lib "/rootfs${lib}" /rootfs/var/lib/dpkg/status.d && \
    cp -a /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /rootfs/usr/local/bin/ && \
    cp -a /usr/local/lib/lib*.so.* /rootfs/usr/local/lib/ && \
    targets=(/usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/lib/lib*.so.*) && \
    owned=() && \
    for dir in "${lib}/dri" "${lib}/libmfx-gen"; do \
      [ -d "$dir" ] || continue; \
      cp -a "$dir" "/rootfs${lib}/"; \
      targets+=("$dir"/*.so); owned+=("$dir"/*.so); \
    done && \
    if [ -e "${lib}/libmfx-gen.so.1.2" ]; then \
      cp -L "${lib}/libmfx-gen.so.1.2" "/rootfs${lib}/"; \
      targets+=("${lib}/libmfx-gen.so.1.2"); owned+=("${lib}/libmfx-gen.so.1.2"); \
    fi && \
    if ldd "${targets[@]}" | grep 'not found'; then echo "足りないライブラリがあります" >&2; exit 1; fi && \
    for dep in $(ldd "${targets[@]}" | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | sort -u); do \
      name=$(basename "$dep"); \
      case "$dep" in /usr/local/lib/*) continue ;; esac; \
      [ -e "/distroless${lib}/${name}" ] && continue; \
      cp -L "$dep" "/rootfs${lib}/${name}"; \
      owned+=("$(realpath "$dep")"); \
    done && \
    owners=$(dpkg -S "${owned[@]}") && \
    for pkg in $(cut -d: -f1 <<< "$owners" | sort -u); do \
      dpkg -s "$pkg" > "/rootfs/var/lib/dpkg/status.d/${pkg}"; \
      if [ -f "/usr/share/doc/${pkg}/copyright" ]; then \
        install -D -m 644 "/usr/share/doc/${pkg}/copyright" "/rootfs/usr/share/doc/${pkg}/copyright"; \
      fi; \
    done && \
    find /rootfs -type f | sort

# ---------------------------------------------------------------------------
# 本番イメージ
#
# **土台は distroless** (上の `distroless` 段)。シェルも apt も coreutils も無い。
# denpa が子プロセスとして起こすのは ffmpeg / ffprobe だけで、どれもシェルを通さずに起こす
# (Bun.spawn に引数の配列を渡す)。時刻 (TZ) と証明書は土台の tzdata と ca-certificates を使う。
# **`latest` (root で動く) を使う。`nonroot` にはしない。** 今までどおり root で動かす
# (/data や録画の置き場の持ち主と、/dev/dri を開く権限を変えないため)。
# 中を見たいときはシェルのあるコンテナを横に付ける (docs/development.md)
# ---------------------------------------------------------------------------
FROM distroless AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    FFMPEG=/usr/local/bin/ffmpeg \
    FFPROBE=/usr/local/bin/ffprobe

# B-CASカードは触らない。掛かったまま録れたTSの解除はチューナーエージェントに
# 投げる(カードリーダーとやり取りするのはあちら)。recisdb も libpcsclite も要らない
COPY --from=runtime-libs /rootfs/ /

# bun 本体。SvelteKit (adapter-bun) の出力を bun で動かす
COPY --from=docker.io/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 /usr/local/bin/bun /usr/local/bin/bun

# 写したライブラリだけで ffmpeg / ffprobe が起きるかを、本番の中身でも見る (シェルが無いので exec の形で)
RUN ["/usr/local/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-version"]
RUN ["/usr/local/bin/ffprobe", "-hide_banner", "-loglevel", "error", "-version"]

# データ放送と字幕を描くブラウザに渡す字 (Denpa Font。上の `denpa-font` 段)
COPY --from=denpa-font /usr/share/denpa-font /usr/share/denpa-font

# ブラウザへ配るデコーダ (MPEG-2・AAC・Opus。`mpeg2wasm` 段)
COPY --from=mpeg2wasm /opt/denpa/mpeg2 /opt/denpa/mpeg2

# **node_modules は載せない。**
#
# adapter-bun の出力は要るものを畳み込んでいて、外から引くのは `node:*` と
# bun の組み込み (`bun:sqlite`) だけ。載せていた頃は playwright も vite も
# typescript もイメージに入っていて、**312MB がまるごと無駄**だった。
# 置くのは下のものだけ: build/ (アプリ)、server.js (入口) とそれが読む
# src/lib/server/address.ts・compress.ts、package.json (`"type": "module"` の宣言)、drizzle/
# (マイグレーション)。これで起動して /api/health が答えるかは CI で毎回見ている
# (.github/image-smoke.sh。PR の docker-build-check と、push の前の build-and-deploy)
#
# 引き換えに、**外から引くものを増やすなら畳み込ませること** — package.json の
# `dependencies` に足すと adapter-bun がそれを外に出すので、ここで転ぶ。
# 依存を全部 devDependencies に置いて `dependencies` を空にしてあるのはそのため
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
# DB のマイグレーション (drizzle-kit が出した SQL)。起動時に `drizzle/` を cwd から
# 読んで当てる (src/lib/server/db.ts)。束ねられないので SQL ファイルのまま置く
COPY --from=build /app/drizzle ./drizzle
# ライブ視聴の WebSocket を受ける入口。中身の理由はファイルの頭に書いてある
COPY --from=build /app/server.js ./server.js
# 入口が接続元を決めるのに使う (アプリと同じものを共有する。bun は .ts をそのまま読む)
COPY --from=build /app/src/lib/server/address.ts ./src/lib/server/address.ts
# 入口が画面の HTML とデータを縮めるのに使う (`src/lib/server/compress.ts`。同じく `node:zlib` しか引かない)
COPY --from=build /app/src/lib/server/compress.ts ./src/lib/server/compress.ts

EXPOSE 3000
# 動いているバージョン。ここでは `dev` のまま — リリースのときに、このイメージを土台に
# バージョンを 1 層足す (.github/release.Dockerfile)。新しいバージョンの通知はそれと GitHub の
# 最新のリリースを数で比べて出す (src/lib/server/update.ts)。dev では出さない
ENV DENPA_VERSION=dev

CMD ["bun", "./server.js"]
