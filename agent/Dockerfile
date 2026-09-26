# ---------------------------------------------------------------------------
# チューナーエージェント (.NET)。
#
# **Native AOT で実行ファイル1個。** 別のPCへ置くときに「まず何かを入れて
# ください」が要らないことが条件なので、ここは外せない。
#
# denpa から見える口は agent/conformance.test.ts が押さえている
# (本物を起こして HTTP で当てる)。入れ替えはイメージのタグを変えるだけ。
# ---------------------------------------------------------------------------
# **arch ごとに、その arch のランナーで組む** (CI は amd64 を ubuntu-latest、arm64 を
# ubuntu-24.04-arm で。QEMU は使わない)。Native AOT は組む機械と同じ arch の実行ファイルを
# 出すのが素直で、AOT のクロスは clang とリンカの揃え直しが要るので、組む段も
# `--platform=$BUILDPLATFORM` にはしない。
#
# `TARGETARCH` (BuildKit が入れる) から、RID と取ってくる配布物の名前を引く。
# 名前の付け方は上流ごとにばらばら (amd64 / x86_64 / x64、arm64 / aarch64) なので、
# 各段の頭で読み替える。それ以外の arch は配布物が無いので、黙って amd64 のものを
# 入れずにそこで止める
# 既定のイメージがそのまま trixie (`-trixie` という札は無い)
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /build
# AOT のリンクに clang と zlib が要る
RUN apt-get update && \
    apt-get -y --no-install-recommends install clang zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
COPY agent/Denpa.Agent/ Denpa.Agent/
RUN case "${TARGETARCH}" in \
      amd64) rid=linux-x64 ;; \
      arm64) rid=linux-arm64 ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    dotnet publish Denpa.Agent/Denpa.Agent.csproj -c Release -r "${rid}" -o /out

# ---------------------------------------------------------------------------
# IT930x のファームウェア (px4-userland の機材に挿すたびに流し込む)。
#
# **PLEX 公式の Windows ドライバ (PX-W3U4 BDA Ver.1.0 64bit) の PXW3U4.sys から
# 切り出す。** 配布 zip・.sys・切り出したものの3つをハッシュで確かめる。
# px4-userland SPEC 4.5 が受理するのはこの 2,169 バイトの1つだけ。
# 再配布の許諾は誰も持っていないので、そこはこちらが背負う判断 (docs/agent.md)。
#
# arch に依らない中身なので、組む機械の arch で1回だけ作る
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim AS firmware
ARG PLEX_DRIVER_SHA256=bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200
ARG PXW3U4_SYS_SHA256=8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722
ARG IT930X_FIRMWARE_SHA256=5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484
RUN set -eu && cd /tmp && \
    apt-get update && apt-get -y --no-install-recommends install curl ca-certificates unzip && \
    curl -fsSL -o driver.zip https://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip && \
    echo "${PLEX_DRIVER_SHA256}  driver.zip" | sha256sum -c - && \
    unzip -p driver.zip pxw3u4_BDA_ver1x64/PXW3U4.sys > PXW3U4.sys && \
    echo "${PXW3U4_SYS_SHA256}  PXW3U4.sys" | sha256sum -c - && \
    dd if=PXW3U4.sys of=/it930x-firmware.bin bs=1 skip=$((0x287d0)) count=2169 status=none && \
    echo "${IT930X_FIRMWARE_SHA256}  /it930x-firmware.bin" | sha256sum -c -

# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim
ARG TARGETARCH

# **`recisdb` も libaribb25 も pcscd も入れません。** 選局は自分でやり (ioctl)、
# B25 も自分で解き (B25.cs)、カードリーダーとも自分で話します (Ccid.cs / Px4Card.cs)。
RUN case "${TARGETARCH}" in \
      amd64|arm64) ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates procps tzdata && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# ---------------------------------------------------------------------------
# PLEX PX-Q3U4 などは px4-userland で掴む (Px4.cs)。**カーネルドライバを入れてもらわない。**
#
# px4d / px4-ts / px4ctl は musl の完全静的 ELF。同梱の IFD ハンドラ (ifd/*.so) は
# pcscd 用で、ここでは使わない (内蔵カードリーダーには px4d に直に聞く。Px4Card.cs)。
# 配布アーカイブの SHA256SUMS で中身を確かめてから展開する。
#
# **ファームウェア (it930x-firmware.bin) も同梱する。** 本体には入っておらず、
# 挿すたびにホストから流し込むもので、px4-userland は受理する版を SHA-256 で
# 1つに固定している。切り出すのは上の firmware 段。
# ---------------------------------------------------------------------------
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
ARG PX4_USERLAND_VERSION=0.1.6
RUN set -eu && cd /tmp && \
    case "${TARGETARCH}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac && \
    base="https://github.com/Khronos31/px4-userland/releases/download/v${PX4_USERLAND_VERSION}" && \
    archive="px4-userland-${PX4_USERLAND_VERSION}-linux-glibc-${arch}.tar.gz" && \
    curl -fsSLO "${base}/${archive}" && curl -fsSLO "${base}/SHA256SUMS" && \
    sha256sum -c --ignore-missing SHA256SUMS && \
    mkdir -p /opt/px4-userland/firmware && tar -xzf "${archive}" -C /opt/px4-userland && \
    rm -rf /tmp/*
COPY --from=firmware /it930x-firmware.bin /opt/px4-userland/firmware/it930x-firmware.bin

# ---------------------------------------------------------------------------
# PLEX PX-S1UD などの Siano RIO 系は、**カーネルが掴んでいなければ** siano-userland で掴む
# (Siano.cs)。smsusb が掴んでいれば今までどおり /dev/dvb で使う。こちらからは奪わない。
#
# siano-ts は libusb を静的にリンクした libc 非依存の ELF。配布アーカイブの
# SHA256SUMS で確かめてから展開する。**ファームウェア (isdbt_rio.inp) はアーカイブに
# 入っている** (Siano の許諾で無改変なら再配布できる。LICENCE.siano も一緒に置く)。
# README が示す SHA-256 とも突き合わせる。
# ---------------------------------------------------------------------------
# renovate: datasource=github-releases depName=Khronos31/siano-userland extractVersion=^v(?<version>.*)$
ARG SIANO_USERLAND_VERSION=0.1.8
ARG ISDBT_RIO_SHA256=054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818
RUN set -eu && cd /tmp && \
    case "${TARGETARCH}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac && \
    base="https://github.com/Khronos31/siano-userland/releases/download/v${SIANO_USERLAND_VERSION}" && \
    archive="siano-ts-${SIANO_USERLAND_VERSION}-linux-${arch}.tar.gz" && \
    curl -fsSLO "${base}/${archive}" && curl -fsSLO "${base}/SHA256SUMS" && \
    sha256sum -c --ignore-missing SHA256SUMS && \
    mkdir -p /opt/siano-userland && tar -xzf "${archive}" -C /opt/siano-userland && \
    echo "${ISDBT_RIO_SHA256}  /opt/siano-userland/firmware/isdbt_rio.inp" | sha256sum -c - && \
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
