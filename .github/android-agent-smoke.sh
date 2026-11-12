#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android 向けのエージェント (linux-bionic-x64) をエミュレータで起動し、HTTP に答えるかを確かめる (.github/workflows/android.yml)。
#
#   bash .github/android-agent-smoke.sh <denpa-agent の実行ファイル> <偽のアプリ (fake-usb-broker)> <記録の置き場>
#
# エミュレータが起きてから android-emulator-runner が流す。アプリ (APK) はまだ無いので、実行ファイルを `adb push` で
# /data/local/tmp に置き、shell のユーザーで起動する。アプリの子プロセス (untrusted_app の SELinux と seccomp) では動かしていない。
#
# 確かめること
# - `--version` と `--pair` (鍵と合言葉を作り、組む URL を出す。Android での `Environment.MachineName` を記録に残す)
# - `/system/bin/sh -c 'echo $$; exec …'` で起動し、出力の最初の行の PID が実行ファイルの PID になること (アプリが止めるときの作り)
# - サーバが起動し、`--status` (自分の証明書で TLS) が答えること
# - `adb forward` 越しに、denpa と同じ手順で組み (`POST /denpa/pair`)、`/denpa/about`・`/denpa/tuners`・`/denpa/card` が答えること
# - `USB_BROKER` で待ち受け、偽のアプリ (.github/fake-usb-broker.c) から `synced` だけを受けたらチューナーが 0 台のままで、
#   ファイルの fd を付けた `attached` も受け取れること。`/denpa/about` の `os` が `android` になること。shell のユーザーの SELinux は
#   /data/local/tmp にソケットのファイルを作らせないので、ここだけ `adb root` で permissive にしてから shell のユーザーで起動し直す
# - 受け取った PID に SIGTERM を 1 回送ると終わること (録画していなければすぐ終わる)
# ---------------------------------------------------------------------------
set -euo pipefail

bin=$1
broker=$2
logs=$3
mkdir -p "$logs"
logs=$(cd "$logs" && pwd)
dir=/data/local/tmp/denpa
port=25252
# 合言葉は denpa と同じく 32 字以上の乱数 (短いとエージェントが警告する)
token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
host=$(mktemp -d)

on_exit() {
  status=$?
  if [ -n "${adb_pid:-}" ]; then kill "$adb_pid" 2>/dev/null || true; fi
  adb pull "$dir/agent.log" "$logs/agent.log" >/dev/null 2>&1 || true
  adb pull "$dir/agent-broker.log" "$logs/agent-broker.log" >/dev/null 2>&1 || true
  adb logcat -d > "$logs/logcat.txt" 2>/dev/null || true
  echo "--- agent.log"
  cat "$logs/agent.log" 2>/dev/null || true
  echo "--- agent-broker.log"
  cat "$logs/agent-broker.log" 2>/dev/null || true
  exit "$status"
}
trap on_exit EXIT

adb shell getprop ro.build.version.release | tee "$logs/android-version.txt"
adb shell uname -r | tee "$logs/kernel.txt"
adb shell "rm -rf $dir && mkdir -p $dir"
adb push "$bin" "$dir/denpa-agent" >/dev/null
adb push "$broker" "$dir/fake-usb-broker" >/dev/null
adb shell chmod 755 "$dir/denpa-agent" "$dir/fake-usb-broker"
env="cd $dir && env AGENT_PORT=$port TUNERS_FILE=$dir/config/tuners.json CHANNELS_FILE=$dir/config/channels.json AGENT_PAIR_TOKEN=$token TMPDIR=$dir"

adb shell "$env ./denpa-agent --version" | tee "$logs/version.txt"
test "$(tr -d '\r' < "$logs/version.txt")" = dev

adb shell "$env ./denpa-agent --pair" | tr -d '\r' | tee "$logs/pair-url.txt"
grep -qE "^https://[^:]+:$port#pair=$token\$" "$logs/pair-url.txt"

# アプリと同じ起動の作り (sh が自分の PID を出してから exec する。exec は PID を変えない)。ここでは標準出力をログに回すので、PID はファイルに書く
# 端末の側でバックグラウンドで実行すると adb shell が戻らないこと (API 35) と 255 で終わること (API 29) があったので、adb shell ごとランナーの側でバックグラウンドで実行する
# start <環境> <ログのファイルの名前>
start() {
  log=$2
  adb shell "$1 /system/bin/sh -c 'echo \$\$ > $dir/agent.pid; exec \"\$0\" \"\$@\"' ./denpa-agent < /dev/null > $dir/$log 2>&1" &
  adb_pid=$!
  for _ in $(seq 30); do
    timeout 15 adb shell "$1 ./denpa-agent --status" > "$host/status.json" 2>/dev/null && break
    sleep 1
  done
  tr -d '\r' < "$host/status.json" > "$logs/status-$log.json"
  jq -e '.tuners | type == "array"' "$logs/status-$log.json"
  pid=$(adb shell cat "$dir/agent.pid" | tr -d '\r')
}

# 受け取った PID に SIGTERM を 1 回送り、終わるのを待つ
stop() {
  adb shell kill -TERM "$pid"
  for _ in $(seq 20); do
    adb shell "kill -0 $pid 2>/dev/null" || break
    sleep 1
  done
  if adb shell "kill -0 $pid 2>/dev/null"; then
    echo "SIGTERM で終わりません" >&2
    exit 1
  fi
  wait "$adb_pid" || true
  adb_pid=
}

start "$env" agent.log
# PID が sh ではなくエージェントのものになっていること
adb shell cat "/proc/$pid/cmdline" | tr '\0' ' ' | tee "$logs/cmdline.txt"; echo
grep -q denpa-agent "$logs/cmdline.txt"

# denpa と同じように組む (test.yml の agent-macos と同じ手順)。拡張の無い自己署名の証明書を作り、合言葉から proof を作る
adb forward "tcp:$port" "tcp:$port"
adb pull "$dir/config/tls/agent.crt" "$host/agent.crt" >/dev/null
printf '[req]\ndistinguished_name = dn\n[dn]\n' > "$host/client.cnf"
openssl ecparam -name prime256v1 -genkey -noout -out "$host/client.key"
openssl req -config "$host/client.cnf" -new -x509 -key "$host/client.key" -out "$host/client.crt" -days 2 -subj /CN=denpa
fp() { openssl x509 -in "$1" -outform der | sha256sum | cut -d' ' -f1; }
agent=$(fp "$host/agent.crt")
client=$(fp "$host/client.crt")
proof=$(printf 'denpa-pair/client\n%s\n%s' "$agent" "$client" | openssl dgst -sha256 -hmac "$token" -binary | base64 | tr '+/' '-_' | tr -d '=')
call() { curl -fsS -k --max-time 10 --cert "$host/client.crt" --key "$host/client.key" "$@"; }
url="https://127.0.0.1:$port"
# 組む前は 403
test "$(curl -s -k -o /dev/null -w '%{http_code}' --cert "$host/client.crt" --key "$host/client.key" "$url/denpa/card")" = 403
call -H 'Content-Type: application/json' -d "{\"client\":\"$client\",\"proof\":\"$proof\"}" "$url/denpa/pair" | tee "$logs/pair.json"; echo
call "$url/denpa/about" | tee "$logs/about.json"; echo
jq -e '.version == "dev" and .arch == "x64" and .os == "linux"' "$logs/about.json"
call "$url/denpa/tuners" | tee "$logs/tuners.json"; echo
jq -e '.tuners | type == "array"' "$logs/tuners.json"
call "$url/denpa/card" | tee "$logs/card.json"; echo
jq -e '.ok == false' "$logs/card.json"
stop

# USB_BROKER (アプリから USB を受け取る口)。エミュレータには USB の機材を挿せないので、偽のアプリが行を送る。
# shell のユーザーの SELinux (shell) は /data/local/tmp にソケットのファイルを作らせないので、ここからは SELinux を permissive にして
# 起動し直す (アプリの untrusted_app で作れるかは APK を作ってから見る)。組んだ記録は同じ置き場にあるので、組み直さない
adb root >/dev/null
adb wait-for-device
adb shell setenforce 0
adb unroot >/dev/null
adb wait-for-device
test "$(adb shell id -u | tr -d '\r')" != 0
adb forward "tcp:$port" "tcp:$port"
start "$env USB_BROKER=$dir/u" agent-broker.log
# agent-broker.log にその行が出るまで待つ (10 秒まで)
wait_log() {
  for _ in $(seq 20); do
    adb shell cat "$dir/agent-broker.log" | tr -d '\r' | grep -qF "$1" && return 0
    sleep 0.5
  done
  echo "agent-broker.log に「$1」が出ません" >&2
  return 1
}
call "$url/denpa/about" | tee "$logs/about-broker.json"; echo
jq -e '.os == "android"' "$logs/about-broker.json"
for _ in $(seq 20); do adb shell "test -S $dir/u" && break; sleep 0.5; done
test "$(adb shell stat -c %a "$dir/u" | tr -d '\r')" = 600
# synced だけ (許可のある機材が無い)。チューナーは 0 台のまま
adb shell "$dir/fake-usb-broker $dir/u /dev/null '{\"type\":\"synced\"}'"
wait_log "アプリから USB の機材を 0 台受け取りました"
call "$url/denpa/tuners" | tee "$logs/tuners-broker.json"; echo
jq -e '.tuners | length == 0' "$logs/tuners-broker.json"
# fd を付けた attached。どの機種でもない ID なのでチューナーには出ない。ファイルの fd には CONNINFO_EX が使えないので、ポートは名前から作る
printf '\x12\x01\x00\x02\x00\x00\x00\x40\x34\x12\x78\x56\x00\x01\x01\x02\x03\x01' > "$host/device.bin"
adb push "$host/device.bin" "$dir/device.bin" >/dev/null
adb shell "$dir/fake-usb-broker $dir/u $dir/device.bin '{\"type\":\"attached\",\"name\":\"/dev/bus/usb/001/004\",\"vendor\":4660,\"product\":22136,\"interfaces\":[]}' '{\"type\":\"synced\"}'"
wait_log "アプリから USB の機材を受け取りました: 001-004 (1234:5678)"
wait_log "アプリから USB の機材を 1 台受け取りました"
call "$url/denpa/tuners" | tee "$logs/tuners-attached.json"; echo
jq -e '.tuners | length == 0' "$logs/tuners-attached.json"
stop
echo "エージェントが起動し、組んで答え、USB_BROKER で fd を受け取り、SIGTERM で終わりました"
