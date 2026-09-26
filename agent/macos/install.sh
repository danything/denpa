#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# denpa のチューナーエージェントを Mac (Apple Silicon) に入れる。
#
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/agent/macos/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/agent/macos/install.sh | bash -s -- --uninstall
#
# **denpa 本体は Linux (Docker) のまま。** Mac で動くのはエージェントだけで、
# denpa からは TUNER_AGENT_URL で HTTP 越しに繋ぐ (別の拠点に置くのと同じ形。docs/agent.md)。
#
# 入れるのは全部ユーザーの下 (sudo は要らない)。もう一度流せば、そのまま上げ直しになる。
#
#   ~/Library/Application Support/denpa-agent/  本体・px4-userland・siano-userland・設定
#   ~/Library/LaunchAgents/<LABEL>.plist        ログインしたら起こし、落ちたら起こし直す
#   ~/Library/Logs/denpa-agent.log              ログ
#
# 環境変数で変えられるもの: AGENT_PORT (25252)、DENPA_AGENT_VERSION (v1.2.3 のように。既定は最新のリリース)、
# DENPA_AGENT_TARBALL (手元の tar.gz を絶対パスで。CI と開発用)
#
# macOS の bash は 3.2 なので、4 以降の書き方 (連想配列・mapfile など) は使わない。
# ---------------------------------------------------------------------------
set -euo pipefail

# px4-userland / siano-userland の版。**Dockerfile と揃える** (Renovate が両方いっしょに上げる)。
# 中身は配布元の SHA256SUMS で確かめるので、版を上げてもここのハッシュは要らない
# renovate: datasource=github-releases depName=Khronos31/px4-userland extractVersion=^v(?<version>.*)$
PX4_USERLAND_VERSION=0.1.6
# renovate: datasource=github-releases depName=Khronos31/siano-userland extractVersion=^v(?<version>.*)$
SIANO_USERLAND_VERSION=0.1.8
ISDBT_RIO_SHA256=054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818

# IT930x のファームウェアは PLEX 公式ドライバから切り出す。3つのハッシュは Dockerfile と同じ
PLEX_DRIVER_SHA256=bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200
PXW3U4_SYS_SHA256=8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722
IT930X_FIRMWARE_SHA256=5213a5a38872661277a2cc1b2dfdfe88faf06f41205f460f3b51857f0568b484

REPO=danything/denpa
LABEL=io.github.danything.denpa-agent
PREFIX="$HOME/Library/Application Support/denpa-agent"
# px4d の制御ソケットの置き場。**短く保つ** — Unix ソケットのパスは macOS だと 104 バイトまでで、
# この下に px4-userland/<筐体の番号>/control.sock (42 文字) が付く。Application Support の下では溢れうる
RUNTIME="$HOME/Library/Caches/denpa-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/denpa-agent.log"
PORT="${AGENT_PORT:-25252}"
LIBUSB=/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib
DOMAIN="gui/$(id -u)"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }

# 止める。**録画中なら終わるまで待つ** (エージェントが SIGTERM で録画を待ってから畳む。plist の ExitTimeOut)
stop() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    say "動いているエージェントを止めます (録画中なら終わるまで待ちます)"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  stop
  rm -f "$PLIST"
  rm -rf "$PREFIX" "$RUNTIME"
  say "消しました (ログ $LOG は残してあります)"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || die "macOS 用です (Linux ではコンテナで動かしてください。docs/agent.md)"
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

fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "取ってこられません: $1"; }
check() {
  [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$2" ] || die "$1 のハッシュが合いません (壊れているか、差し替えられています)"
}
# SHA256SUMS から1行引いて確かめる
check_listed() {
  expected=$(awk -v name="$1" '$2 == name || $2 == "*" name {print $1}' "$2")
  [ -n "$expected" ] || die "$2 に $1 が載っていません"
  check "$1" "$expected"
}

# --- エージェント本体 (GitHub のリリース) ---------------------------------
# DENPA_AGENT_TARBALL に手元で組んだものを渡すと、リリースから取らずにそれを入れる (CI と開発用)
agent="${DENPA_AGENT_TARBALL:-}"
if [ -z "$agent" ]; then
  tag="${DENPA_AGENT_VERSION:-}"
  if [ -z "$tag" ]; then
    # API を使わず、latest の転送先からタグを読む (API は回数制限がある)
    tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
    tag="${tag##*/}"
  fi
  agent="denpa-agent-${tag#v}-darwin-arm64.tar.gz"
  say "denpa-agent $tag"
  curl -fsSL --retry 3 -o "$agent" "https://github.com/$REPO/releases/download/$tag/$agent" \
    || die "$tag には Mac 用のエージェントがありません (Mac 用を出し始める前の版かもしれません)"
  fetch "https://github.com/$REPO/releases/download/$tag/$agent.sha256" "$agent.sha256"
  check "$agent" "$(awk '{print $1}' "$agent.sha256")"
fi
mkdir -p new/bin && tar -xzf "$agent" -C new/bin

# --- px4-userland (PX-Q3U4 など) ------------------------------------------
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

# --- siano-userland (PX-S1UD など) ----------------------------------------
say "siano-userland $SIANO_USERLAND_VERSION"
base="https://github.com/Khronos31/siano-userland/releases/download/v$SIANO_USERLAND_VERSION"
siano="siano-ts-$SIANO_USERLAND_VERSION-darwin-arm64.tar.gz"
fetch "$base/$siano" "$siano"
fetch "$base/SHA256SUMS" siano.sums
check_listed "$siano" siano.sums
mkdir -p new/siano-userland && tar -xzf "$siano" -C new/siano-userland
check new/siano-userland/firmware/isdbt_rio.inp "$ISDBT_RIO_SHA256"

# --- 入れ替える。**揃ってから止める** (取ってこられなかったら、動いているものに触らない) ---
stop
mkdir -p "$PREFIX/config" "$RUNTIME" "$(dirname "$PLIST")" "$(dirname "$LOG")"
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
  </dict>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"

say "起こしました。応答を待ちます"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if tuners=$(curl -fsS "http://127.0.0.1:$PORT/denpa/tuners" 2>/dev/null); then
    echo "$tuners"
    host=$(scutil --get LocalHostName 2>/dev/null || hostname)
    say "入りました。denpa の TUNER_AGENT_URL に http://$host.local:$PORT を書いてください"
    exit 0
  fi
  sleep 2
done
die "応答がありません。ログを見てください: $LOG"
