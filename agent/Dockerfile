# ---------------------------------------------------------------------------
# チューナーエージェント (.NET)。
#
# **Native AOT で実行ファイル1個。** 別のPCへ置くときに「まず何かを入れて
# ください」が要らないことが条件なので、ここは外せない。
#
# denpa から見える口は agent/conformance.test.ts が押さえている
# (本物を起こして HTTP で当てる)。入れ替えはイメージのタグを変えるだけ。
# ---------------------------------------------------------------------------
# 既定のイメージがそのまま trixie (`-trixie` という札は無い)
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /build
# AOT のリンクに clang と zlib が要る
RUN apt-get update && \
    apt-get -y --no-install-recommends install clang zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
COPY agent/Denpa.Agent/ Denpa.Agent/
RUN dotnet publish Denpa.Agent/Denpa.Agent.csproj -c Release -r linux-x64 -o /out

# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim

# **`recisdb` は入れません。** 選局は自分でやり (ioctl)、B25 も自分で解きます。
#
# libaribb25       … B25 の復号。`recisdb` が中で使っていたものと同じ実装
# pcscd/pcsc-tools … B-CASカードを読む。denpa 側からは触れない。PX-Q3U4 の内蔵
#                    リーダーもここに IFD ハンドラで登録する (下の px4-userland)
# util-linux       … setsid。設定に選局コマンドを書いたときだけ使う逃げ道
# renovate: datasource=github-releases depName=tsukumijima/libaribb25 extractVersion=^v(?<version>.*)$
ARG ARIBB25_VERSION=0.2.10
RUN apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates procps util-linux \
        pcscd pcsc-tools tzdata && \
    cd /tmp && \
    curl -fsSLO https://github.com/tsukumijima/libaribb25/releases/download/v${ARIBB25_VERSION}/libaribb25_${ARIBB25_VERSION}_amd64.deb && \
    apt-get -y --no-install-recommends install ./libaribb25_${ARIBB25_VERSION}_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# ---------------------------------------------------------------------------
# PLEX PX-Q3U4 は px4-userland で掴む (Q3u4.cs)。**カーネルドライバを入れてもらわない。**
#
# px4d / px4-ts / px4ctl は musl の完全静的 ELF。IFD ハンドラ (ifd/*.so) だけが
# glibc に依るので、glibc 版のアーカイブを取る (trixie は glibc 2.41 ≥ 2.31)。
# 配布アーカイブの SHA256SUMS で中身を確かめてから展開する。
#
# **ファームウェア (it930x-firmware.bin) も同梱する。** 本体には入っておらず、
# 挿すたびにホストから流し込むもので、px4-userland は受理する版を SHA-256 で
# 1つに固定している。取ってくる先は tsukumijima/px4_drv が `etc/` に置いている
# 抽出済みのもの (同じハッシュであることを確かめる)。元は PLEX の Windows
# ドライバ (PXW3U4.sys) から切り出したもので、再配布の許諾は誰も持っていない —
# tsukumijima 版が黙認されている実態に乗る判断 (docs/agent.md)。
# ---------------------------------------------------------------------------
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
ARG PX4_USERLAND_VERSION=0.1.3
# renovate: datasource=git-refs depName=https://github.com/tsukumijima/px4_drv branch=develop
ARG PX4_DRV_COMMIT=c995c10138368283a720cec4fcbca157ccc0dbd3
# px4-userland SPEC 4.5 が受理する唯一のイメージ (2,169 バイト)
ARG IT930X_FIRMWARE_SHA256=5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484
RUN set -eu && cd /tmp && \
    base="https://github.com/Khronos31/px4-userland/releases/download/v${PX4_USERLAND_VERSION}" && \
    archive="px4-userland-${PX4_USERLAND_VERSION}-linux-glibc-x86_64.tar.gz" && \
    curl -fsSLO "${base}/${archive}" && curl -fsSLO "${base}/SHA256SUMS" && \
    sha256sum -c --ignore-missing SHA256SUMS && \
    mkdir -p /opt/px4-userland/firmware && tar -xzf "${archive}" -C /opt/px4-userland && \
    curl -fsSL -o /opt/px4-userland/firmware/it930x-firmware.bin \
        "https://raw.githubusercontent.com/tsukumijima/px4_drv/${PX4_DRV_COMMIT}/etc/it930x-firmware.bin" && \
    echo "${IT930X_FIRMWARE_SHA256}  /opt/px4-userland/firmware/it930x-firmware.bin" | sha256sum -c - && \
    rm -rf /tmp/*

# 設定は PVC (/app-config) に置く。**どちらも denpa の画面が書く。**
#
# **どちらも無くて構わない。** tuners.json が無ければ刺さっている機材を
# 自分で見つけるし、channels.json はスキャンするまで空でよい。
ENV TUNERS_FILE=/app-config/tuners.json \
    CHANNELS_FILE=/app-config/channels.json
COPY --from=build /out/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
