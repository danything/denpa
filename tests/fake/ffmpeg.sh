#!/usr/bin/env bash
# 偽 ffmpeg。E2E で「エンコードが走って mkv が出来る」ところまでを実 ffmpeg 無しで通す。
# 本物と同じく stderr に Duration を、stdout に -progress の key=value ブロックを吐く。
set -uo pipefail

# 最後の引数が出力ファイル。ただし `-` は本物と同じく「ファイルではない」
# (stdout の意味)。fps の実測が `-f null -` で呼ぶので、素直に書くと
# リポジトリ直下に `-` という名前のゴミが生える (実際に2度 git に紛れ込んだ)
output="${!#}"
input=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-i" ]; then input="$arg"; fi
    prev="$arg"
done

# **何を渡されたかを残す** (ライブの FAKE_FFMPEG_ARGS_FILE と同じ形)。焼くときに
# GPU の道 (`h264_qsv` など) を選べているか、落ちたらソフトウェアへ倒れているかを
# テストから見るため。**どの道でも、落ちる前に**残す。1回ぶんずつ足す
if [ -n "${FAKE_FFMPEG_ENCODE_ARGS_FILE:-}" ]; then
    printf -- '---\n%s\n' "$(printf '%s\n' "$@")" >> "$FAKE_FFMPEG_ENCODE_ARGS_FILE"
fi

# GPU (QSV / VA-API) の道。`-init_hw_device` が付いていたら、それ。
#
# 本物は口 (/dev/dri/renderD128) が無ければ初期化で落ちる。ここでも同じで、
# **渡された口 (`child_device=…` / `vaapi=va:…`) がファイルとして在れば「GPU がある」**
# ことにする — 起動時の試し焼き (server/hwenc.ts、入力は lavfi) は黙って通し、
# 本番の焼きはそのまま下の普通の道へ流す。無ければ本物と同じく落ちる
# (焼きの途中で GPU が駄目になったときの、次の道への焼き直しもこれで通る)
prev=""
for arg in "$@"; do
    if [ "$prev" = "-init_hw_device" ]; then
        dev="${arg##*child_device=}"
        dev="${dev##*vaapi=va:}"
        if [ ! -e "$dev" ]; then
            echo "Device creation failed: -19." >&2
            echo "Failed to set value '$arg' for option 'init_hw_device': No such device" >&2
            exit 1
        fi
        if printf '%s\n' "$@" | grep -qx -- 'lavfi'; then
            exit 0
        fi
    fi
    prev="$arg"
done

# CM検出パス (silencedetect) は本編とは別物として応答する。
# 300秒と360秒に境界が来るので、300-360 の 60 秒がCMブロックとして検出される。
if printf '%s\n' "$@" | grep -q silencedetect; then
    echo "  Duration: 00:10:00.00, start: 0.000000, bitrate: 15000 kb/s" >&2
    echo "[silencedetect @ 0x1] silence_start: 299.8" >&2
    echo "[silencedetect @ 0x1] silence_end: 300.2 | silence_duration: 0.4" >&2
    echo "[silencedetect @ 0x1] silence_start: 359.8" >&2
    echo "[silencedetect @ 0x1] silence_end: 360.2 | silence_duration: 0.4" >&2
    exit 0
fi

# 焼いたものから字幕の絵を抜くパス (`api/recordings/<id>/captions.sup`)。
# 本物は入れ物の中の PGS をそのまま出す。ここでは作り置きの .sup を返す
# (中身は `src/lib/pgs.ts` の writeSup で作った2枚。読むほうの試験と同じ形)
if printf '%s\n' "$@" | grep -qx -- 'sup'; then
    cat "$(dirname "$0")/captions.sup"
    exit 0
fi

# 字幕を絵で取り出すパス (`server/subtitle.ts` の `buildPgs`)。
# 目印は sub2video の filter で、これを渡すのはこの経路だけ。
#
# denpa 側が .sup を組み立てるので、ここで返すのは**showinfo の行と生の RGBA**。
# 1枚だけ、4x2 の白い四角を返す (中身が透明だと切り抜きで消えて0枚になる)
if printf '%s\n' "$@" | grep -q '0:s:0\]showinfo'; then
    echo "[Parsed_showinfo_0 @ 0x1] n:0 pts:135000 pts_time:1.5 pos:-1 fmt:rgba sar:1/1 s:4x2 i:P iskey:1 type:I" >&2
    for _ in $(seq 1 32); do printf '\377'; done
    exit 0
fi

# CMを切るパス (-c copy で区間を切り出す / concat で繋ぐ)。
# 進捗も Duration も出さず、出力ファイルだけ作って終わる本物と同じ振る舞いにする
if printf '%s\n' "$@" | grep -qx -- '-c' && printf '%s\n' "$@" | grep -qx -- 'copy'; then
    mkdir -p "$(dirname "$output")"
    head -c 4096 /dev/zero > "$output"
    exit 0
fi

# ライブ配信(TS): stdin をそのまま stdout に流し続ける。
# 中身は本物のTSではないが、「切るまで流れ続ける」という性質だけは同じ。
#
# **見分けるのは入口。** 出口 (最後の引数) で見ていた頃は、字幕を同じ ffmpeg で
# 焼くようにした時点で最後の引数が pipe:3 になり、丸ごと素通りしていた
if [ "$input" = "pipe:0" ]; then
    # E2E から「映像側は入口で落ちる」と指示するための目印。
    #
    # 実機の tvk (T15) で出た形をそのまま真似る — 局が3つ相乗りしている TS で
    # -probesize が足りず、-map が解決できないまま降りる。**1バイトも出さずに
    # 降りるので、伝えないと画面は前の絵を貼ったまま6秒たって黒くなるだけ**。
    # 字幕側は落とさない (映像だけが死ぬ形を試したい)
    if [ -f "${FAKE_FFMPEG_LIVE_FAIL_FILE:-/nonexistent}" ] &&
        printf '%s\n' "$@" | grep -qx -- 'libx264'; then
        echo "Failed to set value '0:p:24632:v:0' for option 'map': Invalid argument" >&2
        echo "Error opening output files: Invalid argument" >&2
        exit 1
    fi
    # **何を渡されたかを残す。** 焼き方の指定は間違えても E2E では絵が要らないぶん
    # 素通りするので、テストから中身を見られるようにしておく。
    #
    # **1回ぶんずつ足していく。** 選局のたびに起きるので、上書きにしていると
    # 前の1回が消える。テスト側は `---` で切って選ぶ
    #
    # **1回の書き込みで済ませる。** 区切りと中身を別々に書いていた頃は、2本が
    # 同時に起きると2本ぶんが1回ぶんに見えていた (CI で落ちた)
    if [ -n "${FAKE_FFMPEG_ARGS_FILE:-}" ]; then
        printf -- '---\n%s\n' "$(printf '%s\n' "$@")" >> "$FAKE_FFMPEG_ARGS_FILE"
    fi

    # **渡された TS の頭を残す。** ライブは1局に絞ってから ffmpeg へ渡すので
    # (`server/live.ts` の pump)、渡ったものの PAT に局が1つしか無いことを
    # テストから確かめられるようにする。**頭だけ** — 全部残すと際限なく太る
    if [ -n "${FAKE_FFMPEG_TS_FILE:-}" ] &&
        printf '%s\n' "$@" | grep -qx -- 'libx264'; then
        exec tee >(head -c 200000 > "$FAKE_FFMPEG_TS_FILE" 2>/dev/null)
    fi
    exec cat
fi

echo "Input #0, mpegts, from '${input}':" >&2
echo "  Duration: 00:00:10.00, start: 0.000000, bitrate: 15000 kb/s" >&2

# E2E から「この先のエンコードは失敗させる」と指示するための目印。
# 失敗したときの表示と後始末を確かめるのに要る
if [ -f "${FAKE_FFMPEG_FAIL_FILE:-/nonexistent}" ]; then
    echo "[libsvtav1 @ 0x1] Error initializing the encoder" >&2
    echo "Conversion failed!" >&2
    exit 1
fi

if [ "${FAKE_FFMPEG_FAIL:-0}" = "1" ]; then
    echo "Error while opening encoder - fake failure" >&2
    exit 1
fi

steps="${FAKE_FFMPEG_STEPS:-4}"
for i in $(seq 1 "$steps"); do
    out_time_us=$((i * 10000000 / steps))
    printf 'frame=%d\nfps=120\nbitrate=2000.0kbits/s\ntotal_size=%d\nout_time_us=%d\nspeed=8.0x\ndrop_frames=0\nprogress=continue\n' \
        "$((i * 300))" "$((i * 1000000))" "$out_time_us"
    sleep 0.2
done

if [ "$output" != "-" ]; then
    mkdir -p "$(dirname "$output")"
    # 中身は問わないが、サイズ0だと「失敗」と見分けが付かないので少しだけ書く
    head -c 4096 /dev/zero > "$output"
fi

printf 'frame=1200\nfps=120\nbitrate=2000.0kbits/s\ntotal_size=4096\nout_time_us=10000000\nspeed=8.0x\ndrop_frames=0\nprogress=end\n'
exit 0
