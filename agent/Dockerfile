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
# 入れずにそこで止める。sdk:10.0 の既定がそのまま trixie (`-trixie` という札は無い)
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
# 外から取ってくるもの (ファームウェアと3つの userland)。**取ってくる道具は実行イメージに残さない**
# (curl などはこの段だけ。実行イメージが apt で入れるのは ca-certificates だけ)。
# 中身は実行しないので、組む機械の arch で TARGETARCH の配布物を取る
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim AS fetch
ARG TARGETARCH
ENV CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
RUN apt-get update && apt-get -y --no-install-recommends install curl ca-certificates unzip && \
    case "${TARGETARCH}" in amd64|arm64) ;; *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; esac

# IT930x のファームウェア (px4-userland の機材に挿すたびに流し込む)。
# **PLEX 公式の Windows ドライバ (PX-W3U4 BDA Ver.1.0 64bit) の PXW3U4.sys から
# 切り出す。** 配布 zip・.sys・切り出したものの3つをハッシュで確かめる。
# px4-userland SPEC 4.5 が受理するのはこの 2,169 バイトの1つだけ。
# 再配布の許諾は誰も持っていないので、そこはこちらが背負う判断 (docs/agent.md)。
ARG PLEX_DRIVER_SHA256=bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200
ARG PXW3U4_SYS_SHA256=8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722
ARG IT930X_FIRMWARE_SHA256=5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484
RUN set -eu && mkdir -p /opt/px4-userland/firmware && cd /tmp && \
    $CURL -o driver.zip https://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip && \
    echo "${PLEX_DRIVER_SHA256}  driver.zip" | sha256sum -c - && \
    unzip -p driver.zip pxw3u4_BDA_ver1x64/PXW3U4.sys > PXW3U4.sys && \
    echo "${PXW3U4_SYS_SHA256}  PXW3U4.sys" | sha256sum -c - && \
    dd if=PXW3U4.sys of=/opt/px4-userland/firmware/it930x-firmware.bin bs=1 skip=$((0x287d0)) count=2169 status=none && \
    echo "${IT930X_FIRMWARE_SHA256}  /opt/px4-userland/firmware/it930x-firmware.bin" | sha256sum -c - && \
    rm -rf /tmp/*

# PLEX PX-Q3U4 などは px4-userland で掴む (Px4.cs)。**カーネルドライバを入れてもらわない。**
# px4d / px4ctl は musl の完全静的 ELF。受信機もカードも px4d の制御ソケットで直に話すので
# (Px4.cs / Px4Card.cs)、配布物の px4-ts と IFD ハンドラ (ifd/*.so、pcscd 用) は使わない。
# **0.1.9 より下げない。** 筐体は `px4d --list-json` (0.1.9 から) でしか聞かない。
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
ARG PX4_USERLAND_VERSION=0.2.0
RUN set -eu && cd /tmp && \
    case "${TARGETARCH}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; esac && \
    base="https://github.com/Khronos31/px4-userland/releases/download/v${PX4_USERLAND_VERSION}" && \
    archive="px4-userland-${PX4_USERLAND_VERSION}-linux-glibc-${arch}.tar.gz" && \
    $CURL -O "${base}/${archive}" && $CURL -O "${base}/SHA256SUMS" && \
    sha256sum -c --ignore-missing SHA256SUMS && \
    tar -xzf "${archive}" -C /opt/px4-userland && \
    rm -rf /tmp/*

# PLEX PX-S1UD などの Siano RIO 系は、**カーネルが掴んでいなければ** siano-userland で掴む
# (Siano.cs)。smsusb が掴んでいれば今までどおり /dev/dvb で使う。こちらからは奪わない。
# siano-ts は libusb を静的にリンクした libc 非依存の ELF。**ファームウェア (isdbt_rio.inp) は
# アーカイブに入っている** (Siano の許諾で無改変なら再配布できる。LICENCE.siano も一緒に置く)。
# README が示す SHA-256 とも突き合わせる。
# renovate: datasource=github-releases depName=Khronos31/siano-userland extractVersion=^v(?<version>.*)$
ARG SIANO_USERLAND_VERSION=0.1.10
ARG ISDBT_RIO_SHA256=054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818
RUN set -eu && cd /tmp && \
    case "${TARGETARCH}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; esac && \
    base="https://github.com/Khronos31/siano-userland/releases/download/v${SIANO_USERLAND_VERSION}" && \
    archive="siano-ts-${SIANO_USERLAND_VERSION}-linux-${arch}.tar.gz" && \
    $CURL -O "${base}/${archive}" && $CURL -O "${base}/SHA256SUMS" && \
    sha256sum -c --ignore-missing SHA256SUMS && \
    mkdir -p /opt/siano-userland && tar -xzf "${archive}" -C /opt/siano-userland && \
    echo "${ISDBT_RIO_SHA256}  /opt/siano-userland/firmware/isdbt_rio.inp" | sha256sum -c - && \
    rm -rf /tmp/*

# PLEX PX-W3U3 などの ASICEN 系は asicen-userland で掴む (Asicen.cs)。**試験的。**
#
# **上流がまだリリースを出していないので、いまは何も入らない。** 版の 0.0.0 は
# 「まだ無い」の印で、この段は空の /opt/asicen-userland を作るだけ (エージェントは
# 配布物が無ければ機材を挙げない)。0.1.0 が出れば Renovate が版を上げる PR を出し、
# そこで初めて取ってくる (自動では入れない。renovate.json)。
#
# 取ってくるのは px4-userland と同じ名前の付け方を見込んだ配布アーカイブ (上流の
# scripts/package-linux-variant.py の形: 頭に1段のディレクトリ、bin/ にコマンド3つ、musl の
# 完全静的 ELF)。名前の glibc / musl は同梱の IFD ハンドラ (使わない) の libc の違いで、
# コマンドはどちらも同じ musl の静的 ELF。名前や形が違えば、版を上げる PR の CI (イメージを焼く) で落ちて分かる
# (SHA256SUMS にそのアーカイブの行が無ければ落とす。--ignore-missing は行が無くても通るので使わない)。
# 受信機もカードも asicend の制御ソケットで直に話すので、asicen-ts と IFD ハンドラは使わない。
# 上流の第一弾は Linux x86_64 だけなので、arm64 では入れずに先へ進む。
#
# **ファームウェアは上流のアーカイブに入っているものをそのまま使う** (上流 NOTICES.md:
# Git には入れず、配布物には入れる)。再配布の権利は確かめられていない。上流が添える
# licenses/VENDOR-FIRMWARE-NOTICE.txt (権利未確定・元の成果物・大きさ・SHA-256) も一緒に置く。
# 入っていれば上流の記録 (HARDWARE-VALIDATION.md) の SHA-256 と突き合わせる。
# 入っていなければ焼くのは止めず、エージェントが「ファームウェアがありません」と記録して
# その機材を使わない。
# renovate: datasource=github-releases depName=Khronos31/asicen-userland extractVersion=^v(?<version>.*)$
ARG ASICEN_USERLAND_VERSION=0.0.0
ARG ASICEN_FIRMWARE_SHA256=b45d510200a1690b3ca358d93de13f40e1d3567b663c17e773349ad96f597aa8
RUN set -eu && mkdir -p /opt/asicen-userland && cd /tmp && \
    if [ "${ASICEN_USERLAND_VERSION}" = 0.0.0 ]; then \
      echo "asicen-userland: まだリリースが無いので入れません"; \
    elif [ "${TARGETARCH}" != amd64 ]; then \
      echo "asicen-userland: ${TARGETARCH} の配布物はまだ無いので入れません"; \
    else \
      base="https://github.com/Khronos31/asicen-userland/releases/download/v${ASICEN_USERLAND_VERSION}" && \
      archive="asicen-userland-${ASICEN_USERLAND_VERSION}-linux-glibc-x86_64.tar.gz" && \
      $CURL -O "${base}/${archive}" && $CURL -O "${base}/SHA256SUMS" && \
      grep -E "^[0-9a-f]{64} [ *]${archive}\$" SHA256SUMS > archive.sum && \
      sha256sum -c archive.sum && \
      tar -xzf "${archive}" -C /opt/asicen-userland --strip-components=1 && \
      for bin in asicend asicenctl; do test -x "/opt/asicen-userland/bin/${bin}"; done && \
      if [ -f /opt/asicen-userland/firmware/asicen-loader.bin ]; then \
        echo "${ASICEN_FIRMWARE_SHA256}  /opt/asicen-userland/firmware/asicen-loader.bin" | sha256sum -c - && \
        test -f /opt/asicen-userland/licenses/VENDOR-FIRMWARE-NOTICE.txt; \
      else \
        echo "asicen-userland: ファームウェアがありません (配布物に入っていませんでした)" >&2; \
      fi; \
    fi && \
    rm -rf /tmp/*

# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim

# **`recisdb` も libaribb25 も pcscd も入れません。** 選局は自分でやり (ioctl)、
# B25 も自分で解き (B25.cs)、カードリーダーとも自分で話します (Ccid.cs / Px4Card.cs)。
# 入れるのは ca-certificates だけ (CARD_URL を https で指したときの検証。openssl も一緒に入る —
# .NET の HttpClient は libssl を使う)。時刻はどこも UTC で扱うので TZ も渡さない
RUN apt-get update && \
    apt-get -y --no-install-recommends install ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/ /opt/

# 設定は PVC (/config) に置く。**どちらも denpa の画面が書く。**
#
# **どちらも無くて構わない。** tuners.json が無ければ刺さっている機材を
# 自分で見つけるし、channels.json はスキャンするまで空でよい。
ENV TUNERS_FILE=/config/tuners.json \
    CHANNELS_FILE=/config/channels.json
COPY --from=build /out/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
