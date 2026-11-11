# ---------------------------------------------------------------------------
# チューナーエージェント (.NET)。
#
# **Native AOT で実行ファイル 1 個** (外せないわけは Denpa.Agent.csproj)。
#
# denpa から見える API は agent/conformance.test.ts が押さえている
# (本物を起動して HTTP で確かめる)。入れ替えはイメージのタグを変えるだけ。
# ---------------------------------------------------------------------------
# **arch ごとに、その arch のランナーで組む** (CI は amd64 を ubuntu-latest、arm64 を
# ubuntu-24.04-arm で。QEMU は使わない)。Native AOT は組む機械と同じ arch の実行ファイルを
# 出すのが素直で、AOT のクロスは clang とリンカの揃え直しが要るので、組む段も
# `--platform=$BUILDPLATFORM` にはしない。
#
# `TARGETARCH` (BuildKit が入れる) から、RID と取ってくる配布物の名前を引く。
# 名前の付け方は上流ごとにばらばら (amd64 / x86_64 / x64、arm64 / aarch64) なので、
# 各段の冒頭で読み替える。それ以外の arch は配布物が無いので、amd64 のものを
# 代わりに入れず、そこで止める。
#
# **SDK のイメージの中ではリンクしない。** sdk:11.0 の土台は Ubuntu 26.04 (glibc 2.43) で、
# 実行イメージの distroless は Debian 13 (glibc 2.41)。Debian の SDK のイメージは 11.0 から無い。
# Native AOT はリンクした段の glibc に対してシンボルのバージョンを決めるので、Ubuntu の上でリンクすると
# 実行イメージの glibc に無いバージョンを要求する実行ファイルができることがある。SDK はこの段から
# 下の build 段へマウントして使う (SDK そのものは古い glibc 向けに組んであり、Debian 13 で動く)
FROM mcr.microsoft.com/dotnet/sdk:11.0@sha256:65f3c7c6a25a239ab3e6719f2896147e7b68242ff2d8818dd70498bde6ef8bea AS sdk

# **リンクする段は実行イメージと同じ Debian 13 (trixie)。** 実行イメージの Debian を上げるときは、ここも一緒に上げる
FROM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS build
ARG TARGETARCH
WORKDIR /build
# AOT のリンクに clang と zlib が要る。ca-certificates は SDK が NuGet から ILCompiler を取得するため
# (SDK が読む libssl と libstdc++ は、ca-certificates と clang の依存で入る)
RUN apt-get update && \
    apt-get -y --no-install-recommends install clang zlib1g-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# SDK を ICU 無しで動かす (libicu はパッケージ名に Debian ごとのバージョンが入るので入れない)。
# ほかは SDK のイメージが決めているものと同じ
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_NOLOGO=true \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    NUGET_XMLDOC_MODE=skip
COPY agent/Denpa.Agent/ Denpa.Agent/
RUN --mount=type=bind,from=sdk,source=/usr/share/dotnet,target=/usr/share/dotnet \
    case "${TARGETARCH}" in \
      amd64) rid=linux-x64 ;; \
      arm64) rid=linux-arm64 ;; \
      *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    /usr/share/dotnet/dotnet publish Denpa.Agent/Denpa.Agent.csproj -c Release -r "${rid}" -o /out

# ---------------------------------------------------------------------------
# 外から取ってくるもの (px4-userland と asicen-userland)。**取ってくる道具は実行イメージに残さない**
# (curl などはこの段だけ。実行イメージは distroless で、apt もシェルも無い)。
# 中身は実行しないので、組む機械の arch で TARGETARCH の配布物を取る。
# 土台は digest で留める (Dockerfile の ffmpeg 段の説明)。タグのままだと土台が入れ替わるたびにこの段が
# 組み直しになり、配布元から取ってくる回数が増える
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS fetch
ARG TARGETARCH
ENV CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
RUN apt-get update && apt-get -y --no-install-recommends install curl ca-certificates && \
    case "${TARGETARCH}" in amd64|arm64) ;; *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; esac

# PLEX PX-Q3U4 などは px4-userland で動かす (Px4.cs)。**カーネルドライバを入れてもらわない。**
# px4d / px4ctl は musl の完全静的 ELF。受信機もカードも px4d の制御ソケットで直に通信するので
# (Px4.cs / Px4Card.cs)、配布物の px4-ts と IFD ハンドラ (ifd/*.so、pcscd 用) は使わない。
# **0.1.9 より下げない。** 筐体は `px4d --list-json` (0.1.9 から) でしか問い合わせない。
# IT930x のファームウェアはここでは入れない。エージェントの実行ファイルに埋め込んである (Px4Firmware.cs)。
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
ARG PX4_USERLAND_VERSION=0.2.1
RUN set -eu && mkdir -p /opt/px4-userland && cd /tmp && \
    case "${TARGETARCH}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; esac && \
    base="https://github.com/Khronos31/px4-userland/releases/download/v${PX4_USERLAND_VERSION}" && \
    archive="px4-userland-${PX4_USERLAND_VERSION}-linux-glibc-${arch}.tar.gz" && \
    $CURL -O "${base}/${archive}" && $CURL -O "${base}/SHA256SUMS" && \
    sha256sum -c --ignore-missing SHA256SUMS && \
    tar -xzf "${archive}" -C /opt/px4-userland && \
    rm -rf /tmp/*

# PLEX PX-W3U3 などの ASICEN 系は asicen-userland で動かす (Asicen.cs)。**試験的。**
#
# **いまは何も入らない。** バージョンの 0.0.0 は「まだ入れない」の印で、この段は空の /opt/asicen-userland を
# 作るだけ (エージェントは配布物が無ければ機材を挙げない)。正式なリリースが出れば Renovate がバージョンを上げる
# PR を出し、そこで初めて取ってくる (自動では入れない。renovate.json)。
#
# **上流は 2026-11-05 にプレリリースの v1.0.0-beta を出したが、Asicen.cs はまだ対応していない** (docs/tuners.md)。
# 通信の形式 (UDTV 1.0) と asicend の引数が変わり、ファームウェアの SHA-256 も下の値と違う。
# バージョンを上げる前に、Asicen.cs と下の SHA-256 を合わせる。
#
# 取ってくるのは px4-userland と同じ名前の付け方を見込んだ配布アーカイブ (上流の
# scripts/package-linux-variant.py の形式: 先頭に 1 段のディレクトリ、bin/ にコマンド 3 つ、musl の
# 完全静的 ELF)。名前の glibc / musl は同梱の IFD ハンドラ (使わない) の libc の違いで、
# コマンドはどちらも同じ musl の静的 ELF。名前や形式が違えば、バージョンを上げる PR の CI (イメージをビルドする) で落ちて分かる
# (SHA256SUMS にそのアーカイブの行が無ければ落とす。--ignore-missing は行が無くても通るので使わない)。
# 受信機もカードも asicend の制御ソケットで直に通信するので、asicen-ts と IFD ハンドラは使わない。
# 上流の第一弾は Linux x86_64 だけなので、arm64 では入れずに先へ進む。
#
# **ファームウェアは上流のアーカイブに入っているものをそのまま使う** (上流 NOTICES.md:
# Git には入れず、配布物には入れる)。再配布の権利は確かめられていない。上流が添える
# licenses/VENDOR-FIRMWARE-NOTICE.txt (権利未確定・元の成果物・大きさ・SHA-256) も一緒に置く。
# 入っていれば上流の記録 (HARDWARE-VALIDATION.md) の SHA-256 と突き合わせる。
# 入っていなければビルドは止めず、エージェントが「ファームウェアがありません」と記録して
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
# **土台は distroless (Debian 13 = trixie。リンクした build 段と同じバージョンなので glibc も合う)。**
# 入っているのは glibc・libssl・ca-certificates・libstdc++ と tzdata くらいで、シェルも apt も無い。
# エージェントが要るのはこれで全部。実行ファイルが直に繋ぐのは libc と libm だけで、libssl は .NET が読む。
# エージェントのポート (AGENT_PORT) は denpa と証明書で確かめ合う HTTPS なので、libssl を常に使う (AgentTls.cs)。
# CARD_URL を https で指したときも .NET の HttpClient が libssl を読み、
# 相手の証明書は ca-certificates で確かめる。
# 子プロセスは px4d / px4ctl / asicen-userland のコマンド (どれも libc に依らない静的な ELF) をシェルを通さずに起動する。
# シェル (`setsid sh -c`) を使うのは適合テストの偽の選局 (`FAKE_TUNE`) だけで、これはホストで組んだ
# 実行ファイルで回すのでイメージには要らない。時刻はどこも UTC で扱うので TZ も渡さない。
#
# **`recisdb` も libaribb25 も pcscd も入れない。** 選局は自分でやり (ioctl)、
# B25 も自分で復号し (B25.cs)、カードリーダーとも自分で通信する (Ccid.cs / Px4Card.cs / It930xCard.cs / Zd1j.cs / Dt295NativeCard.cs)。
#
# **`latest` (root で動く) を使う。`nonroot` にはしない。** USB と DVB のデバイスを開き、
# px4d のソケットを /run/px4-userland に作るので、今までどおり root で動かす
FROM gcr.io/distroless/cc-debian13:latest@sha256:e1f5543d45a2cd7c02a5b43dda5f0ff30729b4832113759d01ed39b0b152cddb AS runtime

# **実行イメージの glibc で実行ファイルを読み込めることを、組むときに確かめる。**
# 実行ファイルが要求する GLIBC のバージョンが土台に無ければ、ローダーがここで止めてビルドが落ちる
# (build 段と土台の Debian がずれたときに、起動してからではなくここで分かる)。
# シェルが無いので exec の形で起動する。`--version` はバージョンを出して終わる (Program.cs)
FROM runtime AS loaded
COPY --from=build /out/denpa-agent /usr/local/bin/denpa-agent
RUN ["/usr/local/bin/denpa-agent", "--version"]

FROM runtime

COPY --from=fetch /opt/ /opt/

# PLEX PX-S1UD などの Siano RIO 系の機材は、エージェントが USB を直に持って動かす (Siano.cs)。外から取ってくるものは無い。
# ISDB-T のファームウェア (isdbt_rio.inp) はエージェントの実行ファイルに埋め込んである (SianoFirmware.cs。agent/Denpa.Agent/firmware/README.md)。
# Siano の許諾は、無改変で再配布するときに著作権表示と免責の文面を添えることを求めるので、文面をここに置く
COPY agent/Denpa.Agent/firmware/LICENCE.siano /usr/share/doc/denpa-agent/LICENCE.siano

# 設定は PVC (/config) に置く (/config/tuners.json と /config/channels.json はエージェントの既定。Config.cs)。
# **どちらも denpa の画面が書き、どちらも無くて構わない。** tuners.json が無ければ挿さっている機材を
# 自分で見つけるし、channels.json はスキャンするまで空でよい。
#
# px4-userland の機材に流し込む IT930x のファームウェアも、px4d に渡すときに
# エージェントが同梱のものをここに書き出す (/config/it930x-firmware.bin。Px4Firmware.cs)。
# denpa と組むための鍵・証明書・合言葉 (/config/tls。AgentTls.cs) も同じ所に置く。
#
# 実行ファイルは、上で読み込めることを確かめた loaded 段から写す
COPY --from=loaded /usr/local/bin/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
