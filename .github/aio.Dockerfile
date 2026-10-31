# denpa-aio: **本体とチューナーエージェントを1つのコンテナで。**
#
# チューナーを挿した機械でそのまま全部動かすとき (NAS・Home Assistant のアドオンなど) 用。
# 組み直さない — main で組んだ `denpa` に、`denpa-agent` の実行ファイルと
# px4-userland / siano-userland / asicen-userland を写すだけ (増えるのは数 MB)。RUN が無いので、
# arm64 もエミュレーション無しで数秒で組める。
#
# **libssl はエージェントのイメージから写す。** 本体の土台は libssl の無い distroless (base-nossl。
# Dockerfile の `distroless` 段) で、エージェントの土台 (cc) にはある。エージェントは CARD_URL を https で
# 指したときと IT930x のファームウェアを取ってくるときに libssl を読む (agent/Dockerfile)。置き場の名前が arch で違い、RUN 無しでは読み替えられないので、
# arch ごとの段を作って `ssl-${TARGETARCH}` で選ぶ。libssl が繋ぐ libzstd も土台に無いので一緒に写す
# (zlib は本体の ffmpeg が繋ぐので本体にある)。パッケージの記録と copyright も一緒に写す
#
# 起こし方と止め方は aio-entrypoint.ts (シェルが無いので、本体のイメージの bun で回す)。
# 置き場は既定のまま両方で同じ: DB は `/data`、
# エージェントの設定 (`tuners.json` / `channels.json`) と取ってきた IT930x のファームウェアは `/config`、録画は `/media` の下
ARG DENPA
ARG AGENT
FROM ${AGENT} AS agent

FROM scratch AS ssl-amd64
COPY --from=agent /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libzstd.so.1 /usr/lib/x86_64-linux-gnu/

FROM scratch AS ssl-arm64
COPY --from=agent /usr/lib/aarch64-linux-gnu/libssl.so.3 /usr/lib/aarch64-linux-gnu/libcrypto.so.3 /usr/lib/aarch64-linux-gnu/libzstd.so.1 /usr/lib/aarch64-linux-gnu/

FROM ssl-${TARGETARCH} AS ssl
COPY --from=agent /var/lib/dpkg/status.d/libssl3t64 /var/lib/dpkg/status.d/libssl3t64
COPY --from=agent /usr/share/doc/libssl3t64/copyright /usr/share/doc/libssl3t64/copyright
COPY --from=agent /var/lib/dpkg/status.d/libzstd1 /var/lib/dpkg/status.d/libzstd1
COPY --from=agent /usr/share/doc/libzstd1/copyright /usr/share/doc/libzstd1/copyright

FROM ${DENPA}
COPY --from=ssl / /
COPY --from=agent /usr/local/bin/denpa-agent /usr/local/bin/denpa-agent
COPY --from=agent /opt/px4-userland /opt/px4-userland
COPY --from=agent /opt/siano-userland /opt/siano-userland
COPY --from=agent /opt/asicen-userland /opt/asicen-userland
COPY .github/aio-entrypoint.ts /usr/local/lib/denpa-aio.ts
# エージェントは同じコンテナの中。元のTSの置き場は既定が両方 `/media/raw` なので書かない
ENV TUNER_AGENT_URL=http://127.0.0.1:25252
CMD ["bun", "/usr/local/lib/denpa-aio.ts"]
