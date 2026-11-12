#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android のアプリ (debug の APK) をエミュレータに入れて起動し、常駐サービスとエージェントを確かめる (.github/workflows/android.yml)。
#
#   bash .github/android-app-smoke.sh <APK> <記録の置き場>
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
# - エージェントが異常終了すると、アプリが起動し直し、繋ぎ直して synced を送り直す
# - 通知の「終了」で SIGTERM が届き、エージェントも常駐サービスも残らない
# - アイコンで始めたあとに端末を起動し直すと、BOOT_COMPLETED で常駐サービスが始まる
# ---------------------------------------------------------------------------
set -euo pipefail

apk=$1
logs=$2
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
  echo "--- logcat (denpa・denpa-agent)"
  timeout 30 adb logcat -d -s denpa denpa-agent 2>/dev/null | tail -n 80 || true
  exit "$status"
}
trap on_exit EXIT

# ログの denpa (アプリ) と denpa-agent (エージェントの出力) に、その文言が出るまで待つ (30 秒まで)
wait_log() {
  for _ in $(seq 60); do
    adb logcat -d -s denpa denpa-agent | tr -d '\r' | grep -qF "$1" && return 0
    sleep 0.5
  done
  echo "logcat に「$1」が出ません" >&2
  return 1
}

# エージェントの PID (動いていなければ空)
agent_pid() {
  adb shell ps -A -o PID,NAME | tr -d '\r' | awk '$2 == "libdenpa_agent.so" { print $1 }'
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
# 通知の本文に出ているか
notified() { adb shell dumpsys notification --noredact | tr -d '\r' | grep -A60 "pkg=$pkg" | grep -qF "android.text=String ($1)"; }

broadcast() { adb shell am broadcast -n "$pkg/.DebugReceiver" -a "$pkg.debug.$1" > /dev/null; }

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

# --- 通知の「終了」。SIGTERM が届き、エージェントも常駐サービスも残らない
echo "=== 通知の「終了」"
adb logcat -c
broadcast PRESS_STOP
wait_log "通知の「終了」で、エージェントに SIGTERM を送りました"
wait_until no_agent
wait_until service_gone
wait_log "エージェントが終了したため、常駐サービスを止めます"

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
wait_log "アプリから USB の機材を 0 台受け取りました"
broadcast PRESS_STOP
wait_until no_agent
wait_until service_gone
echo "常駐サービスが始まり、エージェントがアプリの子プロセスで答え、USB_BROKER で fd を受け取り、「終了」と端末の起動で止まり・始まりました"
