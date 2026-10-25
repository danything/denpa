# リリースのイメージ (denpa とエージェント)。**main で組んだイメージに、バージョンを 1 層足すだけ。**
#
# 組み直さない (組み直すと apt の中身が main のものとずれうる)。中身の層は
# `sha-…` のイメージと同じで、増えるのは ENV のメタデータ 1 枚。数秒で終わる。
# 動いている denpa はこのバージョンと GitHub の最新のリリースを数で比べて、新しいバージョンの
# 通知を出す (src/lib/server/update.ts)。main (develop) のイメージはバージョンを持たず
# (`dev`)、通知も出さない — main を追いかけている限りリリースより常に先
#
# エージェントは同じ変数で自分のバージョンを知り、`GET /denpa/about` で返す (agent/Denpa.Agent/About.cs)。
# 設定の「その他」の「バージョンと環境」が denpa とずれていないかを見る
ARG BASE
FROM ${BASE}
ARG DENPA_VERSION
ENV DENPA_VERSION=${DENPA_VERSION}
