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
# 外から取ってくるもの (asicen-userland)。**取ってくる道具は実行イメージに残さない**
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

# PLEX PX-W3U3 などの ASICEN 系は asicen-userland で動かす (Asicen.cs / AsicenUdtv.cs)。**試験的。実機では確かめていない。**
#
# **上流のプレリリース v1.0.0-beta (2026-11-05) に固定する。** エージェントは asicend と UDTV 1.0 で通信し、その形式の一部は
# このバージョンの通信を観察して起こした (docs/agent.md「asicen-userland の作り」)。HELLO の応答が asicen-userland 1.0.0 でなければ
# エージェントが断るので、**バージョンを上げるときは、通信を観察し直して Asicen.cs・AsicenUdtv.cs を合わせ、下の SHA-256 も入れ替える。**
# Renovate はバージョンを上げる PR を出すだけで、自動ではマージしない (renovate.json)。その PR は、下の SHA-256 が合わずに CI で落ちる。
#
# **タグとアーカイブの名前でバージョンが違う。** タグは v1.0.0-beta、アーカイブは asicen-userland-1.0.0-linux-glibc-<arch>.tar.gz で、
# `--version` も 1.0.0 と出力する (上流のリリースノートの「既知の問題」)。アーカイブの名前には、タグのプレリリースの部分 (-beta) を
# 落としたものを使う。正式な 1.0.0 が同じ名前のアーカイブで出るので、SHA256SUMS に加えて、**アーカイブそのものの SHA-256 をここに固定する。**
#
# アーカイブにはフォルダ分けが無く、コマンド 3 つ (asicend・asicenctl・asicen-ts。musl の完全静的 ELF) が直下にある。
# 名前の glibc / musl は同梱の IFD ハンドラ (使わない) の libc の違いで、コマンドはどちらも同じ。
# 受信機は asicend の制御ソケットで直に通信するので、IFD ハンドラと mdev の設定は消す。ライセンスの文書はそのまま置く。
#
# **ファームウェアは上流のアーカイブに入っているものをそのまま使う** (asicend が起動するときに機材へ流し込む)。
# SHA-256 は下の ASICEN_FIRMWARE_SHA256 (上流のリリースノートの値) と突き合わせる。
#
# **再配布の許諾は確かめられていない。上流と同じ判断で同梱している。権利を持つ人から申し出があれば外す。** 分かっている事実
# (docs/licenses.md「ASICEN のファームウェアを同梱している判断」):
# - PLEX の Windows 用ドライバ (Loader.sys) から上流 (Khronos31/asicen-userland) が取り出した 16,384 バイトのイメージ
# - チップの会社 ASICEN (昇亮科技股份有限公司 / Asicen Technology、台湾) は解散し、2017-02-23 に清算が完結したと登記されている。
#   台湾の会社情報サイト (https://www.twincn.com/item.aspx?no=80342850) の記載で、経済部の公式の登記では確かめていない
# - PLEX は 2026-11 の時点で、公式サイトの「旧製品ドライバ」のページ (https://plex-net.co.jp/old-driver/) で PX-W3U3・PX-W3U3 V2・
#   PX-S3U2 の Windows 用ドライバを配っている。そのページにも、上流が調べた公式のパッケージにも、再配布を認める文は無い
# - PLEX が以前配っていた Linux 用ドライバのモジュールには license=GPL の表示があり、同じファームウェアが埋め込まれている。
#   それだけではファームウェア自体のライセンスは決まらない (上流の NOTICES.md の整理)
# 上流が添える通知 (licenses/VENDOR-FIRMWARE-NOTICE.txt など) は、配布物のまま置く。
# renovate: datasource=github-releases depName=Khronos31/asicen-userland versioning=semver extractVersion=^v(?<version>.*)$
ARG ASICEN_USERLAND_VERSION=1.0.0-beta
ARG ASICEN_ARCHIVE_SHA256_AMD64=7e2264adee65cb3d0616b19550a36ff299098bcca8f350cec6155b434c0390da
ARG ASICEN_ARCHIVE_SHA256_ARM64=20c043f27954685a338e7c13402d98dd8bbf6c22b093b792a32721e600e9a7e6
ARG ASICEN_FIRMWARE_SHA256=5db39facda140bdcb3a238dad10da5aac752a1ba3aaf17e2239f8d79a0ad6a2a
RUN set -eu && mkdir -p /opt/asicen-userland && cd /tmp && \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64; sum="${ASICEN_ARCHIVE_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${ASICEN_ARCHIVE_SHA256_ARM64}" ;; \
      *) arch= ;; \
    esac && \
    if [ -z "${arch}" ]; then \
      echo "asicen-userland: ${TARGETARCH} の配布物は無いので入れません"; \
    else \
      base="https://github.com/Khronos31/asicen-userland/releases/download/v${ASICEN_USERLAND_VERSION}" && \
      archive="asicen-userland-${ASICEN_USERLAND_VERSION%%-*}-linux-glibc-${arch}.tar.gz" && \
      $CURL -O "${base}/${archive}" && $CURL -O "${base}/SHA256SUMS" && \
      grep -E "^[0-9a-f]{64} [ *]${archive}\$" SHA256SUMS > archive.sum && \
      sha256sum -c archive.sum && \
      echo "${sum}  ${archive}" | sha256sum -c - && \
      tar -xzf "${archive}" -C /opt/asicen-userland && \
      rm -rf /opt/asicen-userland/ifd /opt/asicen-userland/mdev /opt/asicen-userland/reader.conf.d && \
      for bin in asicend asicenctl; do test -x "/opt/asicen-userland/${bin}"; done && \
      echo "${ASICEN_FIRMWARE_SHA256}  /opt/asicen-userland/firmware/asicen-loader.bin" | sha256sum -c - && \
      test -f /opt/asicen-userland/licenses/VENDOR-FIRMWARE-NOTICE.txt; \
    fi && \
    rm -rf /tmp/*

# ---------------------------------------------------------------------------
# **土台は distroless (Debian 13 = trixie。リンクした build 段と同じバージョンなので glibc も合う)。**
# 入っているのは glibc・libssl・ca-certificates・libstdc++ と tzdata くらいで、シェルも apt も無い。
# エージェントが要るのはこれで全部。実行ファイルが直に繋ぐのは libc と libm だけで、libssl は .NET が読む。
# エージェントのポート (AGENT_PORT) は denpa と証明書で確かめ合う HTTPS なので、libssl を常に使う (AgentTls.cs)。
# CARD_URL を https で指したときも .NET の HttpClient が libssl を読み、
# 相手の証明書は ca-certificates で確かめる。
# 子プロセスは asicen-userland のコマンド (どれも libc に依らない静的な ELF) をシェルを通さずに起動する。
# シェル (`setsid sh -c`) を使うのは適合テストの偽の選局 (`FAKE_TUNE`) だけで、これはホストで組んだ
# 実行ファイルで回すのでイメージには要らない。時刻はどこも UTC で扱うので TZ も渡さない。
#
# **`recisdb` も libaribb25 も pcscd も入れない。** 選局は自分でやり (ioctl)、
# B25 も自分で復号し (B25.cs)、カードリーダーとも自分で通信する (Ccid.cs / It930xCard.cs / Zd1j.cs / Dt295NativeCard.cs)。
#
# **`latest` (root で動く) を使う。`nonroot` にはしない。** USB と DVB のデバイスを開き、
# asicend のソケットを /run/asicen-userland に作るので、今までどおり root で動かす
FROM gcr.io/distroless/cc-debian13:latest@sha256:809d04afa1be033c441f76bb0051878c342fb76d0ea236bc6dc94b655fa0fbd6 AS runtime

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
# denpa と組むための鍵・証明書・合言葉 (/config/tls。AgentTls.cs) も同じ所に置く。
#
# 実行ファイルは、上で読み込めることを確かめた loaded 段から写す
COPY --from=loaded /usr/local/bin/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
