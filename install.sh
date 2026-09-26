#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# denpa を立てる。**Linux でも Mac でも同じ1行で、ブラウザが開くところまで。**
#
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
#   … | bash -s -- --no-open      ブラウザを開かない
#   … | bash -s -- --uninstall    止めて外す (録画・DB・設定は残す)
#   … | bash -s -- --no-docker    Mac だけ: エージェントだけ (denpa 本体は別の Linux で動かす)
#
# **Linux** は全部 Docker Compose (compose.prod.yml をそのまま置く)。
# **Mac (Apple Silicon)** は、エージェントを Mac の上でそのまま動かし (LaunchAgent)、
# denpa 本体だけ Docker で (compose.mac.yml)。Mac の Docker はコンテナに USB を渡せないので、
# チューナーとカードに触るエージェントはコンテナに入れられない。
#
# **Docker は勝手に入れない。** 無い・起きていない・触る権限が無いときは、入れ方を案内して止まる
# (Mac はエージェントだけ入れてから)。もう一度流せば、そのまま上げ直しになる (pull して up -d)。
# compose ファイルもイメージも**最新のリリースの版**に揃える。
#
# 置き場:
#   Linux  ~/denpa (DENPA_HOME で変えられる)          compose.yml・.env・config/
#   Mac    ~/Library/Application Support/denpa-agent/  エージェント・px4-userland・siano-userland・設定・compose.yml
#          ~/Library/LaunchAgents/<LABEL>.plist        ログインしたら起こし、落ちたら起こし直す
#          ~/Library/Logs/denpa-agent.log              エージェントのログ
#          ~/Movies/denpa/{recorded,library}           生TS (エージェントとコンテナの両方が見る) と出来上がった録画
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、
# DENPA_HOME (Linux の置き場)、AGENT_PORT (Mac のエージェント。25252)、
# DENPA_AGENT_TARBALL (Mac: 手元で焼いたエージェントの tar.gz を絶対パスで。CI と開発用)
#
# macOS の bash は 3.2 なので、4 以降の書き方 (連想配列・mapfile など) は使わない。
# ---------------------------------------------------------------------------
set -euo pipefail

# px4-userland / siano-userland の版 (Mac)。**agent/Dockerfile と揃える** (Renovate が両方いっしょに上げる)。
# 中身は配布元の SHA256SUMS で確かめるので、版を上げてもここのハッシュは要らない
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
PX4_USERLAND_VERSION=0.1.6
# renovate: datasource=github-releases depName=Khronos31/siano-userland extractVersion=^v(?<version>.*)$
SIANO_USERLAND_VERSION=0.1.8
ISDBT_RIO_SHA256=054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818

# IT930x のファームウェアは PLEX 公式ドライバから切り出す。3つのハッシュは agent/Dockerfile と同じ
PLEX_DRIVER_SHA256=bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200
PXW3U4_SYS_SHA256=8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722
IT930X_FIRMWARE_SHA256=5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484

REPO=danything/denpa
URL=http://localhost:3000

open_browser=yes uninstall=no docker_mode=yes
for arg in "$@"; do
  case "$arg" in
    --no-open) open_browser=no ;;
    --uninstall) uninstall=yes ;;
    --no-docker) docker_mode=no ;;
    *) echo "知らない引数: $arg (--no-open / --uninstall / --no-docker)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }
fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "取ってこられません: $1"; }

# 入れる版。compose ファイルはこの版 (git の ref) から取り、イメージは x.y.z の形のときだけその版に
# 揃える (コミットやブランチなら latest)。API を使わず、latest の転送先からタグを読む (API は回数制限がある)
version() {
  if [ -n "${DENPA_VERSION:-}" ]; then echo "$DENPA_VERSION"; return; fi
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
    || die "最新のリリースが分かりません"
  echo "${tag##*/}"
}
image_tag() { printf '%s' "${1#v}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && echo "${1#v}" || echo latest; }

# Docker が使えるか。駄目なら理由と入れ方を言って 1 を返す (止めるかは呼ぶ側)
docker_ready() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    say "Docker (compose) が見当たりません。$1"
    return 1
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  if [ "$(uname -s)" = Linux ] && [ "$(id -u)" != 0 ] && ! id -nG | grep -qw docker; then
    say "Docker に触る権限がありません。sudo usermod -aG docker $USER のあと入り直して (ログインし直して)、もう一度流してください"
  else
    say "Docker が起きていません。$2"
  fi
  return 1
}

# 答えるまで待って、開けるなら開く。LAN から入るときの住所も出す
wait_and_open() {
  say "denpa の応答を待ちます"
  for _ in $(seq 90); do
    if curl -fsS -o /dev/null "$URL/api/health" 2>/dev/null; then
      say "立ちました: $URL (LAN のほかの機械からは http://$1:3000)"
      [ "$open_browser" = yes ] || return 0
      if [ "$(uname -s)" = Darwin ]; then
        open "$URL"
      elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        xdg-open "$URL" >/dev/null 2>&1 || true
      fi
      return 0
    fi
    sleep 2
  done
  die "denpa が答えません。docker compose -p denpa -f \"$2\" logs を見てください"
}

# ---------------------------------------------------------------------------
# Linux: compose.prod.yml をそのまま置いて起こす
# ---------------------------------------------------------------------------
linux_main() {
  home="${DENPA_HOME:-$HOME/denpa}"
  compose="$home/compose.yml"
  if [ "$uninstall" = yes ]; then
    [ -f "$compose" ] && docker_ready "" "" && docker compose -p denpa -f "$compose" down
    say "止めました。残してあるもの (要らなければ手で消してください):"
    say "  設定 $home / 録画と DB は docker volume rm denpa_denpa-data denpa_denpa-recorded denpa_denpa-library"
    return 0
  fi

  case "$(uname -m)" in x86_64 | aarch64 | arm64) ;; *) die "amd64 と arm64 だけです (イメージがありません)" ;; esac
  docker_ready "https://get.docker.com の手順で入れてから、もう一度流してください" \
    "sudo systemctl start docker で起こしてから、もう一度流してください" || exit 1

  ref=$(version)
  say "denpa $ref を $home に置きます"
  mkdir -p "$home/config"
  fetch "https://raw.githubusercontent.com/$REPO/$ref/compose.prod.yml" "$compose"
  echo "DENPA_TAG=$(image_tag "$ref")" > "$home/.env"
  docker compose -p denpa -f "$compose" pull
  # 録画中に上げ直すと、denpa もエージェントも録画が終わるまで待ってから入れ替わる (stop_grace_period)
  docker compose -p denpa -f "$compose" up -d
  ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  wait_and_open "${ip:-$(hostname)}" "$compose"
}

# ---------------------------------------------------------------------------
# Mac: エージェントは LaunchAgent、denpa 本体は Docker
# ---------------------------------------------------------------------------
LABEL=io.github.danything.denpa-agent
PREFIX="$HOME/Library/Application Support/denpa-agent"
# px4d の制御ソケットの置き場。**短く保つ** — Unix ソケットのパスは macOS だと 104 バイトまでで、
# この下に px4-userland/<筐体の番号>/control.sock (42 文字) が付く。Application Support の下では溢れうる
RUNTIME="$HOME/Library/Caches/denpa-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/denpa-agent.log"
PORT="${AGENT_PORT:-25252}"
LIBUSB=/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib
# 生TSはエージェント (後から解く) とコンテナ (録る) の両方が読み書きするので、Mac のフォルダに置く
MEDIA="$HOME/Movies/denpa"
MAC_DOCKER="Docker Desktop (https://www.docker.com/products/docker-desktop/) か OrbStack (https://orbstack.dev) を入れてから、もう一度流してください"

# 止める。**録画中なら終わるまで待つ** (エージェントが SIGTERM で録画を待ってから畳む。plist の ExitTimeOut)
mac_stop() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    say "動いているエージェントを止めます (録画中なら終わるまで待ちます)"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  fi
}

check() {
  [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$2" ] || die "$1 のハッシュが合いません (壊れているか、差し替えられています)"
}
# SHA256SUMS から1行引いて確かめる
check_listed() {
  expected=$(awk -v name="$1" '$2 == name || $2 == "*" name {print $1}' "$2")
  [ -n "$expected" ] || die "$2 に $1 が載っていません"
  check "$1" "$expected"
}

mac_main() {
  compose="$PREFIX/compose.yml"
  if [ "$uninstall" = yes ]; then
    # compose.yml は PREFIX の中なので、消す前に畳む。**録画中なら終わるまで待つ** (stop_grace_period)
    if [ -f "$compose" ] && docker_ready "" ""; then docker compose -p denpa -f "$compose" down; fi
    mac_stop
    rm -f "$PLIST"
    rm -rf "$PREFIX" "$RUNTIME"
    say "外しました。残してあるもの (要らなければ手で消してください):"
    say "  録画 $MEDIA / ログ $LOG / DB は docker volume rm denpa_denpa-data"
    return 0
  fi

  [ "$(uname -m)" = arm64 ] || die "Apple Silicon (arm64) の Mac だけです (px4-userland / siano-userland に Intel Mac 用がありません)"

  # px4-userland と siano-ts は Homebrew の libusb に動的にリンクしている
  if [ ! -f "$LIBUSB" ]; then
    # PATH に載せていない人もいるので、Apple Silicon の既定の場所も見る
    brew=$(command -v brew || true)
    if [ -z "$brew" ] && [ -x /opt/homebrew/bin/brew ]; then brew=/opt/homebrew/bin/brew; fi
    [ -n "$brew" ] || die "Homebrew の libusb が要ります。https://brew.sh から Homebrew を入れて、もう一度流してください"
    say "libusb を入れます (brew install libusb)"
    "$brew" install libusb
    [ -f "$LIBUSB" ] || die "$LIBUSB が見当たりません"
  fi

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cd "$work"

  # --- エージェント本体 (GitHub のリリース) -------------------------------
  ref=""
  agent="${DENPA_AGENT_TARBALL:-}"
  if [ -z "$agent" ]; then
    ref=$(version)
    agent="denpa-agent-${ref#v}-darwin-arm64.tar.gz"
    say "denpa-agent $ref"
    curl -fsSL --retry 3 -o "$agent" "https://github.com/$REPO/releases/download/$ref/$agent" \
      || die "$ref には Mac 用のエージェントがありません (Mac 用を出し始める前の版かもしれません)"
    fetch "https://github.com/$REPO/releases/download/$ref/$agent.sha256" "$agent.sha256"
    check "$agent" "$(awk '{print $1}' "$agent.sha256")"
  fi
  mkdir -p new/bin && tar -xzf "$agent" -C new/bin

  # --- px4-userland (PX-Q3U4 など) ----------------------------------------
  say "px4-userland $PX4_USERLAND_VERSION"
  base="https://github.com/Khronos31/px4-userland/releases/download/v$PX4_USERLAND_VERSION"
  px4="px4-userland-$PX4_USERLAND_VERSION-darwin-arm64.tar.gz"
  fetch "$base/$px4" "$px4"
  fetch "$base/SHA256SUMS" px4.sums
  check_listed "$px4" px4.sums
  mkdir -p new/px4-userland/firmware && tar -xzf "$px4" -C new/px4-userland

  # 再配布の許諾は誰も持っていないので、PLEX の配布物から手元で切り出す (docs/agent.md)
  say "IT930x のファームウェアを PLEX のドライバから切り出します"
  fetch https://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip driver.zip
  check driver.zip "$PLEX_DRIVER_SHA256"
  unzip -p driver.zip pxw3u4_BDA_ver1x64/PXW3U4.sys > PXW3U4.sys
  check PXW3U4.sys "$PXW3U4_SYS_SHA256"
  dd if=PXW3U4.sys of=new/px4-userland/firmware/it930x-firmware.bin bs=1 skip=$((0x287d0)) count=2169 2>/dev/null
  check new/px4-userland/firmware/it930x-firmware.bin "$IT930X_FIRMWARE_SHA256"

  # --- siano-userland (PX-S1UD など) --------------------------------------
  say "siano-userland $SIANO_USERLAND_VERSION"
  base="https://github.com/Khronos31/siano-userland/releases/download/v$SIANO_USERLAND_VERSION"
  siano="siano-ts-$SIANO_USERLAND_VERSION-darwin-arm64.tar.gz"
  fetch "$base/$siano" "$siano"
  fetch "$base/SHA256SUMS" siano.sums
  check_listed "$siano" siano.sums
  mkdir -p new/siano-userland && tar -xzf "$siano" -C new/siano-userland
  check new/siano-userland/firmware/isdbt_rio.inp "$ISDBT_RIO_SHA256"

  # --- 入れ替える。**揃ってから止める** (取ってこられなかったら、動いているものに触らない) ---
  mac_stop
  mkdir -p "$PREFIX/config" "$RUNTIME" "$MEDIA/recorded" "$MEDIA/library" "$(dirname "$PLIST")" "$(dirname "$LOG")"
  for part in bin px4-userland siano-userland; do
    rm -rf "${PREFIX:?}/$part"
    mv "new/$part" "$PREFIX/$part"
  done

  # ExitTimeOut はエージェントが録画を待つ上限 (SHUTDOWN_WAIT の既定 6 時間) より長く。
  # 短いと、止めたときに録画の途中で SIGKILL される (既定は 20 秒)。
  # ProcessType Interactive は、裏のジョブとして CPU や I/O を絞られないように (TS を流し続けるので)
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PREFIX/bin/denpa-agent</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>22200</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_PORT</key><string>$PORT</string>
    <key>TUNERS_FILE</key><string>$PREFIX/config/tuners.json</string>
    <key>CHANNELS_FILE</key><string>$PREFIX/config/channels.json</string>
    <key>PX4_USERLAND_DIR</key><string>$PREFIX/px4-userland</string>
    <key>PX4_FIRMWARE</key><string>$PREFIX/px4-userland/firmware/it930x-firmware.bin</string>
    <key>PX4_RUNTIME_DIR</key><string>$RUNTIME</string>
    <key>SIANO_USERLAND_DIR</key><string>$PREFIX/siano-userland</string>
    <key>SIANO_FIRMWARE</key><string>$PREFIX/siano-userland/firmware/isdbt_rio.inp</string>
    <key>RECORDED_DIR</key><string>$MEDIA/recorded</string>
  </dict>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST"

  say "エージェントを起こしました。応答を待ちます"
  answered=no
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if tuners=$(curl -fsS "http://127.0.0.1:$PORT/denpa/tuners" 2>/dev/null); then
      echo "$tuners"
      answered=yes
      break
    fi
    sleep 2
  done
  [ "$answered" = yes ] || die "エージェントが答えません。ログを見てください: $LOG"

  host="$(scutil --get LocalHostName 2>/dev/null || hostname).local"
  if [ "$docker_mode" = no ]; then
    say "エージェントだけ入れました。denpa の TUNER_AGENT_URL に http://$host:$PORT を書いてください"
    return 0
  fi
  docker_ready "$MAC_DOCKER" "Docker Desktop か OrbStack を起こしてから、もう一度流してください" \
    || { say "エージェントは入っています (http://$host:$PORT)"; return 0; }

  # --- denpa 本体 (Docker) -------------------------------------------------
  # compose もイメージもエージェントと同じ版に。手元の tar.gz を入れたときは main と latest
  say "denpa を起こします (docker compose)"
  fetch "https://raw.githubusercontent.com/$REPO/${ref:-main}/compose.mac.yml" "$compose"
  cat > "$PREFIX/.env" <<EOF
DENPA_TAG=$(image_tag "${ref:-main}")
AGENT_PORT=$PORT
DENPA_RECORDED=$MEDIA/recorded
DENPA_LIBRARY=$MEDIA/library
EOF
  docker compose -p denpa -f "$compose" pull
  docker compose -p denpa -f "$compose" up -d
  wait_and_open "$host" "$compose"
}

case "$(uname -s)" in
  Linux) linux_main ;;
  Darwin) mac_main ;;
  *) die "Linux と macOS だけです" ;;
esac
