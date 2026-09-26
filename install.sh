#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# denpa を立てる。**Linux でも Mac でも同じ1行で、ブラウザが開くところまで。**
#
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
#   … | bash -s -- --no-open      ブラウザを開かない
#   … | bash -s -- --uninstall    止めて外す (~/denpa の compose と設定、録画・DB は残す)
#   … | bash -s -- --no-docker    Mac だけ: エージェントだけ (denpa 本体は別の Linux で動かす)
#
# Windows は install.ps1 (同じ作りを PowerShell で。docs/agent.md「Windows でチューナーを使う」)
#
# **Linux** は全部 Docker Compose (compose.prod.yml をそのまま置く)。
# **Mac (Apple Silicon)** は、エージェントを Mac の上でそのまま動かし (LaunchAgent)、
# denpa 本体だけ Docker で (compose.mac.yml)。Mac の Docker はコンテナに USB を渡せないので、
# チューナーとカードに触るエージェントはコンテナに入れられない。
#
# **Docker は勝手に入れない。** 無い・起きていない・触る権限が無いときは、入れ方を案内して止まる
# (Mac はエージェントだけ入れてから)。もう一度流せば、そのまま上げ直しになる (pull して up -d)。
# compose ファイルもイメージも**最新のリリースの版**に揃える (取ってきた compose.yml の札を書き換える)。
#
# **入口は genkan** (https://github.com/danything/genkan。ホスト名でコンテナに振り分けるリバースプロキシ)。
# 動いていればそれを使い、無ければ 80 と 443 が空いているときだけ ~/genkan に入れて、
# http://denpa.localhost で開けるようにする (登録は compose.override.yml に書く)。
# ポート 3000 は残す — denpa.localhost はそのマシンからしか引けないので、LAN のほかの機械は IP:3000。
#
# 置き場:
#   Linux / Mac  ~/denpa (DENPA_HOME で変えられる)    compose.yml (上げ直すたびに上書き)・compose.override.yml
#                                                     (手を入れるならここ。無いときだけ雛形を作り、あれば触らない)・config/
#   Mac だけ     ~/Library/Application Support/denpa-agent/  エージェント・px4-userland・siano-userland
#                ~/Library/LaunchAgents/<LABEL>.plist        ログインしたら起こし、落ちたら起こし直す
#                ~/Library/Logs/denpa-agent.log              エージェントのログ
#                ~/Movies/denpa/{recorded,library}           生TS (エージェントとコンテナの両方が見る) と出来上がった録画
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、DENPA_HOME、
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
GENKAN_URL=http://denpa.localhost
DENPA_DIR="${DENPA_HOME:-$HOME/denpa}"
# install.sh が書いた compose.yml の1行目
MARK="# install.sh が置いた (版"

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
    say "Docker に触る権限がありません。sudo usermod -aG docker $(id -un) のあと入り直して (ログインし直して)、もう一度流してください"
  else
    say "Docker が起きていません。$2"
  fi
  return 1
}

# genkan が入っているか。**genkan ネットワークがあれば入っている** (genkan だけが作る名前。止まっていても
# 残る)。止めてあるものは起こし直さない — 意図して止めた人の genkan を上げ直すたびに復活させたり、
# 別の場所に入れた genkan の横にもう1つ clone したりしない
genkan_installed() { docker network inspect genkan >/dev/null 2>&1; }
# 動いているか (genkan ネットワークに Caddy が居るか)
genkan_running() {
  genkan_installed && docker ps --filter network=genkan --format '{{.Image}}' | grep -q caddy-docker-proxy
}
# そのポートで誰かが待ち受けているか。bash の /dev/tcp で繋いでみる (ss / lsof の違いを気にしない)
port_used() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# genkan を使えるようにする。使えれば 0。**80 か 443 が埋まっていれば入れない** (誰かのものを奪わない)
ensure_genkan() {
  genkan_running && return 0
  if genkan_installed; then
    say "genkan は入っていますが止まっています (起こせば http://denpa.localhost で開けます)"
    return 1
  fi
  if port_used 80 || port_used 443; then
    say "80 か 443 が使われているので genkan は入れません (http://localhost:3000 で開きます)"
    return 1
  fi
  # Mac の /usr/bin/git は開発者ツールが無いと入れるダイアログを出すだけの代役なので、そちらも見る
  if ! command -v git >/dev/null 2>&1 || { [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; }; then
    say "git が無いので genkan は入れません (http://localhost:3000 で開きます)"
    return 1
  fi
  say "genkan を $HOME/genkan に入れます (http://denpa.localhost で開けるように)"
  (cd "$HOME" && curl -fsSL https://raw.githubusercontent.com/danything/genkan/main/init.sh | sh -s) \
    || { say "genkan を入れられませんでした (http://localhost:3000 で開きます)"; return 1; }
  genkan_running
}

# genkan に denpa を登録する断片。**http:// を付けるので HTTPS にせず、証明書の信頼も要らない**
# (*.localhost はブラウザが安全な文脈として扱う)。
#
# **私設網の外から来たものは genkan で断る。** denpa から見た送り主は genkan のコンテナ (私設網) に
# なるので、TRUSTED_NETWORKS では外と内を見分けられない。ほかのアプリのために 80 番を外へ開けて
# いると、Host を偽るだけでインターネットから素通りになる
GENKAN_OVERRIDE='services:
  denpa:
    labels:
      caddy: http://denpa.localhost
      caddy.@outside: not remote_ip private_ranges
      caddy.respond: "@outside 403"
      caddy.reverse_proxy: "{{upstreams 3000}}"
    networks: [default, genkan]

networks:
  genkan:
    external: true'

# ~/denpa で docker compose。-f を付けないので compose.yml と compose.override.yml を Compose が自分で重ねる
compose() { (cd "$DENPA_DIR" && docker compose "$@"); }

# 取ってきた compose ($1。compose.prod.yml か compose.mac.yml) を ~/denpa/compose.yml に置いて起こす。
# **版は札で揃える** — 取ってきたものの latest をこの版に書き換える (.env は使わない)
start_denpa() {
  say "denpa $2 を $DENPA_DIR に置きます"
  mkdir -p "$DENPA_DIR/config"
  curl -fsSL --retry 3 -o "$DENPA_DIR/compose.yml.new" "https://raw.githubusercontent.com/$REPO/$2/$1" \
    || die "$2 に $1 がありません (取ってこられません)。compose.mac.yml はこのあとのリリースから入るので、それより前の版では Mac に入れられません"
  # 手で置いたもの・手を入れたものは黙って上書きせず、compose.yml.bak に退けてそう言う。
  # install.sh が書いたものは1行目が印で、残りは前に書いた控え (.compose.yml.orig) と同じはず
  if [ -f "$DENPA_DIR/compose.yml" ] && ! { head -1 "$DENPA_DIR/compose.yml" | grep -q "^$MARK" \
    && tail -n +2 "$DENPA_DIR/compose.yml" | cmp -s - "$DENPA_DIR/.compose.yml.orig"; }; then
    mv "$DENPA_DIR/compose.yml" "$DENPA_DIR/compose.yml.bak"
    say "手で置いた (手を入れた) $DENPA_DIR/compose.yml を compose.yml.bak に退けました。手直しは compose.override.yml に移してください"
  fi
  sed "s#\(image: ghcr.io/danything/[a-z-]*\):latest#\1:$(image_tag "$2")#" "$DENPA_DIR/compose.yml.new" > "$DENPA_DIR/.compose.yml.orig"
  { echo "$MARK $2。手を入れず、足すものは compose.override.yml に)"; cat "$DENPA_DIR/.compose.yml.orig"; } > "$DENPA_DIR/compose.yml"
  rm -f "$DENPA_DIR/compose.yml.new"
  override="$DENPA_DIR/compose.override.yml"
  # genkan の登録が残っているのに genkan ネットワークが無い (genkan を外した) と、up が分かりにくく落ちる
  if [ -f "$override" ] && grep -q 'denpa.localhost' "$override" && ! genkan_installed; then
    die "genkan が見当たりません。$override の genkan への登録 (labels・networks) を消すか、genkan を入れ直してから流し直してください"
  fi
  # **登録するときだけ genkan を入れる** (雛形を作るときか、もう登録が書いてあるとき)
  genkan=no
  if [ ! -f "$override" ] || grep -q 'denpa.localhost' "$override"; then
    ensure_genkan && genkan=yes
  fi
  if [ ! -f "$override" ]; then
    {
      echo "# 手元で足したい・変えたいものはここに書く。compose.yml は install.sh が上げ直すたびに"
      echo "# 上書きするが、このファイルには触らない (Compose が compose.yml に重ねて読む)。"
      echo "# たとえば denpa の environment に TRUSTED_NETWORKS: 192.168.1.0/24 を足すなど"
      if [ "$genkan" = yes ]; then
        echo "#"
        echo "# genkan (http://denpa.localhost) への登録は install.sh が書いた"
        echo "$GENKAN_OVERRIDE"
      else
        echo "services: {}"
      fi
    } > "$override"
  elif ! grep -q 'denpa.localhost' "$override" && genkan_running; then
    say "compose.override.yml には触りません。genkan の http://denpa.localhost で開くなら、次を足して流し直してください:"
    printf '%s\n' "$GENKAN_OVERRIDE"
  fi
  compose pull
  # 録画中に上げ直すと、録画が終わるまで待ってから入れ替わる (stop_grace_period)
  compose up -d
  wait_and_open "$3" "$genkan"
}

# genkan は外さない (ほかのプロジェクトも乗る)。残っていることと、畳み方を言う
genkan_left() {
  [ -d "$HOME/genkan" ] || return 0
  say "  genkan $HOME/genkan (80・443 と Arcane。要らなければ cd ~/genkan && docker compose down)。"
  say "  genkan を外したら compose.override.yml の genkan への登録も消してください"
}

# 止める (コンテナを畳むだけ。~/denpa も録画もボリュームも残す)
stop_denpa() {
  if [ -f "$DENPA_DIR/compose.yml" ] && docker_ready "" ""; then compose down; fi
}

# 答えるまで待って、開けるなら開く。LAN から入るときの住所も出す
wait_and_open() {
  say "denpa の応答を待ちます"
  for _ in $(seq 90); do
    if curl -fsS -o /dev/null "$URL/api/health" 2>/dev/null; then
      url=$URL
      # genkan 越しにも答えれば、そちらを開く (Caddy がラベルを読むまで少し掛かる)
      if [ "$2" = yes ]; then
        for _ in $(seq 15); do
          if curl -fsS -o /dev/null --resolve denpa.localhost:80:127.0.0.1 "$GENKAN_URL/api/health" 2>/dev/null; then
            url=$GENKAN_URL
            break
          fi
          sleep 2
        done
      fi
      say "立ちました: $url (このマシンからは $URL でも。LAN のほかの機械からは http://$1:3000)"
      [ "$open_browser" = yes ] || return 0
      if [ "$(uname -s)" = Darwin ]; then
        open "$url"
      elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        xdg-open "$url" >/dev/null 2>&1 || true
      fi
      return 0
    fi
    sleep 2
  done
  die "denpa が答えません。cd $DENPA_DIR && docker compose logs を見てください"
}

# ---------------------------------------------------------------------------
# Linux: compose.prod.yml をそのまま置いて起こす
# ---------------------------------------------------------------------------
linux_main() {
  if [ "$uninstall" = yes ]; then
    stop_denpa
    say "止めました。残してあるもの (要らなければ手で消してください):"
    say "  compose と設定 $DENPA_DIR / 録画と DB は docker volume rm denpa_denpa-data denpa_denpa-recorded denpa_denpa-library"
    genkan_left
    return 0
  fi

  case "$(uname -m)" in x86_64 | aarch64 | arm64) ;; *) die "amd64 と arm64 だけです (イメージがありません)" ;; esac
  docker_ready "https://get.docker.com の手順で入れてから、もう一度流してください" \
    "sudo systemctl start docker で起こしてから、もう一度流してください" || exit 1

  ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  ref=$(version)
  start_denpa compose.prod.yml "$ref" "${ip:-$(hostname)}"
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
# compose.mac.yml の TUNER_AGENT_URL と揃える
PORT=25252
LIBUSB=/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib
# 生TSはエージェント (後から解く) とコンテナ (録る) の両方が読み書きするので、Mac のフォルダに置く
MEDIA="$HOME/Movies/denpa"
MAC_DOCKER="Docker Desktop (https://www.docker.com/products/docker-desktop/) か OrbStack (https://orbstack.dev) を入れてから、もう一度流してください"

# 止める。**録画中なら終わるまで待つ** (エージェントが SIGTERM で録画を待ってから畳む。plist の ExitTimeOut)
#
# **消えるまで待つ。** bootout は止まるのに時間の掛かるサービスだと待たずに返る (EINPROGRESS)。
# そのまま入れ替えると、動いているバイナリを差し替えたうえ bootstrap が衝突して、エージェントが居なくなる
mac_stop() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0
  say "動いているエージェントを止めます (録画中なら、終わるまでここで待ちます)"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; do sleep 5; done
}

check() {
  [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$2" ] || die "$1 の中身が合いません (取ってくる途中で壊れたかもしれません。もう一度流してください)"
}
# SHA256SUMS から1行引いて確かめる
check_listed() {
  expected=$(awk -v name="$1" '$2 == name || $2 == "*" name {print $1}' "$2")
  [ -n "$expected" ] || die "$2 に $1 が載っていません"
  check "$1" "$expected"
}

mac_main() {
  if [ "$uninstall" = yes ]; then
    # **録画中なら終わるまで待つ** (コンテナは stop_grace_period、エージェントは ExitTimeOut)
    stop_denpa
    mac_stop
    rm -f "$PLIST"
    rm -rf "$PREFIX" "$RUNTIME"
    say "外しました。残してあるもの (要らなければ手で消してください):"
    say "  compose と設定 $DENPA_DIR / 録画 $MEDIA / ログ $LOG / DB は docker volume rm denpa_denpa-data"
    genkan_left
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
      || die "$ref には Mac 用のエージェントがありません。Mac 用はこのあとのリリースから添えるので、それより前の版では Mac に入れられません"
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
  mkdir -p "$PREFIX" "$DENPA_DIR/config" "$RUNTIME" "$MEDIA/recorded" "$MEDIA/library" "$(dirname "$PLIST")" "$(dirname "$LOG")"
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
    <key>TUNERS_FILE</key><string>$DENPA_DIR/config/tuners.json</string>
    <key>CHANNELS_FILE</key><string>$DENPA_DIR/config/channels.json</string>
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
  launchctl bootstrap "gui/$(id -u)" "$PLIST" \
    || die "LaunchAgent に載せられません。ログを見てください: $LOG (載せ直すなら launchctl bootstrap gui/$(id -u) \"$PLIST\")"

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

  # --- denpa 本体 (Docker)。エージェントと同じ版に。手元の tar.gz を入れたときは main と latest ---
  start_denpa compose.mac.yml "${ref:-main}" "$host"
}

case "$(uname -s)" in
  Linux) linux_main ;;
  Darwin) mac_main ;;
  *) die "Linux と macOS だけです" ;;
esac
