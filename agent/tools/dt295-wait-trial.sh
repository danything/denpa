#!/bin/sh
# PIX-DT295: 仕様書の固定の待ちを 1 つずつ短くして、選局が受信を確認して最初の TS が届く割合と時間を、元の値と比べる。
#
# 使い方: dt295-wait-trial.sh <USB のポート> <チャンネル> [名前=ms …]
#   例: N=30 sh dt295-wait-trial.sh 3-5 T25 tune-t100=60 tune-t100=40 tune-t20a=10
# 先に元の値 (待ちを替えない) を測り、そのあと名前=ms の候補を 1 つずつ測る。毎回 --replug で電源を入れ直してから、--lock-test N 回 (既定 30) 選局する。
# 名前が init- で始まる待ちは機材を開き直す設定の待ちなので、--reopen を付けて毎回開き直す。
# 待ちの名前: init-t100 init-t20 init-s4 init-s6 (設定)、tune-t20a tune-t100 tune-t20b (地上波の選局)、tune-s10 tune-s40 tune-s100 (衛星の選局)
# 残す条件: 成功が 100% で、受信の確認の中央と 90% が元の値 + 10% + 10 ms を超えない。条件を満たすと OK、満たさないと NG と出す
# 結果の元のログは ./dt295-wait-trial-<チャンネル>/ に残る (OUT で替えられる)。エージェントは止めておく (Linux)
export LC_ALL=C.UTF-8
port="$1"; channel="$2"
[ -n "$port" ] && [ -n "$channel" ] || { echo "usage: $0 <USB のポート> <チャンネル> [名前=ms …]" >&2; exit 2; }
shift 2
candidates="$*"
n="${N:-30}"
agent="${AGENT:-denpa-agent}"
dir="${OUT:-dt295-wait-trial-$channel}"
mkdir -p "$dir"

run() { # 結果のファイル 待ち(空なら元の値)
  out="$1"; spec="$2"
  extra=""
  case "$spec" in init-*) extra="--reopen" ;; esac
  if [ -n "$spec" ]; then
    $agent --dt295-probe --port "$port" --channel "$channel" --replug --lock-test "$n" $extra --wait "$spec" >"$out" 2>"$out.err"
  else
    $agent --dt295-probe --port "$port" --channel "$channel" --replug --lock-test "$n" $extra >"$out" 2>"$out.err"
  fi
}

parse() { # 結果のファイル → 成功 全部 TS中央 TS90% 確認中央 確認90%
  sed -n 's/^結果: 成功 \([0-9]*\)\/\([0-9]*\) .*最初の TS まで 最小 [^ ]* 中央 \([^ ]*\) 90% \([^ ]*\) 最大 [^ ]* ms、受信の確認 最小 [^ ]* 中央 \([^ ]*\) 90% \([^ ]*\) 最大.*/\1 \2 \3 \4 \5 \6/p' "$1"
}

run "$dir/base.log" ""
base="$(parse "$dir/base.log")"
[ -n "$base" ] || { echo "元の値の結果が読めません ($dir/base.log)" >&2; exit 1; }
echo "元の値            : $base   (成功 全部 TS中央 TS90% 確認中央 確認90% の ms)"
set -- $base
bok="$1"; btotal="$2"; bl50="$5"; bl90="$6"
[ "$bok" = "$btotal" ] || echo "注意: 元の値で失敗があります。電波を確かめてください" >&2

i=0
for spec in $candidates; do
  i=$((i + 1))
  run "$dir/c$i.log" "$spec"
  row="$(parse "$dir/c$i.log")"
  if [ -z "$row" ]; then
    echo "$spec: 結果が読めません ($dir/c$i.log。$dir/c$i.log.err を見てください)"
    continue
  fi
  set -- $row
  ok="$1"; total="$2"; l50="$5"; l90="$6"
  verdict="$(awk -v ok="$ok" -v total="$total" -v l50="$l50" -v l90="$l90" -v b50="$bl50" -v b90="$bl90" \
    'BEGIN { if (ok == total && l50 <= b50 * 1.10 + 10 && l90 <= b90 * 1.10 + 10) print "OK"; else print "NG" }')"
  echo "$spec : $row   $verdict"
done
