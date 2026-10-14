#!/usr/bin/env bash
# 組んだイメージを起こして、中身が動くかを見る (docker-build-check.yml)。
#
# **CI のテストはイメージを使わない** (偽の ffmpeg・ホストで組んだエージェントで回す) ので、
# イメージの中の ffmpeg やエージェントが実際に動くかはここでしか見ていない。
# ライブラリの欠け (共有ライブラリの置き場・土台の入れ替え) は、組むのは通っても起こすと落ちる。
#
# 使い方: image-smoke.sh <denpa|denpa-agent> <イメージ>
set -euo pipefail
name=$1
image=$2

case "$name" in
denpa)
    # 放送と同じ形 (MPEG-2 のインターレース + AAC の TS) を作り、denpa が使う経路
    # (エンコード・CM 検出・サムネイル・ffprobe) を一通り通す。GPU はランナーに無いので、
    # エンコーダが組み込まれていることと、ドライバの依存が揃っていることまでを見る
    docker run --rm --entrypoint bash "$image" -euo pipefail -c '
        cd /tmp
        ff() { ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }
        for bin in /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/lib/*-linux-gnu/dri/*.so; do
            [ -e "$bin" ] || continue
            if ldd "$bin" | grep "not found"; then echo "足りないライブラリ: $bin" >&2; exit 1; fi
        done
        encoders=$(ffmpeg -hide_banner -encoders)
        want="libx264 libsvtav1 libopus aac png h264_vaapi av1_vaapi"
        [ "$(uname -m)" = x86_64 ] && want="$want h264_qsv av1_qsv"
        for e in $want; do
            grep -qw "$e" <<< "$encoders" || { echo "エンコーダがありません: $e" >&2; exit 1; }
        done
        ff -f lavfi -i testsrc2=size=1440x1080:rate=30000/1001:duration=3 \
            -f lavfi -i sine=frequency=1000:duration=3 \
            -c:v mpeg2video -flags +ilme+ildct -b:v 8M -c:a aac -ac 2 -f mpegts in.ts
        ffprobe -v error -show_format -show_streams -of json in.ts > /dev/null
        ff -i in.ts -vf bwdif,scale=-2:720,setsar=1 -c:v libx264 -preset ultrafast \
            -c:a libopus -b:a 96k -f matroska h264.mkv
        ff -i in.ts -vf bwdif,scale=-2:720,format=yuv420p10le -c:v libsvtav1 -preset 12 \
            -c:a aac -movflags +faststart -f mp4 av1.mp4
        ff -i av1.mp4 -f null -
        ff -i in.ts -vf "scdet@cm=threshold=0" -af silencedetect -f null -
        ff -ss 1 -i in.ts -vf thumbnail,scale=320:-2 -frames:v 1 thumb.png
        ls -l in.ts h264.mkv av1.mp4 thumb.png
    '
    ;;
denpa-agent)
    # 起こして API が答えるか (機材は無いので、チューナーは自動検出で空)
    docker run -d --name agent-smoke -p 25252:25252 "$image" > /dev/null
    trap 'docker logs agent-smoke; docker rm -f agent-smoke > /dev/null' EXIT
    for _ in $(seq 30); do
        if curl -fsS localhost:25252/denpa/tuners; then echo; exit 0; fi
        sleep 1
    done
    echo "エージェントが答えません" >&2
    exit 1
    ;;
*)
    echo "知らないイメージ: $name" >&2
    exit 1
    ;;
esac
