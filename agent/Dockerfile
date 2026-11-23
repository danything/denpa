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
# asicen-userland を組み込んだ共有ライブラリ (libdenpa_asicen.so。agent/asicen/)。PLEX PX-W3U3 などの ASICEN 系を、エージェントが
# 同じプロセスから呼んで動かす (Asicen.cs / AsicenNative.cs)。**試験的。実機では確かめていない。**
#
# **組むのは agent/asicen/build.sh で、上流のバージョンと SHA-256 もそこに固定してある** (Android のアプリも同じスクリプトで組む)。
# 上流のソースのアーカイブ (libusb と dtv-userland-core を同梱) から、この段の arch で組む (build 段と同じく QEMU は使わない)。
# リンクする glibc と libstdc++ は実行イメージと同じ Debian 13 のもの。組む道具 (curl・cmake・コンパイラ) は実行イメージに残さない。
#
# **ファームウェアは上流の配布物に入っているものをそのまま使い** (build.sh が SHA-256 を突き合わせる)、/opt/asicen-userland/firmware/ に置く。
# **再配布の許諾は確かめられていない。上流と同じ判断で同梱している。権利を持つ人から申し出があれば外す** (docs/licenses.md
# 「ASICEN のファームウェアを同梱している判断」)。上流が添える通知とライセンスの文書、対応するソースの入手先 (SOURCE.txt) は
# /opt/asicen-userland/licenses/ に置く。**このライブラリは GPL-2.0 で、エージェントと同じプロセスで動くので、このイメージの
# エージェントの実行ファイルとライブラリは GPL-2.0 の条件で配る** (docs/licenses.md「asicen-userland を組み込んだエージェント」)
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS asicen
ARG TARGETARCH
RUN case "${TARGETARCH}" in amd64|arm64) ;; *) echo "対応していない arch: ${TARGETARCH}" >&2; exit 1 ;; esac && \
    apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates cmake ninja-build g++ make && \
    rm -rf /var/lib/apt/lists/*
COPY agent/asicen/ /src/asicen/
RUN bash /src/asicen/build.sh /opt/asicen-userland --firmware

# ---------------------------------------------------------------------------
# **土台は distroless (Debian 13 = trixie。リンクした build 段と同じバージョンなので glibc も合う)。**
# 入っているのは glibc・libssl・ca-certificates・libstdc++ と tzdata くらいで、シェルも apt も無い。
# エージェントが要るのはこれで全部。実行ファイルが直に繋ぐのは libc と libm だけで、libssl は .NET が読む。
# asicen-userland のライブラリ (/opt/asicen-userland/libdenpa_asicen.so) は libstdc++ と libgcc_s も繋ぐ (土台にある)。
# エージェントのポート (AGENT_PORT) は denpa と証明書で確かめ合う HTTPS なので、libssl を常に使う (AgentTls.cs)。
# CARD_URL を https で指したときも .NET の HttpClient が libssl を読み、
# 相手の証明書は ca-certificates で確かめる。
# 子プロセスを起動するのは適合テストの偽の選局 (`FAKE_TUNE`。`setsid sh -c`) だけで、これはホストで組んだ
# 実行ファイルで回すのでイメージには要らない。時刻はどこも UTC で扱うので TZ も渡さない。
#
# **`recisdb` も libaribb25 も pcscd も入れない。** 選局は自分でやり (ioctl)、
# B25 も自分で復号し (B25.cs)、カードリーダーとも自分で通信する (Ccid.cs / It930xCard.cs / Zd1j.cs / Dt295NativeCard.cs)。
#
# **`latest` (root で動く) を使う。`nonroot` にはしない。** USB と DVB のデバイスを開くので、今までどおり root で動かす
FROM gcr.io/distroless/cc-debian13:latest@sha256:dac90a25ffe03ebaace90cda886b081e61ab6cd77ac47eda51f7bcc15c320765 AS runtime

# **実行イメージの glibc で実行ファイルを読み込めることを、組むときに確かめる。**
# 実行ファイルが要求する GLIBC のバージョンが土台に無ければ、ローダーがここで止めてビルドが落ちる
# (build 段と土台の Debian がずれたときに、起動してからではなくここで分かる)。
# シェルが無いので exec の形で起動する。`--version` はバージョンを出して終わる (Program.cs)。
# asicen-userland のライブラリも、エージェントがこの土台で読み込めることを確かめる (`--asicen-check`。読めなければ exit 1)
FROM runtime AS loaded
COPY --from=build /out/denpa-agent /usr/local/bin/denpa-agent
COPY --from=asicen /opt/asicen-userland /opt/asicen-userland
RUN ["/usr/local/bin/denpa-agent", "--version"]
RUN ["/usr/local/bin/denpa-agent", "--asicen-check"]

FROM runtime

COPY --from=loaded /opt/asicen-userland /opt/asicen-userland

# PLEX PX-S1UD などの Siano RIO 系の機材は、エージェントが USB を直に持って動かす (Siano.cs)。外から取ってくるものは無い。
# ISDB-T のファームウェア (isdbt_rio.inp) はエージェントの実行ファイルに埋め込んである (SianoFirmware.cs。agent/Denpa.Agent/firmware/README.md)。
# Siano の許諾は、無改変で再配布するときに著作権表示と免責の文面を添えることを求めるので、文面をここに置く
COPY agent/Denpa.Agent/firmware/LICENCE.siano /usr/share/doc/denpa-agent/LICENCE.siano
# Xbox One Digital TV Tuner のブリッジ (DiB0700) のファームウェアも埋め込んである (Dib0700.cs・XboxOne.cs)。DiBcom の許諾 (ISC) も著作権表示と許諾の文面を添えることを求める
COPY agent/Denpa.Agent/firmware/LICENSE.dib0700 /usr/share/doc/denpa-agent/LICENSE.dib0700

# 設定は PVC (/config) に置く (/config/tuners.json と /config/channels.json はエージェントの既定。Config.cs)。
# **tuners.json は denpa の画面とエージェント (挿した機材を足す) が、channels.json は denpa が書き、どちらも無くて構わない。** tuners.json が無ければ挿さっている機材を
# 自分で見つけるし、channels.json はスキャンするまで空でよい。
#
# denpa と組むための鍵・証明書・合言葉 (/config/tls。AgentTls.cs) も同じ所に置く。
#
# 実行ファイルは、上で読み込めることを確かめた loaded 段から写す
COPY --from=loaded /usr/local/bin/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
