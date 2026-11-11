#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# denpa を立てる。**Linux でも Mac でも 1 行で、ブラウザが開くところまで。**
#
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash        Linux
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | sudo bash   Mac (管理者で)
#   … | bash -s -- --no-open      ブラウザを開かない
#   … | bash -s -- --uninstall    止めて外す (録画・DB・設定は残す)
#   … | bash -s -- --agent-only   Mac だけ: エージェントだけ (denpa 本体は別の機械で動かす)
#
# Windows は install.ps1 (同じ作りを PowerShell で。docs/install-windows.md)
#
# **Linux** は全部 Docker Compose (compose.prod.yml をそのまま置く)。
# **Mac (Apple Silicon)** は、denpa 本体もエージェントも Mac の上でそのまま動かす (コンテナは使わない)。本体は配布物の bun と
# ffmpeg (`denpa-<バージョン>-darwin-arm64.tar.gz`)、エージェントは .NET の実行ファイル。どちらも **root の LaunchDaemon** に
# 載せるので、誰もログインしていなくても録画でき、外から観られる。そのために sudo で流す。
#
# **Docker は勝手に入れない** (Linux)。無い・起きていない・触る権限が無いときは、入れ方を案内して止まる。
# もう一度流せば、そのまま上げ直しになる (Linux は pull して up -d、Mac は配布物を取り直して入れ替える)。
# compose ファイルもイメージも**最新のリリースのバージョン**に揃える (取ってきた compose.yml のタグを書き換える)。
#
# **入口は genkan** (Linux。https://github.com/danything/genkan。ホスト名でコンテナに振り分けるリバースプロキシ)。
# 動いていればそれを使い、無ければ 80 と 443 が空いているときだけ ~/genkan に入れて、
# http://denpa.localhost で開けるようにする (登録は compose.override.yml に書く)。
# ポート 3000 は残す。denpa.localhost はそのマシンからしか引けないので、LAN のほかの機械は IP:3000。
#
# 置き場:
#   Linux        ~/denpa (DENPA_HOME で変えられる)    compose.yml (上げ直すたびに上書き)・compose.override.yml
#                                                     (手を入れるならここ。無いときだけ雛形を作り、あれば触らない)・config/・
#                                                     .env (denpa とエージェントが組むときの合言葉 AGENT_PAIR_TOKEN。無いときだけ足す)
#   Mac          /Library/Application Support/denpa/  エージェント (bin/)・本体 (server/。bun・アプリ・ffmpeg・
#                                                     字・デコーダ)・data/ (DB とその隣のもの・denpa.env・
#                                                     本体を起こす denpa.sh。root だけが読み書きできる)
#                /Library/LaunchDaemons/io.github.danything.{denpa,denpa-agent}.plist  起動したら起こし、落ちたら起こし直す
#                /Library/LaunchAgents/io.github.danything.denpa-tray.plist          メニューバーのアプリ (bin/denpa-tray) をログインしたら起こす
#                /Library/Logs/denpa/{denpa,denpa-agent}.log                          ログ
#                ~/denpa/config (DENPA_HOME)          エージェントの tuners.json・channels.json・tls/ (tls/pair-token は組むときの合言葉)
#                ~/Movies/denpa/{recorded,library}    元の TS と出来上がった録画
#   (Mac の ~ は sudo を流した人のホーム)
#
# 前のバージョン (Mac で本体を Docker で、エージェントを LaunchAgent で動かしていた) からは、DB を写して移る (mac_move_from_docker)。
#
# 環境変数: DENPA_VERSION (v1.2.3 のように。既定は最新のリリース。CI はコミットを渡す)、DENPA_HOME、
# DENPA_AGENT_TARBALL・DENPA_SERVER_TARBALL (Mac: 手元でビルドしたエージェント・本体の tar.gz を絶対パスで。CI と開発用)。
# Mac で渡すときは sudo に -E を付ける (sudo は環境変数を落とす)
#
# macOS の bash は 3.2 なので、4 以降の書き方 (連想配列・mapfile など) は使わない。
# ---------------------------------------------------------------------------
set -euo pipefail

REPO=danything/denpa
URL=http://localhost:3000
GENKAN_URL=http://denpa.localhost
DENPA_DIR="${DENPA_HOME:-$HOME/denpa}"
# install.sh が書いた compose.yml の 1 行目 (前のバージョンが書いたものと見分けるので、文言は変えない)。
# Mac では、前のバージョン (本体を Docker で動かしていた) が残っている目印にもなる
MARK="# install.sh が置いた (版"

open_browser=yes uninstall=no agent_only=no
for arg in "$@"; do
  case "$arg" in
    --no-open) open_browser=no ;;
    --uninstall) uninstall=yes ;;
    --agent-only) agent_only=yes ;;
    *) echo "知らない引数: $arg (--no-open / --uninstall / --agent-only)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mエラー:\033[0m %s\n' "$*" >&2; exit 1; }
# 時間の上限を付ける。繋がったまま止まる相手 (落ちかけのサイト) だと、付けなければいつまでも待つ。
# 時間切れも --retry が試し直す
CURL_LIMITS=(--connect-timeout 20 --max-time 300)
fetch() { curl -fsSL --retry 3 "${CURL_LIMITS[@]}" -o "$2" "$1" || die "ダウンロードできません: $1"; }

# 入れるバージョン。compose ファイルはこのバージョン (git の ref) から取り、イメージは x.y.z の形式のときだけそのバージョンに
# 揃える (コミットやブランチなら latest)。API を使わず、latest の転送先からタグを読む (API は回数制限がある)
version() {
  if [ -n "${DENPA_VERSION:-}" ]; then echo "$DENPA_VERSION"; return; fi
  tag=$(curl -fsSLI --connect-timeout 20 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
    || die "最新のリリースが分かりません"
  echo "${tag##*/}"
}
image_tag() { printf '%s' "${1#v}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && echo "${1#v}" || echo latest; }

# Docker が使えるか (Linux)。駄目なら理由と入れ方を言って 1 を返す (止めるかは呼ぶ側)
docker_ready() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    say "Docker (compose) が見当たりません。$1"
    return 1
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  if [ "$(id -u)" != 0 ] && ! id -nG | grep -qw docker; then
    say "Docker に触る権限がありません。sudo usermod -aG docker $(id -un) のあとログインし直して、もう一度流してください"
  else
    say "Docker が動いていません。$2"
  fi
  return 1
}

# genkan が入っているか。**genkan ネットワークがあれば入っている** (genkan だけが作る名前。止まっていても
# 残る)。止めてあるものは起こし直さない。意図して止めた人の genkan を上げ直すたびに復活させたり、
# 別の場所に入れた genkan の横にもう 1 つ clone したりしない
genkan_installed() { docker network inspect genkan >/dev/null 2>&1; }
# 動いているか (genkan ネットワークに Caddy がいるか)
genkan_running() {
  genkan_installed && docker ps --filter network=genkan --format '{{.Image}}' | grep -q caddy-docker-proxy
}
# そのポートで誰かが待ち受けているか。bash の /dev/tcp で繋いでみる (ss / lsof の違いを気にしない)
port_used() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# genkan を使えるようにする。使えれば 0。**80 か 443 が埋まっていれば入れない** (誰かのものを奪わない)
ensure_genkan() {
  genkan_running && return 0
  if genkan_installed; then
    say "genkan は入っていますが止まっています (起動すれば http://denpa.localhost で開けます)"
    return 1
  fi
  if port_used 80 || port_used 443; then
    say "80 か 443 が使われているので genkan は入れません (ポート 3000 で開きます)"
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    say "git が無いので genkan は入れません (ポート 3000 で開きます)"
    return 1
  fi
  say "genkan を $HOME/genkan に入れます (http://denpa.localhost で開けるように)"
  # **イメージの取得は、レジストリが一時的に断ることがある** (回数の上限。CI で実際に落ちた)。init.sh は
  # 何度流しても同じ結果になる (clone 済みなら pull して compose up) ので、間を空けて 3 回まで流し直す
  local try
  for try in 1 2 3; do
    if (cd "$HOME" && curl -fsSL "${CURL_LIMITS[@]}" https://raw.githubusercontent.com/danything/genkan/main/init.sh | sh -s); then
      genkan_running
      return
    fi
    if [ "$try" -lt 3 ]; then
      say "genkan を入れられませんでした。$((try * 10)) 秒後に試し直します"
      sleep $((try * 10))
    fi
  done
  say "genkan を入れられませんでした (ポート 3000 で開きます)"
  return 1
}

# genkan に denpa を登録する断片。**http:// を付けるので HTTPS にせず、証明書の信頼も要らない**
# (*.localhost はブラウザが安全な文脈として扱う)。
#
# **私設網の外から来たものは genkan で断る。** denpa から見た送り主は genkan のコンテナ (私設網) に
# なるので、TRUSTED_NETWORKS では外と内を見分けられない。ほかのアプリのために 80 番を外へ開けて
# いると、Host を偽るだけでインターネットから素通りになる
genkan_override() {
  printf '%s\n' 'services:' '  denpa:' '    labels:' \
    '      caddy: http://denpa.localhost' \
    '      caddy.@outside: not remote_ip private_ranges' \
    '      caddy.respond: "@outside 403"' \
    '      caddy.reverse_proxy: "{{upstreams 3000}}"'
  genkan_env
  printf '%s\n' '    networks: [default, genkan]' '' 'networks:' '  genkan:' '    external: true'
}

# **genkan を前段として認める** (denpa の environment の断片)。genkan のネットワークを TRUSTED_PROXIES に書き、
# genkan が付ける X-Forwarded-For から本当の接続元を読ませる。このマシンのブラウザ (http://denpa.localhost) は
# そのネットワークのゲートウェイ (このマシン自身) から来たように見えるので、TRUSTED_NETWORKS にはそこだけ足す。
# genkan のネットワークごと信頼すると、genkan 越しの人が全員当たってしまう (docs/auth.md)。
# ネットワークの範囲は Docker が決めるので、ここで調べて書く。読めなければ何も書かず、画面にそう出す
genkan_env() {
  net=$(docker network inspect genkan -f '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{println}}{{end}}' 2>/dev/null \
    | grep -m1 '^[0-9.]*/[0-9]* [0-9.]*$' || true)
  if [ -z "$net" ]; then
    say "genkan のネットワークの範囲が読めず、TRUSTED_PROXIES を書けませんでした。genkan 越しに入れなければ docs/auth.md を見て compose.override.yml に足してください" >&2
    return 0
  fi
  printf '%s\n' '    environment:' \
    '      # genkan を前段として認める。このマシンのブラウザは genkan のゲートウェイから来たように見える (docs/auth.md)' \
    "      TRUSTED_PROXIES: ${net% *}" \
    "      TRUSTED_NETWORKS: 192.168.0.0/16,10.0.0.0/8,${net#* }"
}

# denpa とエージェントが組むときの合言葉 (32 バイトの乱数を base64url で。docs/agent.md) を $pair に。
# ~/denpa/.env に**一度だけ**作り、上げ直しても変えない。compose.prod.yml がそこから読む (Linux。Mac は mac_pair_token)。
# .env がもうあれば (手で書いた人もいる) 行を足すだけで、ほかの行には触らない
pair_token() {
  envfile="$DENPA_DIR/.env"
  pair=""
  if [ -f "$envfile" ]; then pair=$(sed -n 's/^AGENT_PAIR_TOKEN=//p' "$envfile" | tail -n 1 | tr -d '\r'); fi
  [ -z "$pair" ] || return 0
  pair=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  mkdir -p "$DENPA_DIR"
  # 新しく作るときは本人だけが読めるように (あるファイルの権限は変えない)。
  # 最後が改行で終わっていなければ、前の行にくっつかないように改行を足してから
  (
    umask 077
    if [ -s "$envfile" ] && [ -n "$(tail -c 1 "$envfile")" ]; then echo >> "$envfile"; fi
    echo "AGENT_PAIR_TOKEN=$pair" >> "$envfile"
  )
}

# ~/denpa で docker compose。-f を付けないので compose.yml と compose.override.yml を Compose が自分で重ねる
compose() { (cd "$DENPA_DIR" && docker compose "$@"); }

# 取ってきた compose ($1。compose.prod.yml) を ~/denpa/compose.yml に置いて起こす (Linux)。
# **バージョンはタグで揃える。** 取ってきたものの latest をこのバージョンに書き換える (.env は使わない)
start_denpa() {
  say "denpa $2 を $DENPA_DIR に置きます"
  mkdir -p "$DENPA_DIR/config"
  curl -fsSL --retry 3 "${CURL_LIMITS[@]}" -o "$DENPA_DIR/compose.yml.new" "https://raw.githubusercontent.com/$REPO/$2/$1" \
    || die "$2 に $1 がありません"
  # 手で置いたもの・手を入れたものは黙って上書きせず、compose.yml.bak に退けてそう言う。
  # install.sh が書いたものは 1 行目が印で、残りは前に書いた控え (.compose.yml.orig) と同じはず
  if [ -f "$DENPA_DIR/compose.yml" ] && ! { head -1 "$DENPA_DIR/compose.yml" | grep -q "^$MARK" \
    && tail -n +2 "$DENPA_DIR/compose.yml" | cmp -s - "$DENPA_DIR/.compose.yml.orig"; }; then
    mv "$DENPA_DIR/compose.yml" "$DENPA_DIR/compose.yml.bak"
    say "手を入れた $DENPA_DIR/compose.yml を compose.yml.bak に退避しました。変更は compose.override.yml に移してください"
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
      echo "# 手元で足したい・変えたいものはここに書く。compose.yml は install.sh が更新のたびに"
      echo "# 上書きするが、このファイルには触らない (Compose が compose.yml に重ねて読む)。"
      echo "# たとえば denpa の environment に TRUSTED_NETWORKS: 192.168.1.0/24 を足すなど"
      if [ "$genkan" = yes ]; then
        echo "#"
        echo "# genkan (http://denpa.localhost) への登録は install.sh が書いた"
        genkan_override
      else
        echo "services: {}"
      fi
    } > "$override"
  elif ! grep -q 'denpa.localhost' "$override" && genkan_running; then
    say "compose.override.yml には触りません。genkan の http://denpa.localhost で開くなら、次を足して流し直してください:"
    genkan_override
  elif grep -q 'denpa.localhost' "$override" && ! grep -q 'TRUSTED_PROXIES' "$override" && genkan_running; then
    # 前のバージョンが書いた登録。既定の TRUSTED_NETWORKS から Docker のネットワーク (172.16.0.0/12) を外したので、
    # このままでは genkan 越しに入れない
    say "compose.override.yml には触りません。genkan の http://denpa.localhost で開くには、denpa: の下に次を足して流し直してください:"
    genkan_env
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
    if curl -fsS --max-time 5 -o /dev/null "$URL/api/health" 2>/dev/null; then
      url=$URL
      # Linux の Docker は localhost への接続を中継し、送信元が Docker のゲートウェイに見える (既定の
      # TRUSTED_NETWORKS に入らない)。このマシンのブラウザでも LAN の IP で開く
      if printf '%s' "$1" | grep -Eq '^[0-9.]+$'; then url="http://$1:3000"; fi
      # genkan 越しにも答えれば、そちらを開く (Caddy がラベルを読むまで少し掛かる)
      if [ "$2" = yes ]; then
        for _ in $(seq 15); do
          if curl -fsS --max-time 5 -o /dev/null --resolve denpa.localhost:80:127.0.0.1 "$GENKAN_URL/api/health" 2>/dev/null; then
            url=$GENKAN_URL
            break
          fi
          sleep 2
        done
      fi
      say "起動しました: $url (LAN のほかの機器からは http://$1:3000)"
      [ "$open_browser" = yes ] || return 0
      if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        xdg-open "$url" >/dev/null 2>&1 || true
      fi
      return 0
    fi
    sleep 2
  done
  die "denpa が応答しません。cd $DENPA_DIR && docker compose logs を見てください"
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

  [ "$agent_only" = no ] || die "--agent-only は Mac だけです (Linux はエージェントだけのイメージ denpa-agent を使う。docs/agent.md)"
  case "$(uname -m)" in x86_64 | aarch64 | arm64) ;; *) die "対応しているのは amd64 と arm64 だけです (ほかのイメージはありません)" ;; esac
  docker_ready "https://get.docker.com の手順で入れてから、もう一度流してください" \
    "sudo systemctl start docker で起こしてから、もう一度流してください" || exit 1

  # LAN の IP は外へ出る経路の送信元から取る (hostname -I の先頭は docker0 の 172.17.0.1 のこともある)
  ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  ref=$(version)
  pair_token
  start_denpa compose.prod.yml "$ref" "${ip:-$(hostname)}"
}

# ---------------------------------------------------------------------------
# Mac: denpa 本体もエージェントも root の LaunchDaemon
# ---------------------------------------------------------------------------
LABEL=io.github.danything.denpa-agent
SERVER_LABEL=io.github.danything.denpa
PREFIX="/Library/Application Support/denpa"
# DB・denpa.env・本体を起こす denpa.sh (合言葉が入る)。root だけが読み書きできる
DATA="$PREFIX/data"
AGENT_PLIST="/Library/LaunchDaemons/$LABEL.plist"
SERVER_PLIST="/Library/LaunchDaemons/$SERVER_LABEL.plist"
# メニューバーのアプリ (tray/mac)。エージェントと同じ tar.gz に入っていて、ログインしたら /Library/LaunchAgents から起きる
TRAY_LABEL=io.github.danything.denpa-tray
TRAY_PLIST="/Library/LaunchAgents/$TRAY_LABEL.plist"
LOGS=/Library/Logs/denpa
PORT=25252

# 止める。**録画中なら終わるまで待つ** (本体もエージェントも SIGTERM で録画を待ってから畳む。plist の ExitTimeOut)。
# $1 は launchctl のドメインとラベル (system/… か gui/<uid>/…)
#
# **消えるまで待つ。** bootout は止まるのに時間の掛かるサービスだと待たずに返る (EINPROGRESS)。
# そのまま入れ替えると、動いているバイナリを差し替えたうえ bootstrap が衝突して、いなくなる
mac_stop() {
  launchctl print "$1" >/dev/null 2>&1 || return 0
  say "動いている ${1##*/} を止めます (録画中なら、終わるまでここで待ちます)"
  launchctl bootout "$1" 2>/dev/null || true
  while launchctl print "$1" >/dev/null 2>&1; do sleep 5; done
}

check() {
  [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$2" ] || die "$1 のハッシュが合いません (ダウンロード中に壊れた可能性があります。もう一度流してください)"
}

# sudo を流した人として (Docker と、その人のフォルダを作るとき)。PATH はそのまま渡す (OrbStack の docker は ~/.orbstack/bin にもある)
as_user() { sudo -u "$USER_NAME" -H env PATH="$PATH" "$@"; }

# sh の一重引用符で囲む (denpa.sh に置き場を書くため。"Application Support" に空白がある)
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# denpa とエージェントが組むときの合言葉 (32 バイトの乱数を base64url で。docs/agent.md) を $pair に。
# **エージェント自身の置き場** (tuners.json の隣の tls/pair-token) に**一度だけ**作り、上げ直しても変えない。
# エージェントには環境変数で渡さず、そこから読ませる (手で denpa-agent --pair を流しても同じ URL が出るように)。
# denpa には TUNER_AGENT_URL の #pair= で同じものを渡す。前のバージョン (本体が Docker) が作ったものもそこにある
mac_pair_token() {
  file="$DENPA_DIR/config/tls/pair-token"
  pair=""
  if [ -s "$file" ]; then pair=$(tr -d '\r\n' < "$file"); fi
  [ -z "$pair" ] || return 0
  pair=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  mkdir -p "$(dirname "$file")"
  (umask 077 && printf '%s' "$pair" > "$file.new" && mv "$file.new" "$file")
  chown "$USER_NAME" "$file"
}

# 前のバージョン (本体が Docker) の compose.yml が残っているか (1 行目が install.sh の印)
docker_era() { [ -f "$DENPA_DIR/compose.yml" ] && head -1 "$DENPA_DIR/compose.yml" | grep -q "^$MARK"; }

# **前のバージョンは Mac で denpa 本体を Docker (Docker Desktop / OrbStack) で動かしていた** (~/denpa/compose.yml の 1 行目が印)。
# コンテナを畳み (録画中なら stop_grace_period で終わるまで待つ)、DB の入ったボリュームの中身を $DATA へ写し、
# compose.yml を外す。ボリュームは消さずに残す。録画は同じ ~/Movies/denpa にあるので動かさない。
# 古いエージェント (LaunchAgent) が動いている間に呼ぶ (コンテナの録画はそれを使う)。
# 途中で止まっても、流し直せば続きから (写した DB があれば写し直さない)
mac_move_from_docker() {
  docker_era || return 0
  as_user docker info >/dev/null 2>&1 || die "前のバージョンの DB が Docker のボリューム denpa_denpa-data にあります。写すので、Docker Desktop か OrbStack を起こしてから流し直してください (写したあとは Docker は要りません。ボリュームがもう無く、新しく始めるなら $DENPA_DIR/compose.yml を消してから流し直します)"
  say "Docker の denpa を止めます (録画中なら終わるまで待ちます)"
  (cd "$DENPA_DIR" && as_user docker compose down) || die "Docker の denpa を止められません (cd $DENPA_DIR && docker compose down)"
  db="$DATA/denpa.db"
  if [ ! -f "$db" ]; then
    say "DB を Docker のボリューム denpa_denpa-data から $DATA へ写します"
    # 一時フォルダは /tmp の下に (Docker Desktop が既定でコンテナに見せるフォルダ)
    move=$(as_user mktemp -d)
    as_user docker run --rm -v denpa_denpa-data:/d -v "$move:/o" alpine tar -C /d -cf /o/data.tar . \
      || die "Docker のボリューム denpa_denpa-data を読めません"
    mac_data_dir
    # 持ち主はコンテナの中の番号のまま写さず、root にする (-o)
    tar -xof "$move/data.tar" -C "$DATA" || die "$DATA に書けません"
    rm -rf "$move"
    [ -f "$db" ] || die "Docker のボリューム denpa_denpa-data に denpa.db がありません"
  fi
  rm -f "$DENPA_DIR/compose.yml" "$DENPA_DIR/.compose.yml.orig"
  say "移しました。Docker のボリューム denpa_denpa-data は残してあります (要らなければ docker volume rm denpa_denpa-data)"
  if [ -f "$DENPA_DIR/compose.override.yml" ]; then
    say "$DENPA_DIR/compose.override.yml は読みません。environment に書き足したものがあれば、$DATA/denpa.env に KEY=値 の形で書き直してください (sudo で)"
  fi
}

# 前のバージョンのエージェント (ログインしたら起こす LaunchAgent と、ユーザーの下の置き場)。止めて外す
mac_remove_launch_agent() {
  mac_stop "gui/$USER_ID/$LABEL"
  rm -f "$USER_HOME/Library/LaunchAgents/$LABEL.plist"
  rm -rf "$USER_HOME/Library/Application Support/denpa-agent" "$USER_HOME/Library/Caches/denpa-agent"
}

# メニューバーのアプリを止める (bin/ を入れ替える前と、外すとき)。sudo を流した人のものは launchd から外し、
# ほかの人がログインして動かしているものは終わらせる (次のログインで新しいものが起きる)。録画には関わらないので待たない
mac_stop_tray() {
  launchctl bootout "gui/$USER_ID/$TRAY_LABEL" 2>/dev/null || true
  pkill -f "$PREFIX/bin/denpa-tray" 2>/dev/null || true
}

# メニューバーのアプリ (denpa-tray)。**ログインしたら起きる**ように /Library/LaunchAgents に載せる (誰がログインしても出る)。
# 出すのは本体の様子と新しいバージョンで、更新はメニューから人が選んだときにこの install.sh を Terminal で流す (docs/install-mac.md)。
# KeepAlive は付けない (メニューの「終了」で終えたら、次のログインまで出さない)。
# sudo を流した人がログインしていれば (gui のドメインがあれば) ここで起こす。無ければ次のログインを待つ。
# tar.gz に入っていなければ (手元で組んだ DENPA_AGENT_TARBALL など) 載せず、前に載せたものも消す
# (残すと、ログインのたびに launchd が無い実行ファイルを起こそうとする)
mac_register_tray() {
  if [ ! -x "$PREFIX/bin/denpa-tray" ]; then
    rm -f "$TRAY_PLIST"
    return 0
  fi
  mkdir -p /Library/LaunchAgents
  cat > "$TRAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TRAY_LABEL</string>
  <key>ProgramArguments</key><array><string>$PREFIX/bin/denpa-tray</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
  chown root:wheel "$TRAY_PLIST"
  chmod 644 "$TRAY_PLIST"
  plutil -lint "$TRAY_PLIST" >/dev/null
  if launchctl print "gui/$USER_ID" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$USER_ID" "$TRAY_PLIST" 2>/dev/null \
      || say "メニューバーのアプリを起こせませんでした。次のログインで起きます"
  fi
}

# 本体の置き場 ($DATA)。DB・鍵・denpa.env・合言葉の入る denpa.sh があるので、root だけにする
mac_data_dir() {
  mkdir -p "$DATA"
  chown root:wheel "$DATA"
  chmod 700 "$DATA"
}

# LaunchDaemon に載せる (plist は root のもので、ほかの人が書けないこと。launchd がそうでないものを断る)
mac_bootstrap() {
  chown root:wheel "$1"
  chmod 644 "$1"
  plutil -lint "$1" >/dev/null
  launchctl bootstrap system "$1" || die "LaunchDaemon に載せられません。ログを見てください: $2 (載せ直すなら sudo launchctl bootstrap system \"$1\")"
}

# エージェントの plist と起こすところ。環境変数はコンテナで既定にしている置き場を Mac の置き場に向け直すものだけ
# (合言葉は環境変数で渡さず、エージェントが tls/pair-token から読む。mac_pair_token)。
#
# ExitTimeOut はエージェントが録画を待つ上限 (SHUTDOWN_WAIT の既定 6 時間) より長く。
# 短いと、止めたときに録画の途中で SIGKILL される (既定は 20 秒)。
# ProcessType Interactive は、裏のジョブとして CPU や I/O を絞られないように (TS を流し続けるので)。
#
# denpa 本体も同じ Mac で動かすなら、ループバックでだけ待ち受ける (ほかの機械から繋ぐ相手はいない)。
# エージェントだけ入れるとき (--agent-only) は別の機械の denpa から繋ぐので、全部のインターフェースのまま。
# どちらでも、答えるのは合言葉で組んだ denpa だけ (docs/agent.md)
mac_register_agent() {
  agent_host=""
  if [ "$agent_only" = no ]; then
    agent_host="    <key>AGENT_HOST</key><string>127.0.0.1</string>"
  fi
  cat > "$AGENT_PLIST" <<EOF
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
  <key>StandardOutPath</key><string>$LOGS/denpa-agent.log</string>
  <key>StandardErrorPath</key><string>$LOGS/denpa-agent.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_PORT</key><string>$PORT</string>
$agent_host
    <key>TUNERS_FILE</key><string>$DENPA_DIR/config/tuners.json</string>
    <key>CHANNELS_FILE</key><string>$DENPA_DIR/config/channels.json</string>
    <key>RAW_DIR</key><string>$MEDIA/recorded</string>
  </dict>
</dict>
</plist>
EOF
  mac_bootstrap "$AGENT_PLIST" "$LOGS/denpa-agent.log"

  # API は組んだ denpa (クライアント証明書) にしか答えないので、denpa-agent --status に聞かせる
  # (エージェント自身の証明書で呼ぶ。置き場とポートは plist と同じものを渡す)
  say "エージェントを起動しました。応答を待ちます"
  for _ in $(seq 15); do
    if tuners=$(AGENT_PORT="$PORT" TUNERS_FILE="$DENPA_DIR/config/tuners.json" "$PREFIX/bin/denpa-agent" --status 2>/dev/null); then
      echo "$tuners"
      return 0
    fi
    sleep 2
  done
  die "エージェントが応答しません。ログを見てください: $LOGS/denpa-agent.log"
}

# denpa 本体を起こす denpa.sh と plist。**置き場・ffmpeg・エージェントの宛先はここで決め、denpa.env より勝たせる**
# (denpa.env は手で直すところで、そこに書いても root で動かすものは変えられない)。denpa.env は起こすたびに読み直す。
# エージェントは同じ Mac なので 127.0.0.1 で繋ぐ (denpa は組んだときの証明書そのもので確かめるので、名前は見ない)。
# 合言葉 (TUNER_AGENT_URL の #pair=) が入るので、denpa.sh は root だけが読める $DATA に置く
# (/Library/LaunchDaemons の plist はだれでも読める)。
#
# **Umask 002 で動かす。** 録画は sudo を流した人の ~/Movies/denpa に置く。macOS では新しいファイルが
# 置いたフォルダのグループ (staff) を継ぐので、root が書いた録画もその人が Finder から消したり動かしたりできる
# (~/Movies はその人しか開けないので、ほかの人からは見えない)
mac_register_server() {
  mac_data_dir
  env_file="$DATA/denpa.env"
  if [ ! -f "$env_file" ]; then
    printf '%s\n' \
      '# denpa 本体の環境変数 (docs/config.md)。install.sh は無いときだけ作り、あとは触らない。' \
      '# 直したら、install.sh を流し直すか Mac を再起動する。置き場・ffmpeg・エージェントの宛先は install.sh が決めるので、書いても効かない' \
      'TZ=Asia/Tokyo' \
      'ENCODE_CONCURRENCY=2' \
      '# 誰を通すか (docs/auth.md)。127.0.0.0/8 と ::1 はこの Mac のブラウザ' \
      'TRUSTED_NETWORKS=127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8' > "$env_file"
    chmod 600 "$env_file"
  fi
  version=${1#v}
  if printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then version="v$version"; else version=dev; fi
  server="$PREFIX/server"
  # 一重引用符の中の $ は denpa.sh が展開する (ここでは展開しない)
  # shellcheck disable=SC2016
  {
    echo '#!/bin/sh'
    echo '# Written by install.sh (denpa). Re-run the installer instead of editing this file.'
    echo "env_file=$(quote "$env_file")"
    # 1 行ずつ KEY=値 として読む (sh として読まない。値の空白や記号をそのまま渡す)
    echo 'if [ -f "$env_file" ]; then'
    echo '  while IFS= read -r line || [ -n "$line" ]; do'
    echo '    case "$line" in "" | "#"*) continue ;; *=*) export "${line%%=*}=${line#*=}" ;; esac'
    echo '  done < "$env_file"'
    echo 'fi'
    for kv in \
      "NODE_ENV=production" \
      "DENPA_VERSION=$version" \
      "DENPA_DB=$DATA/denpa.db" \
      "RAW_DIR=$MEDIA/recorded" \
      "ENCODED_DIR=$MEDIA/library" \
      "FFMPEG=$server/ffmpeg/ffmpeg" \
      "FFPROBE=$server/ffmpeg/ffprobe" \
      "MPEG2_DIR=$server/mpeg2" \
      "FONT_DIR=$server/font" \
      "TUNER_AGENT_URL=https://127.0.0.1:$PORT#pair=$pair" \
      "PORT=3000" \
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"; do
      echo "export ${kv%%=*}=$(quote "${kv#*=}")"
    done
    echo "cd $(quote "$server/app") || exit 1"
    echo "exec $(quote "$server/bun") server.js"
  } > "$DATA/denpa.sh"
  chmod 700 "$DATA/denpa.sh"
  cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$DATA/denpa.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>22200</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>Umask</key><integer>2</integer>
  <key>StandardOutPath</key><string>$LOGS/denpa.log</string>
  <key>StandardErrorPath</key><string>$LOGS/denpa.log</string>
</dict>
</plist>
EOF
  mac_bootstrap "$SERVER_PLIST" "$LOGS/denpa.log"

  say "denpa の応答を待ちます"
  for _ in $(seq 90); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:3000/api/health" 2>/dev/null; then
      host="$(scutil --get LocalHostName 2>/dev/null || hostname).local"
      say "起動しました: $URL (LAN のほかの機器からは http://$host:3000)"
      return 0
    fi
    sleep 2
  done
  die "denpa が応答しません。ログを見てください: $LOGS/denpa.log"
}

# 置くものを $work/new に揃える。エージェント (bin) と、--agent-only でなければ本体 (server)。
# $1 (バージョン) が空なら手元の tar.gz (DENPA_AGENT_TARBALL・DENPA_SERVER_TARBALL)
mac_payload() {
  # --- エージェント本体 (GitHub のリリース) -------------------------------
  agent="${DENPA_AGENT_TARBALL:-}"
  if [ -n "$1" ]; then
    agent="denpa-agent-${1#v}-darwin-arm64.tar.gz"
    say "denpa-agent $1"
    curl -fsSL --retry 3 "${CURL_LIMITS[@]}" -o "$agent" "https://github.com/$REPO/releases/download/$1/$agent" \
      || die "$1 には Mac 用のエージェントがありません。Mac 用は v1.23.0 からなので、それより前のバージョンは Mac に入れられません"
    fetch "https://github.com/$REPO/releases/download/$1/$agent.sha256" "$agent.sha256"
    check "$agent" "$(awk '{print $1}' "$agent.sha256")"
  fi
  mkdir -p new/bin && tar -xzf "$agent" -C new/bin

  # --- denpa 本体 (bun・アプリ・ffmpeg・字・デコーダ)。エージェントと同じバージョン ---
  # 本体のバージョン (denpa.sh の DENPA_VERSION)。手元の tar.gz なら空 (dev)
  server_version=""
  if [ "$agent_only" = no ]; then
    server="${DENPA_SERVER_TARBALL:-}"
    if [ -z "$server" ]; then
      v=${1:-$(version)}
      server_version=$v
      server="denpa-${v#v}-darwin-arm64.tar.gz"
      say "denpa $v"
      curl -fsSL --retry 3 "${CURL_LIMITS[@]}" -o "$server" "https://github.com/$REPO/releases/download/$v/$server" \
        || die "$v には Mac でそのまま動かす denpa 本体がありません。新しいバージョンを入れてください"
      fetch "https://github.com/$REPO/releases/download/$v/$server.sha256" "$server.sha256"
      check "$server" "$(awk '{print $1}' "$server.sha256")"
    fi
    mkdir -p new/server && tar -xzf "$server" -C new/server
    for f in bun app/server.js ffmpeg/ffmpeg; do
      [ -f "new/server/$f" ] || die "denpa 本体の tar.gz に $f が入っていません"
    done
  fi
  # ブラウザで落とした tar.gz を手で渡されたときの「インターネットから来た」印を外す (Gatekeeper に止められないように)
  xattr -dr com.apple.quarantine new 2>/dev/null || true
}

mac_main() {
  [ "$(id -u)" = 0 ] || die "Mac は管理者で流してください: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sudo bash (denpa とエージェントを、ログインしなくても動く LaunchDaemon に載せるためです)"
  # sudo を流した人。録画とエージェントの設定はその人のホームに置く
  USER_NAME=${SUDO_USER:-}
  if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then USER_NAME=$(stat -f %Su /dev/console); fi
  if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then die "誰のホームに置くか分かりません。ログインしているユーザーから sudo で流してください"; fi
  USER_ID=$(id -u "$USER_NAME")
  USER_HOME=$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')
  [ -d "$USER_HOME" ] || die "$USER_NAME のホームが見つかりません"
  DENPA_DIR="${DENPA_HOME:-$USER_HOME/denpa}"
  MEDIA="$USER_HOME/Movies/denpa"

  if [ "$uninstall" = yes ]; then
    # **録画中なら終わるまで待つ** (本体・エージェントは ExitTimeOut、前のバージョンのコンテナは stop_grace_period)
    if docker_era && as_user docker info >/dev/null 2>&1; then
      (cd "$DENPA_DIR" && as_user docker compose down) || true
      say "前のバージョンの DB は Docker のボリュームに残してあります (要らなければ docker volume rm denpa_denpa-data)"
    fi
    # 本体が先 (録画はエージェントを使う)。本体は止まるときに、録画の前に起こす予約を取り消す (power.ts の forgetWake)
    mac_stop "system/$SERVER_LABEL"
    mac_stop "system/$LABEL"
    mac_remove_launch_agent
    mac_stop_tray
    rm -f "$SERVER_PLIST" "$AGENT_PLIST" "$TRAY_PLIST" "$DATA/denpa.sh" "$DATA/wake-at"
    for part in bin px4-userland siano-userland server run; do rm -rf "${PREFIX:?}/$part"; done
    say "外しました。残してあるもの (要らなければ手で消してください):"
    say "  DB と denpa.env $DATA / エージェントの設定 $DENPA_DIR / 録画 $MEDIA / ログ $LOGS"
    return 0
  fi

  [ "$(uname -m)" = arm64 ] || die "対応しているのは Apple Silicon (arm64) の Mac だけです (エージェントの配布物が arm64 用だけです)"

  # 作業場所は /tmp の下に、その人も入れるように作る (sudo -u で docker を呼ぶとき、今いる場所を読めないと sh が警告を出す)
  work=$(mktemp -d /tmp/denpa-install.XXXXXX)
  chmod 755 "$work"
  trap 'rm -rf "$work"' EXIT
  cd "$work"

  ref=""
  [ -n "${DENPA_AGENT_TARBALL:-}" ] || ref=$(version)
  mac_payload "$ref"
  # 前のバージョン (本体が Docker) の本体を止めて DB を写す。古いエージェントが動いている間に (コンテナの録画を待つ)
  [ "$agent_only" = yes ] || mac_move_from_docker

  # --- 入れ替える。**揃ってから止める** (取ってこられなかったら、動いているものに触らない) ---
  # 本体が先 (録画はエージェントを使う)
  mac_stop "system/$SERVER_LABEL"
  mac_stop "system/$LABEL"
  mac_remove_launch_agent
  # メニューバーのアプリも bin/ にある (更新をメニューから始めたときは、それがまだ動いている)
  mac_stop_tray
  mkdir -p "$PREFIX" "$LOGS"
  chown root:wheel "$PREFIX"
  chmod 755 "$PREFIX"
  parts="bin"
  [ "$agent_only" = yes ] || parts="$parts server"
  for part in $parts; do
    rm -rf "${PREFIX:?}/$part"
    mv "new/$part" "$PREFIX/$part"
    chown -R root:wheel "$PREFIX/$part"
  done
  # 前のバージョンが置いていた siano-userland・px4-userland と px4d のソケットの置き場 (run/)。
  # いまは Siano と IT930x の機材をエージェントが USB で直に動かすので要らない
  rm -rf "${PREFIX:?}/siano-userland" "${PREFIX:?}/px4-userland" "${PREFIX:?}/run"
  # その人のフォルダは、その人のものとして作る
  as_user mkdir -p "$DENPA_DIR/config" "$MEDIA/recorded" "$MEDIA/library"

  # エージェントを起こす前に置いておく (無ければエージェントが自分で作り、そちらと食い違わないように)
  mac_pair_token
  mac_register_agent

  host="$(scutil --get LocalHostName 2>/dev/null || hostname).local"
  if [ "$agent_only" = yes ]; then
    say "エージェントだけ入れました。denpa の TUNER_AGENT_URL に次を書いてください (#pair= の後ろは合言葉。人に見せない):"
    say "  https://$host:$PORT#pair=$pair"
    return 0
  fi
  mac_register_server "$server_version"
  mac_register_tray
  # sudo の中から開くとブラウザまで root で動くので、その人として開く
  if [ "$open_browser" = yes ]; then launchctl asuser "$USER_ID" sudo -u "$USER_NAME" open "$URL" || true; fi
}

case "$(uname -s)" in
  Linux) linux_main ;;
  Darwin) mac_main ;;
  *) die "対応しているのは Linux と macOS だけです" ;;
esac
