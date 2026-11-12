#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Android 向けのエージェント (linux-bionic-x64) をエミュレータで起動し、HTTP に答えるかを確かめる (.github/workflows/android.yml)。
#
#   bash .github/android-agent-smoke.sh <denpa-agent の実行ファイル> <記録の置き場>
#
# エミュレータが起きてから android-emulator-runner が流す。アプリ (APK) はまだ無いので、実行ファイルを `adb push` で
# /data/local/tmp に置き、shell のユーザーで起動する。アプリの子プロセス (untrusted_app の SELinux と seccomp) では動かしていない。
#
# 確かめること
# - `--version` と `--pair` (鍵と合言葉を作り、組む URL を出す。Android での `Environment.MachineName` を記録に残す)
# - `/system/bin/sh -c 'echo $$; exec …'` で起動し、出力の最初の行の PID が実行ファイルの PID になること (アプリが止めるときの作り)
# - サーバが起動し、`--status` (自分の証明書で TLS) が答えること
# - `adb forward` 越しに、denpa と同じ手順で組み (`POST /denpa/pair`)、`/denpa/about`・`/denpa/tuners`・`/denpa/card` が答えること
# - 受け取った PID に SIGTERM を 1 回送ると終わること (録画していなければすぐ終わる)
# ---------------------------------------------------------------------------
set -euo pipefail

bin=$1
logs=$2
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
  adb logcat -d > "$logs/logcat.txt" 2>/dev/null || true
  echo "--- agent.log"
  cat "$logs/agent.log" 2>/dev/null || true
  exit "$status"
}
trap on_exit EXIT

adb shell getprop ro.build.version.release | tee "$logs/android-version.txt"
adb shell uname -r | tee "$logs/kernel.txt"
adb shell "rm -rf $dir && mkdir -p $dir"
adb push "$bin" "$dir/denpa-agent" >/dev/null
adb shell chmod 755 "$dir/denpa-agent"
env="cd $dir && env AGENT_PORT=$port TUNERS_FILE=$dir/config/tuners.json CHANNELS_FILE=$dir/config/channels.json AGENT_PAIR_TOKEN=$token TMPDIR=$dir"

adb shell "$env ./denpa-agent --version" | tee "$logs/version.txt"
test "$(tr -d '\r' < "$logs/version.txt")" = dev

adb shell "$env ./denpa-agent --pair" | tr -d '\r' | tee "$logs/pair-url.txt"
grep -qE "^https://[^:]+:$port#pair=$token\$" "$logs/pair-url.txt"

# アプリと同じ起動の作り (sh が自分の PID を出してから exec する。exec は PID を変えない)。ここでは標準出力をログに回すので、PID はファイルに書く
# 端末の側で背後に回すと adb shell が戻らないこと (API 35) と 255 で終わること (API 29) があったので、adb shell ごとランナーの側で背後に回す
adb shell "$env /system/bin/sh -c 'echo \$\$ > $dir/agent.pid; exec \"\$0\" \"\$@\"' ./denpa-agent < /dev/null > $dir/agent.log 2>&1" &
adb_pid=$!
for _ in $(seq 30); do
  timeout 15 adb shell "$env ./denpa-agent --status" > "$host/status.json" 2>/dev/null && break
  sleep 1
done
tr -d '\r' < "$host/status.json" > "$logs/status.json"
jq -e '.tuners | type == "array"' "$logs/status.json"
pid=$(adb shell cat "$dir/agent.pid" | tr -d '\r')
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
jq -e '.version == "dev" and .arch == "x64"' "$logs/about.json"
call "$url/denpa/tuners" | tee "$logs/tuners.json"; echo
jq -e '.tuners | type == "array"' "$logs/tuners.json"
call "$url/denpa/card" | tee "$logs/card.json"; echo
jq -e '.ok == false' "$logs/card.json"

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
echo "エージェントが起動し、組んで答え、SIGTERM で終わりました"
