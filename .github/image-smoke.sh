#!/usr/bin/env bash
# 組んだイメージを起こして、中身が動くかを見る (PR の docker-build-check.yml と、
# main で push する前の build-and-deploy.yml)。
#
# **CI のテストはイメージを使わない** (偽の ffmpeg・ホストで組んだエージェントで回す) ので、
# イメージの中の ffmpeg やエージェントが実際に動くかはここでしか見ていない。
# ライブラリの欠け (共有ライブラリの置き場・土台の入れ替え) は、組むのは通っても起こすと落ちる。
#
# 使い方: image-smoke.sh <denpa|denpa-agent|denpa-aio> <イメージ> [denpa-aio のときのバージョン]
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
    # ffmpeg のエラーは、終わりの値が 0 でも落とす。部品が欠けたときは「デコードできずに読み飛ばして
    # 先へ進む」ことがある (extract_extradata が無いと `-ss` のあとの MPEG-2 がそうなった)。
    # SVT-AV1 (`Svt[…]`) と arm64 の Rockchip MPP (`mpp[…]`。SoC を調べに行って無いと言う) は自前のログを必ず出すので除く
    ff() {
        local err status=0
        err=$(run /usr/local/bin/ffmpeg -hide_banner -loglevel error -nostdin -y "$@" 2>&1 >/dev/null) || status=$?
        err=$(grep -v -e '^Svt\[' -e '^mpp\[' <<< "$err" || true)
        [ "$status" -eq 0 ] && [ -z "$err" ] || { echo "ffmpeg $*" >&2; echo "$err" >&2; return 1; }
    }

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
        // QSV と Intel の VA-API ドライバは amd64、Rockchip の MPP は arm64 だけに入れている (Dockerfile)
        const want = x64 ? [`${lib}/dri/iHD_drv_video.so`, `${lib}/dri/i965_drv_video.so`, `${lib}/libmfx-gen.so.1.2`] : ["/usr/local/lib/librockchip_mpp.so.1"];
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
    want="libx264 libsvtav1 libopus aac mjpeg h264_vaapi av1_vaapi"
    arch=$(docker image inspect -f '{{.Architecture}}' "$image")
    # QSV は amd64、Rockchip の MPP は arm64 だけ (Dockerfile の ffmpeg 段)。MPP の .so は上の ld.so の確かめに入る
    [ "$arch" = amd64 ] && want="$want h264_qsv av1_qsv"
    [ "$arch" = arm64 ] && want="$want h264_rkmpp"
    for e in $want; do
        grep -qw "$e" <<< "$encoders" || { echo "エンコーダがありません: $e" >&2; exit 1; }
    done
    # GPU の経路のフィルタ (hwenc.ts)。ランナーに GPU が無く通せないので、組み込まれているかだけ見る
    filters=$(run /usr/local/bin/ffmpeg -hide_banner -filters)
    for f in hwupload deinterlace_vaapi; do
        grep -qw "$f" <<< "$filters" || { echo "フィルタがありません: $f" >&2; exit 1; }
    done
    # GPU の試しのエンコードの素材 (hwenc.ts)。lavfi の nullsrc からインタレの MPEG-2 の TS を作る
    ff -f lavfi -i nullsrc=s=256x256:r=30:d=0.2 -vf format=nv12 \
        -c:v mpeg2video -flags +ilme+ildct -f mpegts probe.ts
    ff -f lavfi -i testsrc2=size=1440x1080:rate=30000/1001:duration=3 \
        -f lavfi -i sine=frequency=1000:duration=3 \
        -c:v mpeg2video -flags +ilme+ildct -b:v 8M -c:a aac -ac 2 -f mpegts in.ts
    # **ffmpeg は denpa が使う部品だけで組んである** (Dockerfile の ffmpeg 段)。下は src/lib/server の
    # 経路を1つずつなぞったもので、部品が欠けていればここで落ちる。経路を足したら、ここにも足す
    run /usr/local/bin/ffprobe -v error -show_format -show_streams -of json in.ts > /dev/null
    run /usr/local/bin/ffprobe -v error -select_streams v -show_frames -read_intervals %+1 -of json in.ts > /dev/null
    # 録画のエンコード (encoder.ts)。H.264 は2ヶ国語の音声の分け方も通す
    ff -i in.ts -vf bwdif,scale=-2:720,setsar=1,format=yuv420p -c:v libx264 -preset ultrafast \
        -filter_complex "channelsplit[FL][FR];[FL]aformat=channel_layouts=mono[FLm];[FR]aformat=channel_layouts=mono[FRm]" \
        -map 0:v -map "[FLm]" -map "[FRm]" -c:a libopus -b:a 96k -f matroska h264.mkv
    ff -i in.ts -vf bwdif,scale=-2:720,format=yuv420p10le -c:v libsvtav1 -preset 12 \
        -c:a libopus -f matroska av1.mkv
    ff -i av1.mkv -f null -
    # ライブと録画の変換 (live.ts・playback.ts)。fMP4、主音声だけ、H.264 の mkv の変換、音声だけ
    ff -i in.ts -vf bwdif=mode=send_frame -af "pan=stereo|c0=c0|c1=c0" -c:v libx264 -preset ultrafast -g 60 \
        -c:a aac -b:a 256k -ac 2 -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof live.mp4
    ff -ss 0.5 -i h264.mkv -c:v libx264 -preset ultrafast -c:a aac -ac 2 \
        -f mp4 -movflags frag_keyframe+empty_moov stream.mp4
    ff -i h264.mkv -vn -c:a aac -f adts audio.aac
    # CM 検出 (cm-scan.ts・logo-own.ts)。場面の切れ目と無音はファイルへ、ロゴの帯はグレーの rawvideo で
    ff -i in.ts -an -fps_mode passthrough \
        -vf "scdet@cm=threshold=100,metadata=mode=print:key=lavfi.scd.score:file=cuts.txt" -f null -
    ff -i in.ts -map 0:a:0 -af "silencedetect=noise=-50dB:d=0.5,ametadata=mode=print:file=silences.txt" -f null -
    ff -skip_frame nokey -i in.ts -an \
        -vf "fps=1/0.5,split[a][b];[a]crop=iw:ih/5:0:0:exact=1,scale=480:216[t];[b]crop=iw:ih/5:0:ih*4/5:exact=1,scale=480:216[u];[t][u]vstack,format=gray" \
        -frames:v 2 -f rawvideo logo.raw
    # CM を切る (cm-cut.ts)。H.264 の mkv を concat で繋ぎ (h264_mp4toannexb が差し込まれる)、チャプターを付け直す
    run /usr/local/bin/bun -e '
        await Bun.write("list.txt", "file h264.mkv\nfile h264.mkv\n");
        await Bun.write("chapters.txt", ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=A\n");
    '
    ff -f concat -safe 0 -i list.txt -map 0 -c copy -f matroska cut.mkv
    ff -i cut.mkv -i chapters.txt -map 0 -map_chapters 1 -c copy -f matroska chapters.mkv
    # サムネイル (metadata.ts) と、それを切り抜きに見立てた AVIF (clips.ts)
    ff -ss 1 -i in.ts -vf field=top,thumbnail,scale=320:-2,setsar=1 -frames:v 1 thumb.jpg
    ff -i thumb.jpg -map_metadata -1 \
        -filter_complex "[0:v:0]split[a][b];[a]scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2:out_color_matrix=bt709:out_range=full,format=yuv420p[full];[b]scale=w='min(160,trunc(iw/2)*2)':h=-2:out_color_matrix=bt709:out_range=full,format=yuv420p[small]" \
        -map "[full]" -frames:v 1 -c:v libsvtav1 -preset 8 -crf 30 -svtav1-params avif=1 -f avif full.avif \
        -map "[small]" -frames:v 1 -c:v libsvtav1 -preset 8 -crf 30 -svtav1-params avif=1 -f avif small.avif
    # コマ数の見分け方 (src/lib/server/fps.ts)。テレシネ・60i・30p の合成の映像で、判定が分かれるか。
    # イメージには src が無いので、チェックアウトを読み取り専用で渡す (fps.ts はほかのモジュールを読まない)
    docker run --rm -v "$PWD:/src:ro" -v "$work:/work" -w /work --entrypoint /usr/local/bin/bun "$image" \
        /src/scripts/fps-smoke.ts /work
    run /usr/local/bin/bun -e '
        for (const name of ["in.ts", "h264.mkv", "av1.mkv", "live.mp4", "stream.mp4", "audio.aac", "cuts.txt", "logo.raw", "cut.mkv", "chapters.mkv", "thumb.jpg", "full.avif", "small.avif"]) {
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
    # 本体のイメージそのままなので、ここでは起動だけを見る。バージョンを渡されたら、
    # release.Dockerfile で足したバージョンを本体が読めているかも見る
    want_version=${3:-}
    docker run -d --name aio-smoke -p 3000:3000 -p 25252:25252 "$image" > /dev/null
    trap 'docker logs aio-smoke; docker rm -f aio-smoke > /dev/null' EXIT
    wait_for localhost:25252/denpa/tuners 30 || { echo "エージェントが答えません" >&2; exit 1; }
    health=$(wait_for localhost:3000/api/health 60) || { echo "denpa が答えません" >&2; exit 1; }
    echo "$health"
    if [ -n "$want_version" ] && ! grep -qF "\"version\":\"$want_version\"" <<< "$health"; then
        echo "バージョンが $want_version になっていません" >&2
        exit 1
    fi
    exit 0
    ;;
*)
    echo "知らないイメージ: $name" >&2
    exit 1
    ;;
esac
