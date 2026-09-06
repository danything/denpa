# リリースのイメージ。**main で組んだイメージに、版を 1 層足すだけ。**
#
# 組み直さない (組み直すと apt の中身が main のものとずれうる)。中身の層は
# `sha-…` のイメージと同じで、増えるのは ENV のメタデータ 1 枚。数秒で終わる。
# 動いている denpa はこの版と GitHub の最新のリリースを数で比べて、新しい版の
# 知らせを出す (src/lib/server/update.ts)。main (develop) のイメージは版を持たず
# (`dev`)、知らせも出さない — main を追いかけている限りリリースより常に先
ARG BASE
FROM ${BASE}
ARG DENPA_VERSION
ENV DENPA_VERSION=${DENPA_VERSION}
