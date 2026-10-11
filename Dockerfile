# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 依存の解決だけを分ける。ソースを変えてもここは再実行されない
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install

# ---------------------------------------------------------------------------
# 放送の MPEG-2 と AAC をブラウザで解く WebAssembly (docs/stream.md §5.5「生で送る」)
#
# **ブラウザには MPEG-2 の復号器が無い**ので、FFmpeg の mpeg2video と aac だけを組んで
# 持ち込む。出てくるのは decoder.mjs と decoder.wasm の2つ (wasm 855KB + mjs 14KB で 870KB ほど) で、
# どの arch で組んでも中身は同じ (wasm なので)。**置き場はアプリの外** (/opt/denpa/mpeg2) —
# 開発と E2E の compose はソースを /app に被せるので、/app の中に置くと隠れる。
# 配るのは `/api/live/mpeg2/<名前>` (MPEG2_DIR を読む)。
#
# FFmpeg は下の `ffmpeg` 段と同じ版に揃える (Renovate が同じ PR で2か所とも上げる)。
# 組むのは復号器1つだけなので、1〜2分で終わる
# ---------------------------------------------------------------------------
FROM docker.io/emscripten/emsdk:6.0.12 AS mpeg2wasm
# renovate: datasource=github-tags depName=FFmpeg/FFmpeg extractVersion=^n(?<version>.*)$
ARG FFMPEG_VERSION=9.0.2
COPY wasm/mpeg2/ /src/mpeg2/
RUN mkdir /tmp/ffmpeg && \
    curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20 \
      https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 -C /tmp/ffmpeg && \
    bash /src/mpeg2/build.sh /tmp/ffmpeg /opt/denpa/mpeg2 && \
    rm -rf /tmp/ffmpeg

# 組んだ2つだけを取り出す口。**CI の E2E はイメージを使わずランナーで回す**ので、
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
# 段を分けてあるのは、本番イメージと絵を撮るイメージ (下の `docs` 段) の両方に同じものを置くため
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS denpa-font
# renovate: datasource=github-releases depName=danything/denpa-font
ARG DENPA_FONT_VERSION=v3.1
ADD --chmod=644 https://github.com/danything/denpa-font/releases/download/${DENPA_FONT_VERSION}/SHA256SUMS \
    https://github.com/danything/denpa-font/releases/download/${DENPA_FONT_VERSION}/denpa-font.woff2 \
    /usr/share/denpa-font/
RUN cd /usr/share/denpa-font && grep ' denpa-font.woff2$' SHA256SUMS | sha256sum -c - && rm SHA256SUMS && \
    printf '%s\n' "$DENPA_FONT_VERSION" > VERSION

# ---------------------------------------------------------------------------
# 開発用。compose からソースを bind mount して使う
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1.4-slim AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
# **ライブを生で送る道の復号器** (上の段)。/app の外に置くので bind mount に隠れない
COPY --from=mpeg2wasm /opt/denpa/mpeg2 /opt/denpa/mpeg2
COPY . .
EXPOSE 5173
CMD ["bun", "run", "dev", "--host", "0.0.0.0", "--port", "5173"]

# ---------------------------------------------------------------------------
# E2E用。Playwright のブラウザを焼き込む
# ---------------------------------------------------------------------------
FROM dev AS test
ENV CI=1
RUN bunx playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*
CMD ["bun", "run", "test"]

# ---------------------------------------------------------------------------
# README・docs の絵を撮る (scripts/capture-docs.ts。docs/development.md「README の絵」)。
# E2E のイメージに、絵に出る字と、作り物の録画を組む本物の ffmpeg を足す
# ---------------------------------------------------------------------------
FROM test AS docs
RUN apt-get update && \
    apt-get -y --no-install-recommends install ffmpeg python3-pil && \
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
# 上流に投げる直しがあれば patches/ から当てる。ARIB 字幕は解かずに写すだけなので
# 復号器 (libaribcaption) は組み込まない — `-c:s copy` に復号器は要らない)
# ---------------------------------------------------------------------------
# **debian は digest で固定する** (ffmpeg / runtime の2つとも同じもの)。
# 札 (`trixie-slim`) だけだと月に何度か中身が入れ替わり、CI は `pull: true` なので
# その日の push が — CSS を1行直しただけでも — ffmpeg の組み直し (10分強) に巻き込まれる。
# 固定しておけば組み直すのは Renovate が digest を上げる PR のときだけになる
FROM docker.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS ffmpeg
SHELL ["/bin/bash", "-c"]
# **arch ごとに、その arch のランナーで組む** (CI は amd64 と arm64 を別の機械で。QEMU で
# ffmpeg を組むと何倍も掛かる)。digest は複数 arch の索引を指しているので、上の FROM は
# 組む arch のものを引く。違うのは Intel の QSV だけ (下の説明)
ARG TARGETARCH

# ダウンロードは CI で切られることがあるので必ずリトライさせる。
# 一度これで ffmpeg の取得に失敗してデプロイが止まった
ENV CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"

# libvpl-dev / libva-dev は Intel の GPU (QSV) 向け (docs/encode.md「GPU で焼く」)。
# ffmpeg に libvpl (QSV = h264_qsv / av1_qsv) を組み込み、実行イメージにドライバを
# 入れてある。コンテナから /dev/dri が見えれば、起動時に server/hwenc.ts が試し焼きで
# 見つけて使い、無ければソフトウェア (libsvtav1 / libx264) で焼く。
# **libva は QSV の下に必ず居る** (Linux では libvpl → libmfx-gen → libva → /dev/dri)。
# vaapi も有効にしてあるのは、QSV が初期化できない機種の逃げ道 (h264_vaapi) のため
#
# **QSV (libvpl) は amd64 だけ。** Debian の libvpl / libmfx-gen / intel-media-va-driver は
# amd64 にしか無い (Intel の GPU が載る arm の機械は無い)。arm64 では libvpl を外して組み、
# VA-API だけ残す — 起動時の試し焼き (server/hwenc.ts) で QSV が落ちて、VA-API か
# ソフトウェアで焼くだけなので、denpa の側は何も変えない
ENV DEV="curl ca-certificates build-essential cmake pkg-config nasm patch zlib1g-dev libopus-dev libx264-dev libdav1d-dev libva-dev"

# renovate: datasource=github-tags depName=FFmpeg/FFmpeg extractVersion=^n(?<version>.*)$
ENV FFMPEG_VERSION=9.0.2
# SVT-AV1 は**上流の最新をソースから組む** (Debian trixie のパッケージは 2 系で古い。
# 3 系以降は速度も画質も別物)。静的に繋ぐので実行イメージに共有ライブラリは要らない
# renovate: datasource=gitlab-tags depName=AOMediaCodec/SVT-AV1 registryUrl=https://gitlab.com
ARG SVT_AV1_VERSION=v4.2.0

# **上流に投げるつもりの直しだけを当てる** (patches/README.md。いまは無い)。`--fuzz=0` は、
# ffmpeg を上げて当たらなくなったら黙ってずれて当たるより、ビルドを止めてほしいため
COPY patches/ /patches/

RUN case "${TARGETARCH}" in \
      amd64) qsv_dev=libvpl-dev qsv_flag=--enable-libvpl ;; \
      arm64) qsv_dev="" qsv_flag="" ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    apt-get update && \
    apt-get -y --no-install-recommends install $DEV $qsv_dev && \
    mkdir /tmp/svtav1 && cd /tmp/svtav1 && \
    $CURL https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/${SVT_AV1_VERSION}/SVT-AV1-${SVT_AV1_VERSION}.tar.gz | tar -xz --strip-components=1 && \
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF && \
    cmake --build build -j$(nproc) && cmake --install build && \
    mkdir /tmp/ffmpeg_sources && cd /tmp/ffmpeg_sources && \
    $CURL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 && \
    for p in /patches/ffmpeg-*.patch; do [ -e "$p" ] || continue; patch -p1 --fuzz=0 < "$p"; done && \
    ./configure \
      --enable-gpl \
      --pkg-config-flags="--static" \
      --enable-libopus \
      --enable-libsvtav1 \
      --enable-libx264 \
      --enable-libdav1d \
      --enable-vaapi \
      $qsv_flag \
    && \
    make -j$(nproc) && make install && \
    rm -rf /var/lib/apt/lists/* /tmp/*

# ---------------------------------------------------------------------------
# 本番ビルド
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# 本番イメージ
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    FFMPEG=/usr/local/bin/ffmpeg \
    FFPROBE=/usr/local/bin/ffprobe

# B-CASカードは触らない。掛かったまま録れたTSの解除はチューナーエージェントに
# 投げる(カードリーダーを叩くのはあちら)。recisdb も libpcsclite も要らない
# libvpl2 + libmfx-gen1.2 (QSV のランタイム) + libva* + intel-media-va-driver (iHD) は
# Intel の GPU (QSV / VA-API) 向け (上の ffmpeg 段の説明)。GPU の無い機械でも害は無い
# (起動時の試し焼きが落ちて、ソフトウェアで焼くだけ)。**Intel の3つは amd64 だけ**
# (ffmpeg 段の説明。arm64 の Debian には無い)。libva は arm64 にも入れる
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) intel="libvpl2 intel-media-va-driver libmfx-gen1.2" ;; \
      arm64) intel="" ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    apt-get update && \
    apt-get -y --no-install-recommends install \
      libopus0 libx264-164 libdav1d7 \
      libva2 libva-drm2 $intel \
      ca-certificates tzdata && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# bun 本体。SvelteKit(adapter-node) の出力を bun で動かす
COPY --from=docker.io/oven/bun:1.4-slim /usr/local/bin/bun /usr/local/bin/bun

COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/

# データ放送と字幕を描くブラウザに渡す字 (Denpa Font。上の `denpa-font` 段)
COPY --from=denpa-font /usr/share/denpa-font /usr/share/denpa-font

# ライブを生で送るときにブラウザへ配る MPEG-2 と AAC の復号器 (`mpeg2wasm` 段)
COPY --from=mpeg2wasm /opt/denpa/mpeg2 /opt/denpa/mpeg2

# **node_modules は載せない。**
#
# adapter-node の出力は要るものを畳み込んでいて、外から引くのは `node:*` と
# bun の組み込み (`bun:sqlite`) だけ。実際に build/ と server.js だけを置いた
# ところで起動するのを確かめてある。載せていた頃は playwright も vite も
# typescript もイメージに入っていて、**312MB がまるごと無駄**だった。
#
# 引き換えに、**外から引くものを増やすなら畳み込ませること** — package.json の
# `dependencies` に足すと adapter-node がそれを外に出すので、ここで転ぶ。
# 借りものが使う4つを devDependencies に置いてあるのはそのため
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
# DB のマイグレーション (drizzle-kit が出した SQL)。起動時に `drizzle/` を cwd から
# 読んで当てる (src/lib/server/db.ts)。束ねられないので生のまま置く
COPY --from=build /app/drizzle ./drizzle
# ライブ視聴の WebSocket を受ける入口。中身の理由はファイルの頭に書いてある
COPY --from=build /app/server.js ./server.js
# 入口が接続元を決めるのに使う (アプリと同じものを共有する。bun は .ts をそのまま読む)
COPY --from=build /app/src/lib/server/address.ts ./src/lib/server/address.ts

EXPOSE 3000
# 動いている版。ここでは `dev` のまま — リリースのときに、このイメージを土台に
# 版を 1 層足す (.github/release.Dockerfile)。新しい版の知らせはそれと GitHub の
# 最新のリリースを数で比べて出す (src/lib/server/update.ts)。dev では出さない
ENV DENPA_VERSION=dev

CMD ["bun", "./server.js"]
