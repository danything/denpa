#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# **前のバージョン (Mac で本体を Docker で動かしていた) から移る** install.sh を、偽の docker で流す。
# CI (test.yml の server-macos) が、Mac のランナーで流す (ランナーに Docker は無い)。
#
#   DENPA_AGENT_TARBALL=… DENPA_SERVER_TARBALL=… bash tests/install-mac-migrate.sh <DB のあるフォルダ>
#
# 渡したフォルダを Docker のボリューム denpa_denpa-data の中身として、偽の docker が tar にして渡す。
# 前のバージョンが置いたもの (~/denpa/compose.yml・compose.override.yml、ユーザーの下のエージェントの置き場) も作っておく。
# 確かめること: コンテナを畳んでからボリュームを読み、DB を本体の置き場へ写し、compose.yml を外し、
# 古いエージェントの置き場を消す。compose.override.yml とボリュームには触らない
# ---------------------------------------------------------------------------
set -euo pipefail

volume=$(cd "$1" && pwd)
fake=$(mktemp -d)
log="$fake/docker.log"
# 偽の docker。install.sh は sudo -u <その人> で呼ぶので、環境変数ではなく中に書いて渡す
cat > "$fake/docker" <<EOF
#!/bin/bash
echo "docker \$*" >> '$log'
case "\$1" in
  info) exit 0 ;;
  compose) [ "\$2" = down ] && exit 0 ;;
  run)
    # docker run --rm -v denpa_denpa-data:/d -v <一時フォルダ>:/o alpine tar -C /d -cf /o/data.tar .
    out=
    for arg in "\$@"; do case "\$arg" in *:/o) out=\${arg%:/o} ;; esac; done
    [ -n "\$out" ] && tar -C '$volume' -cf "\$out/data.tar" . && exit 0 ;;
esac
exit 1
EOF
chmod 755 "$fake/docker"

mkdir -p "$HOME/denpa" "$HOME/Library/Application Support/denpa-agent/bin" "$HOME/Library/Caches/denpa-agent"
printf '%s\n' '# install.sh が置いた (版 v2.0.0。手を入れず、足すものは compose.override.yml に)' 'name: denpa' > "$HOME/denpa/compose.yml"
printf 'name: denpa\n' > "$HOME/denpa/.compose.yml.orig"
printf 'services: {}\n' > "$HOME/denpa/compose.override.yml"

sudo -E env PATH="$fake:$PATH" bash install.sh --no-open

cat "$log"
grep -qx 'docker compose down' "$log"
grep -q '^docker run --rm -v denpa_denpa-data:/d ' "$log"
# コンテナを畳んでから読む
[ "$(grep -n 'compose down' "$log" | cut -d: -f1)" -lt "$(grep -n '^docker run' "$log" | cut -d: -f1)" ]
data="/Library/Application Support/denpa/data"
sudo test -f "$data/denpa.db"
test "$(sudo stat -f %Su "$data/denpa.db")" = root
test ! -e "$HOME/denpa/compose.yml"
test ! -e "$HOME/denpa/.compose.yml.orig"
test -f "$HOME/denpa/compose.override.yml"
test ! -e "$HOME/Library/Application Support/denpa-agent"
test ! -e "$HOME/Library/Caches/denpa-agent"
# ボリュームは消さない
if grep -q 'volume rm' "$log"; then exit 1; fi

# 写したあとは、流し直しても docker を呼ばない
: > "$log"
sudo -E env PATH="$fake:$PATH" bash install.sh --no-open
test ! -s "$log"
echo "migrate from Docker: ok"
