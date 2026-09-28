# denpa-aio: **本体とチューナーエージェントを1つのコンテナで。**
#
# チューナーを挿した機械でそのまま全部動かすとき (NAS・Home Assistant のアドオンなど) 用。
# 組み直さない — main で組んだ `denpa` に、`denpa-agent` の実行ファイルと
# px4-userland / siano-userland を写すだけ (増えるのは数 MB)。RUN が無いので、
# arm64 もエミュレーション無しで数秒で組める。どちらの土台も Debian trixie-slim なので、
# エージェントが要るもの (setsid) は本体の側にもある。
#
# 起こし方と止め方は aio-entrypoint.sh。設定の置き場はエージェントと同じ `/app-config`
# (`tuners.json` / `channels.json`)、それ以外は denpa と同じ
ARG DENPA
ARG AGENT
FROM ${AGENT} AS agent

FROM ${DENPA}
COPY --from=agent /usr/local/bin/denpa-agent /usr/local/bin/denpa-agent
COPY --from=agent /opt/px4-userland /opt/px4-userland
COPY --from=agent /opt/siano-userland /opt/siano-userland
COPY --chmod=755 .github/aio-entrypoint.sh /usr/local/bin/denpa-aio
# エージェントは同じコンテナの中。生TSの置き場は両方で同じ所を指す
# (エージェントは録ったあとの解除で読む。既定がそれぞれ違うのでそろえる)
ENV TUNER_AGENT_URL=http://127.0.0.1:25252 \
    RECORDED_DIR=/app/recorded
CMD ["/usr/local/bin/denpa-aio"]
