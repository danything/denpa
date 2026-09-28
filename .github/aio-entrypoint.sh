#!/bin/bash
# denpa-aio の入口。本体とチューナーエージェントを起こし、両方の面倒を見る。
#
# - 止めるとき (SIGTERM) は両方に渡し、両方が録画の終わりを待って畳むのを待つ
#   (stop_grace_period はそれに合わせて長くしておく。compose.prod.yml と同じ)
# - どちらかが落ちたら、もう片方も畳んでコンテナごと終わる。片方だけ生きていても
#   録れないので、起こし直しは restart に任せる
set -u

/usr/local/bin/denpa-agent &
agent=$!
bun /app/server.js &
denpa=$!

stopping=0
stop() { kill -TERM "$agent" "$denpa" 2>/dev/null; }
trap 'stopping=1; stop' TERM INT

wait -n "$agent" "$denpa"
code=$?
stop
wait "$agent" "$denpa"
# 頼まれて止めたなら 0。自分から落ちたなら、落ちたほうの終了コードを返す
[ "$stopping" = 1 ] && exit 0
exit "$code"
