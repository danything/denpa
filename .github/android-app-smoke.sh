#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリ (debug の APK) をエミュレータに入れて起動し、常駐サービスとエージェントを確かめる (.github/workflows/android.yml)。
#
#   bash .github/android-app-smoke.sh <APK> <記録の置き場> <native-smoke.js>
#
# 3 つ目は tests/native-smoke.ts を bun build で 1 つにまとめたもの (android.yml が作る)
#
# エミュレータが起きてから android-emulator-runner が流す。エージェントはアプリの子プロセス (SELinux の untrusted_app) で動く。
# エミュレータには USB の機材を挿せず、通知のボタンも押せないので、その 2 つは debug の APK にだけ入る受け口 (DebugReceiver) で代える
#
# 確かめること
# - アイコンで起動すると、常駐サービスが connectedDevice で始まり、通知が出る (本文はエージェントの GET /denpa/tuners から「チューナー 0 台」)
# - エージェントがアプリの子プロセスとして untrusted_app で動き、<dataDir>/u に USB_BROKER のソケット (0600) を作って待ち受ける。
#   アプリがそこに繋いで synced を送る
# - denpa と同じ手順で組み (POST /denpa/pair)、/denpa/about (os が android)・/denpa/tuners (0 台)・/denpa/card が答える
# - アプリの LocalSocket から、ファイルの fd を付けた attached を送ると、エージェントが fd ごと受け取る (setFileDescriptorsForSend と 1 回の write)
# - エージェントが APK の asicend (libasicend.so) を起動でき (--version)、ファームウェア待ちの ID の fd を asicend --fd に継がせる
# - bun (libbun.so) がアプリの子プロセスとして untrusted_app で動き、debug の APK に入れた確かめ用のサーバ (android/app/src/debug/assets/server/) が
#   3000 番で答える。GET /check で、JIT・名前を引けるか・/proc から読むもの・子プロセスの起動・bun:sqlite を bun の中から試す
# - bun が、常駐サービスの渡す FFMPEG・FFPROBE (APK の libffmpeg.so・libffprobe.so) を子プロセスで起動できる。
#   tests/native-smoke.ts (エンコード、HLG を SDR に直すフィルタ、ffprobe で 10 種類のファイルを読む、MediaCodec のエンコーダ、4 本目の出口) を
#   アプリの置き場に置き、確かめ用のサーバの POST /smoke で、アプリの子プロセスの bun からさらに子プロセスで流す
# - エージェントが異常終了すると、アプリが起動し直し、繋ぎ直して synced を送り直す
# - 通知の「終了」で SIGTERM が届き、エージェントも bun も常駐サービスも残らない
# - アイコンで始めたあとに端末を起動し直すと、BOOT_COMPLETED で常駐サービスが始まる
# ---------------------------------------------------------------------------
set -euo pipefail

apk=$1
logs=$2
smoke=$3
mkdir -p "$logs"
logs=$(cd "$logs" && pwd)
pkg=io.github.danything.denpa
port=25252
host=$(mktemp -d)

on_exit() {
  status=$?
  timeout 30 adb logcat -d > "$logs/logcat.txt" 2>/dev/null || true
  timeout 30 adb shell dumpsys activity services "$pkg" > "$logs/services.txt" 2>/dev/null || true
  timeout 30 adb shell dumpsys notification --noredact > "$logs/notification.txt" 2>/dev/null || true
  echo "--- logcat (denpa・denpa-agent・denpa-server)"
  timeout 30 adb logcat -d -s denpa denpa-agent denpa-server 2>/dev/null | tail -n 80 || true
  exit "$status"
}
trap on_exit EXIT

# ログの denpa (アプリ)、denpa-agent (エージェントの出力)、denpa-server (bun の出力) に、その文言が出るまで待つ (30 秒まで)
wait_log() {
  for _ in $(seq 60); do
    # 先に全部を読んでから探す (grep -q が途中で閉じると、pipefail で tr の SIGPIPE が失敗になる)
    adb logcat -d -s denpa denpa-agent denpa-server | tr -d '\r' > "$host/logcat.txt"
    grep -qF "$1" "$host/logcat.txt" && return 0
    sleep 0.5
  done
  echo "logcat に「$1」が出ません" >&2
  return 1
}

# エージェントの PID (動いていなければ空)
agent_pid() {
  adb shell ps -A -o PID,NAME | tr -d '\r' | awk '$2 == "libdenpa_agent.so" { print $1 }'
}

# bun の PID (動いていなければ空)
bun_pid() {
  adb shell ps -A -o PID,NAME | tr -d '\r' | awk '$2 == "libbun.so" { print $1 }'
}

# 常駐サービスが動いているか。種類 (types) は API 30 から出るので、出ていれば connectedDevice (0x10) か見る
service_running() {
  line=$(adb shell dumpsys activity services "$pkg" | tr -d '\r' | grep 'isForeground=true') || return 1
  case "$line" in *types=*) [[ "$line" == *types=0x00000010* ]] ;; *) true ;; esac
}

wait_until() {
  for _ in $(seq 60); do
    "$@" && return 0
    sleep 1
  done
  echo "待っても「$*」になりません" >&2
  return 1
}

no_agent() { [ -z "$(agent_pid)" ]; }
service_gone() { ! adb shell dumpsys activity services "$pkg" | tr -d '\r' | grep -q "ServiceRecord.*$pkg/.DenpaService"; }
has_agent() { [ -n "$(agent_pid)" ]; }
no_bun() { [ -z "$(bun_pid)" ]; }
has_bun() { [ -n "$(bun_pid)" ]; }
# 通知の本文に出ているか
notified() { adb shell dumpsys notification --noredact | tr -d '\r' | grep -A60 "pkg=$pkg" | grep -qF "android.text=String ($1)"; }

broadcast() { adb shell am broadcast -n "$pkg/.DebugReceiver" -a "$pkg.debug.$1" "${@:2}" > /dev/null; }

adb shell getprop ro.build.version.release | tee "$logs/android-version.txt"
adb shell uname -r | tee "$logs/kernel.txt"
# 起きた直後はパッケージの管理が答えず、adb install が戻らないことがある (API 29)。答えるのを待ち、上限を付けて入れ直す
for _ in $(seq 60); do timeout 10 adb shell pm path android > /dev/null 2>&1 && break; sleep 2; done
for try in 1 2 3; do
  timeout 120 adb install -r -g "$apk" > /dev/null && break
  echo "adb install が通らないため入れ直します ($try 回目)" >&2
  [ "$try" = 3 ] && exit 1
  sleep 5
done
# 省電力の対象から外すよう求める画面を出さない (最初の起動で出る。CI では押せない)
adb shell dumpsys deviceidle whitelist "+$pkg" > /dev/null
adb logcat -c

# --- アイコンで起動する
echo "=== アイコンで起動する"
# -W は付けない (画面の無いアクティビティはすぐ閉じるので、API 29 では起動し終えた知らせが来ず戻らない)
timeout 60 adb shell am start -n "$pkg/.StartActivity" > /dev/null
wait_until service_running
wait_until has_agent
pid=$(agent_pid)
adb shell ps -A -o LABEL,USER,PID,PPID,NAME | tr -d '\r' | grep -E "LABEL|$pkg|libdenpa_agent" | tee "$logs/processes.txt"
# アプリの子プロセスで、SELinux は untrusted_app
app=$(adb shell ps -A -o PID,NAME | tr -d '\r' | awk -v name="$pkg" '$2 == name { print $1 }')
grep -E "^u:r:untrusted_app:[^ ]+ +[^ ]+ +$pid +$app +libdenpa_agent.so$" "$logs/processes.txt"
wait_log "アプリから USB の機材を 0 台受け取りました"
# USB_BROKER のソケットはアプリだけが読める置き場に 0600 で
adb shell run-as "$pkg" ls -lZ u | tr -d '\r' | tee "$logs/socket.txt"
grep -qE '^srw------- .* u:object_r:app_data_file:' "$logs/socket.txt"
wait_until notified "チューナー 0 台"

# --- denpa と同じように組む (test.yml の agent-macos と同じ手順)。鍵と合言葉はアプリの置き場にあるので run-as で読む
echo "=== denpa と同じように組む"
adb forward "tcp:$port" "tcp:$port"
adb shell run-as "$pkg" cat files/denpa/config/tls/agent.crt | tr -d '\r' > "$host/agent.crt"
token=$(adb shell run-as "$pkg" cat files/denpa/config/tls/pair-token | tr -d '\r\n')
printf '[req]\ndistinguished_name = dn\n[dn]\n' > "$host/client.cnf"
openssl ecparam -name prime256v1 -genkey -noout -out "$host/client.key"
openssl req -config "$host/client.cnf" -new -x509 -key "$host/client.key" -out "$host/client.crt" -days 2 -subj /CN=denpa
fp() { openssl x509 -in "$1" -outform der | sha256sum | cut -d' ' -f1; }
agent=$(fp "$host/agent.crt")
client=$(fp "$host/client.crt")
proof=$(printf 'denpa-pair/client\n%s\n%s' "$agent" "$client" | openssl dgst -sha256 -hmac "$token" -binary | base64 | tr '+/' '-_' | tr -d '=')
call() { curl -fsS -k --max-time 10 --cert "$host/client.crt" --key "$host/client.key" "$@"; }
url="https://127.0.0.1:$port"
test "$(curl -s -k -o /dev/null -w '%{http_code}' --cert "$host/client.crt" --key "$host/client.key" "$url/denpa/card")" = 403
call -H 'Content-Type: application/json' -d "{\"client\":\"$client\",\"proof\":\"$proof\"}" "$url/denpa/pair" | tee "$logs/pair.json"; echo
call "$url/denpa/about" | tee "$logs/about.json"; echo
jq -e '.version == "dev" and .arch == "x64" and .os == "android"' "$logs/about.json"
call "$url/denpa/tuners" | tee "$logs/tuners.json"; echo
jq -e '.tuners | length == 0' "$logs/tuners.json"
call "$url/denpa/card" | tee "$logs/card.json"; echo
jq -e '.ok == false' "$logs/card.json"

# --- アプリの LocalSocket から、ファイルの fd を付けた attached を送る。fd が別の write に付けば、エージェントは「fd の付いていない attached」で捨てる。
echo "=== ファイルの fd を付けた attached を送る"
# どの機種でもない ID なのでチューナーには出ない。ファイルの fd には CONNINFO_EX が使えないので、ポートは名前から作る
broadcast ATTACH_FILE
wait_log "アプリから USB の機材を受け取りました: 001-004 (1234:5678)"
wait_log "アプリから USB の機材を 1 台受け取りました"
if adb logcat -d -s denpa-agent | grep -qF "fd の付いていない attached"; then
  echo "fd が attached の行に付いていません" >&2
  exit 1
fi

# --- asicen-userland。asicend はエージェントの子プロセス (untrusted_app) で起動できる (起動したときに --version を記録に出す)。
# ファームウェア待ちの ID (1738:5211) でファイルの fd を送ると、エージェントが fd を継がせて asicend --fd を起動する。
# asicend は、継いだ fd が usbfs でなければ USB_IO で終わる (継いでいなければ INVALID_ARGUMENT)
echo "=== asicen-userland"
wait_log "asicen-userland: asicend 1.0.0"
adb shell run-as "$pkg" ls -l files/asicen/asicen-loader.bin | tr -d '\r' | tee "$logs/asicen.txt"
grep -qE ' 16384 ' "$logs/asicen.txt"
broadcast ATTACH_FILE --ei vendor 5944 --ei product 21009
wait_log "アプリから USB の機材を受け取りました: 001-004 (1738:5211)"
wait_log "ファームウェアの流し込みで asicend が終了しました"
adb logcat -d -s denpa-agent | tr -d '\r' | grep -F "ファームウェアの流し込みで asicend が終了しました" | tee -a "$logs/asicen.txt"
grep -qF "file descriptor model: USB_IO" "$logs/asicen.txt"
# asicend の SELinux の拒否は記録に残す。API 36 では、/dev/bus/usb の一覧を読むことと、普通のファイルへの usbfs の ioctl が断られる
# (一覧を読めなくても asicend は fd を使うところまで進む。実機の usbfs の fd への ioctl は確かめていない)。実行そのものを断られたら止める
adb logcat -d | tr -d '\r' | grep -E 'avc: +denied' | grep -F 'libasicen' | tee "$logs/asicen-avc.txt" || true
if grep -qE '\{ (execute|execute_no_trans) \}' "$logs/asicen-avc.txt"; then
  echo "SELinux が asicend の実行を断りました" >&2
  exit 1
fi

# --- bun。常駐サービスが APK の assets のサーバを書き出し、bun をアプリの子プロセス (untrusted_app) で起動する。
# GET /check は bun の中から JIT などを試した結果を返す (android/app/src/debug/assets/server/app/server.js)
echo "=== bun"
wait_until has_bun
wait_log "が 3000 番で待ち受けています"
adb shell ps -A -o LABEL,USER,PID,PPID,NAME | tr -d '\r' | grep -F libbun.so | tee "$logs/bun-process.txt"
grep -qE "^u:r:untrusted_app:[^ ]+ +[^ ]+ +$(bun_pid) +$app +libbun.so$" "$logs/bun-process.txt"
adb forward tcp:3000 tcp:3000
curl -fsS --max-time 60 http://127.0.0.1:3000/check | tee "$logs/bun-check.json"; echo
version=$(jq -r .version "$logs/bun-check.json")
wait_log "bun $version"
# JIT (DFG で組まれた回数が 1 回以上)、localhost を引ける、/proc から読める、bun が自分を子プロセスで起動できる、bun:sqlite で書ける。
# 外の名前 (github.com) と HTTPS は、ランナーのネットワークに左右されるので、結果を残すだけにする
jq -e --arg v "$version" '
  .platform == "android" and .arch == "x64"
  and .jit.dfgCompiles > 0
  and .dns.localhost.ok
  and .proc.stat.ok and .proc.openFiles.ok and .proc.cpus.ok and .proc.totalmem.ok and .proc.rss.ok
  and .spawn.ok and .spawn.value.exitCode == 0 and .spawn.value.stdout == $v
  and .sqlite.value >= 1' "$logs/bun-check.json"
jq -c '{dns: .dns.external, fetch, interfaces: .proc.interfaces, root: .proc.root}' "$logs/bun-check.json"
# bun の SELinux の拒否は記録に残す。API 36 では `/` の一覧を読むことが断られる。実行そのものや、実行できるメモリを断られたら止める
adb logcat -d | tr -d '\r' | grep -E 'avc: +denied' | grep -F 'libbun' | tee "$logs/bun-avc.txt" || true
if grep -qE '\{ (execute|execute_no_trans|execmem) \}' "$logs/bun-avc.txt"; then
  echo "SELinux が bun の実行を断りました" >&2
  exit 1
fi

# --- ffmpeg・ffprobe。常駐サービスが FFMPEG・FFPROBE で APK の libffmpeg.so・libffprobe.so を渡し、bun が子プロセスで起動する。
# tests/native-smoke.ts をアプリの置き場 (DENPA_HOME/smoke/) に置き、POST /smoke で流す (エンコードがあるので数分かかる)
echo "=== ffmpeg"
jq -e '.ffmpeg.ok and (.ffmpeg.value.line | startswith("ffmpeg version"))
  and .ffprobe.ok and (.ffprobe.value.line | startswith("ffprobe version"))' "$logs/bun-check.json"
adb push "$smoke" /data/local/tmp/native-smoke.js > /dev/null
adb shell "cat /data/local/tmp/native-smoke.js | run-as $pkg sh -c 'mkdir -p files/denpa/smoke && cat > files/denpa/smoke/native-smoke.js'"
adb shell rm /data/local/tmp/native-smoke.js
curl -fsS --max-time 1200 -X POST http://127.0.0.1:3000/smoke > "$logs/ffmpeg-smoke.json"
jq -r .stdout "$logs/ffmpeg-smoke.json" | tee "$logs/ffmpeg-smoke.txt"
jq -r .stderr "$logs/ffmpeg-smoke.json" | tee "$logs/ffmpeg-smoke-stderr.txt" >&2
jq -e .ok "$logs/ffmpeg-smoke.json" > /dev/null
# 終了コードだけでなく、最後まで流れたかも見る (ffprobe は 10 種類のファイル)
test "$(grep -cE '^ffprobe .+: ok$' "$logs/ffmpeg-smoke.txt")" = 10
for line in "ffmpeg: ok" "h264_mediacodec: ok" "no GPU: software encoding: ok" "side output closes when ffmpeg fails: ok"; do
  grep -qxF "$line" "$logs/ffmpeg-smoke.txt" || { echo "native-smoke の出力に「$line」がありません" >&2; exit 1; }
done
# ffmpeg・ffprobe の SELinux の拒否は記録に残す。実行そのものを断られたら止める
adb logcat -d | tr -d '\r' | grep -E 'avc: +denied' | grep -E 'libff(mpeg|probe)' | tee "$logs/ffmpeg-avc.txt" || true
if grep -qE '\{ (execute|execute_no_trans) \}' "$logs/ffmpeg-avc.txt"; then
  echo "SELinux が ffmpeg の実行を断りました" >&2
  exit 1
fi

# --- エージェントが異常終了したら、アプリが起動し直して繋ぎ直す
echo "=== エージェントに SIGKILL を送る"
adb logcat -c
broadcast KILL_AGENT
wait_log "起動し直します"
wait_log "起動しました (PID"
wait_until has_agent
test "$(agent_pid)" != "$pid"
pid=$(agent_pid)
wait_log "アプリから USB の機材を 0 台受け取りました"

# --- 通知の「終了」。SIGTERM が届き、エージェントも bun も常駐サービスも残らない
echo "=== 通知の「終了」"
adb logcat -c
broadcast PRESS_STOP
wait_log "通知の「終了」で、エージェント・サーバに SIGTERM を送りました"
wait_until no_agent
wait_until no_bun
wait_until service_gone
wait_log "部品がすべて終了したため、常駐サービスを止めます"

# --- アイコンで始め直し、端末を起動し直すと BOOT_COMPLETED で始まる
echo "=== 端末を起動し直す"
timeout 60 adb shell am start -n "$pkg/.StartActivity" > /dev/null
wait_until service_running
wait_until has_agent
adb reboot
timeout 300 adb wait-for-device
for _ in $(seq 120); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 2
done
wait_until service_running
wait_until has_agent
wait_until has_bun
wait_log "アプリから USB の機材を 0 台受け取りました"
broadcast PRESS_STOP
wait_until no_agent
wait_until no_bun
wait_until service_gone
echo "常駐サービスが始まり、エージェントと bun がアプリの子プロセスで答え、bun から ffmpeg・ffprobe を流せ、USB_BROKER で fd を受け取り、「終了」と端末の起動で止まり・始まりました"
