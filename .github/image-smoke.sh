#!/usr/bin/env bash
# 組んだイメージを起こして、中身が動くかを見る (PR の docker-build-check.yml と、
# main で push する前の build-and-deploy.yml)。
#
# **CI のテストはイメージを使わない** (偽の ffmpeg・ホストで組んだエージェントで回す) ので、
# イメージの中の ffmpeg やエージェントが実際に動くかはここでしか見ていない。
# ライブラリの欠け (共有ライブラリの置き場・土台の入れ替え) は、組むのは通っても起こすと落ちる。
#
# 使い方: image-smoke.sh <denpa|denpa-agent|denpa-aio> <イメージ> [denpa-aio のときの版]
set -euo pipefail
name=$1
image=$2

# GET が 200 を返すまで待つ (中身を出す)。答えなければ 1
wait_for() {
    local url=$1 tries=$2
    for _ in $(seq "$tries"); do
        if curl -fsS "$url"; then echo; return 0; fi
        sleep 1
    done
    return 1
}

case "$name" in
denpa)
    # 放送と同じ形 (MPEG-2 のインターレース + AAC の TS) を作り、denpa が使う経路
    # (エンコード・CM 検出・サムネイル・ffprobe) を一通り通す。GPU はランナーに無いので、
    # エンコーダが組み込まれていることと、ドライバの依存が揃っていることまでを見る。
    # **イメージにはシェルが無い** (土台は distroless) ので、コマンドは1つずつ直に起こし、
    # 作ったファイルはボリュームで受け渡す
    work="denpa-smoke-$$"
    docker volume create "$work" > /dev/null
    trap 'docker rm -f denpa-smoke > /dev/null 2>&1 || true; docker volume rm -f "$work" > /dev/null' EXIT
    run() { local bin=$1; shift; docker run --rm -v "$work:/work" -w /work --entrypoint "$bin" "$image" "$@"; }
    ff() { run /usr/local/bin/ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }

    # ライブラリの欠け。dlopen で読むもの (libva のドライバ・QSV のランタイム) は ldd に出ず、
    # ffmpeg が起きるだけでは分からないので、ld.so に1つずつ依存を解かせる (ldd も無いので bun で回す)
    run /usr/local/bin/bun -e '
        const x64 = process.arch === "x64";
        const lib = x64 ? "/usr/lib/x86_64-linux-gnu" : "/usr/lib/aarch64-linux-gnu";
        const ld = x64 ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
        const files = ["/usr/local/bin/ffmpeg", "/usr/local/bin/ffprobe"];
        for (const [cwd, pattern] of [["/usr/local/lib", "*.so.*"], [lib, "dri/*.so"], [lib, "libmfx-gen.so.*"], [lib, "libmfx-gen/*.so"]]) {
            files.push(...new Bun.Glob(pattern).scanSync({ cwd, absolute: true }));
        }
        let ok = true;
        // QSV と Intel の VA-API ドライバは amd64 だけに入れている (Dockerfile の runtime-libs 段)
        const want = x64 ? [`${lib}/dri/iHD_drv_video.so`, `${lib}/dri/i965_drv_video.so`, `${lib}/libmfx-gen.so.1.2`] : [];
        for (const file of want) {
            if (!files.includes(file)) { console.error(`ありません: ${file}`); ok = false; }
        }
        for (const file of files) {
            const r = Bun.spawnSync([ld, "--list", file]);
            const out = r.stdout.toString() + r.stderr.toString();
            if (r.exitCode !== 0 || out.includes("not found")) { console.error(`足りないライブラリ: ${file}\n${out}`); ok = false; }
        }
        console.log(`依存を確かめたもの: ${files.length} 個`);
        process.exit(ok ? 0 : 1);
    '

    encoders=$(run /usr/local/bin/ffmpeg -hide_banner -encoders)
    want="libx264 libsvtav1 libopus aac png h264_vaapi av1_vaapi"
    [ "$(docker image inspect -f '{{.Architecture}}' "$image")" = amd64 ] && want="$want h264_qsv av1_qsv"
    for e in $want; do
        grep -qw "$e" <<< "$encoders" || { echo "エンコーダがありません: $e" >&2; exit 1; }
    done
    ff -f lavfi -i testsrc2=size=1440x1080:rate=30000/1001:duration=3 \
        -f lavfi -i sine=frequency=1000:duration=3 \
        -c:v mpeg2video -flags +ilme+ildct -b:v 8M -c:a aac -ac 2 -f mpegts in.ts
    run /usr/local/bin/ffprobe -v error -show_format -show_streams -of json in.ts > /dev/null
    ff -i in.ts -vf bwdif,scale=-2:720,setsar=1 -c:v libx264 -preset ultrafast \
        -c:a libopus -b:a 96k -f matroska h264.mkv
    ff -i in.ts -vf bwdif,scale=-2:720,format=yuv420p10le -c:v libsvtav1 -preset 12 \
        -c:a aac -movflags +faststart -f mp4 av1.mp4
    ff -i av1.mp4 -f null -
    ff -i in.ts -vf "scdet@cm=threshold=0" -af silencedetect -f null -
    ff -ss 1 -i in.ts -vf thumbnail,scale=320:-2 -frames:v 1 thumb.png
    run /usr/local/bin/bun -e '
        for (const name of ["in.ts", "h264.mkv", "av1.mp4", "thumb.png"]) {
            const size = Bun.file(name).size;
            console.log(`${name}: ${size} バイト`);
            if (size === 0) process.exit(1);
        }
    '

    # 本番と同じ入口 (CMD) で起こして、DB まで触る /api/health が答えるか。
    # /api/health が見るのは DB だけで、エージェントもチューナーも要らない
    # (自動の処理はエージェントに繋がらなくても起動は止めない)
    docker run -d --name denpa-smoke -p 3000:3000 "$image" > /dev/null
    wait_for localhost:3000/api/health 60 && exit 0
    docker logs denpa-smoke
    echo "denpa が答えません" >&2
    exit 1
    ;;
denpa-agent)
    # 起こして API が答えるか (機材は無いので、チューナーは自動検出で空)
    docker run -d --name agent-smoke -p 25252:25252 "$image" > /dev/null
    trap 'docker logs agent-smoke; docker rm -f agent-smoke > /dev/null' EXIT
    wait_for localhost:25252/denpa/tuners 30 && exit 0
    echo "エージェントが答えません" >&2
    exit 1
    ;;
denpa-aio)
    # 入口 (aio-entrypoint.ts) が本体とエージェントの両方を起こすか。中身の ffmpeg などは
    # 本体のイメージそのままなので、ここでは起動だけを見る。版を渡されたら、
    # release.Dockerfile で足した版を本体が読めているかも見る
    want_version=${3:-}
    docker run -d --name aio-smoke -p 3000:3000 -p 25252:25252 "$image" > /dev/null
    trap 'docker logs aio-smoke; docker rm -f aio-smoke > /dev/null' EXIT
    wait_for localhost:25252/denpa/tuners 30 || { echo "エージェントが答えません" >&2; exit 1; }
    health=$(wait_for localhost:3000/api/health 60) || { echo "denpa が答えません" >&2; exit 1; }
    echo "$health"
    if [ -n "$want_version" ] && ! grep -qF "\"version\":\"$want_version\"" <<< "$health"; then
        echo "版が $want_version になっていません" >&2
        exit 1
    fi
    exit 0
    ;;
*)
    echo "知らないイメージ: $name" >&2
    exit 1
    ;;
esac
