#!/bin/bash
# PR で触ったファイルから、test.yml の重いジョブの中身を回すかを決める。
#
# **絞るのは PR だけ。** main への push と手で回したとき (workflow_dispatch) は全部回す (PR の番号が無いとき)。
# PR で飛ばしたものが壊れていれば、main で気づいて直す。
#
# 必須チェックのジョブ (e2e (n)・agent-windows・agent-windows-install・agent-macos) は飛ばすときも走らせ、
# 中身の段を飛ばして成功で終え、飛ばした理由をジョブの注記に出す (test.yml)。Windows と Mac のジョブは、
# 飛ばすときは ubuntu のランナーで走らせる (Mac と Windows のランナーを待たない)。
# 必須ではないジョブ (tray-macos・agent-android・server-*) は、ジョブごと飛ばす。
#
# 使い方 (GH_TOKEN と GITHUB_REPOSITORY が要る):
#
#   PR=123 .github/ci-changes.sh   # PR の触ったファイルから決める
#   .github/ci-changes.sh          # PR が空なら全部 true
#   .github/ci-changes.sh < files  # FILES=- なら、触ったファイル (1 行に 1 つ) を標準入力から読む (手元で試すとき)
#
# 出力は `名前=true|false` の行 ($GITHUB_OUTPUT にそのまま足せる形)。
#
# | 名前    | 中身を回すジョブ                                                          | true にするファイル                                      |
# | ------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
# | e2e     | e2e (1)〜(6)                                                              | 下の「E2E と関係ないもの」以外の全部                     |
# | windows | agent-windows・agent-windows-install                                      | エージェント・Windows の通知領域のアプリ・install.ps1    |
# | macos   | agent-macos・tray-macos                                                   | エージェント・Mac のメニューバーのアプリ・install.sh     |
# | android | agent-android                                                             | エージェント・Android のアプリ・組んで確かめる部品       |
# | bundle  | server-windows-bundle・server-windows・server-macos-bundle・server-macos | 配布物の組み方・ffmpeg・入れ方・native-smoke が使うもの |
#
# bundle が true なら windows と macos も true にする (配布物を確かめるジョブが、そちらで組んだエージェントを使う)。
# test.yml・このスクリプト・global.json (.NET の SDK の使い方) を触ったときは全部 true。
set -euo pipefail

if [ "${FILES:-}" != - ] && [ -z "${PR:-}" ]; then
  for name in e2e windows macos android bundle; do echo "$name=true"; done
  exit 0
fi

files=$(if [ "${FILES:-}" = - ]; then cat; else gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --jq '.[].filename'; fi)
# この API が返すのは 3000 件まで。それより多い PR は、取りこぼしがありうるので全部回す
if [ "$(printf '%s\n' "$files" | grep -c .)" -ge 3000 ]; then
  for name in e2e windows macos android bundle; do echo "$name=true"; done
  exit 0
fi
e2e=false windows=false macos=false android=false bundle=false
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    .github/workflows/test.yml | .github/ci-changes.sh | global.json)
      e2e=true windows=true macos=true android=true bundle=true
      continue
      ;;
  esac

  # E2E と関係ないもの。E2E はランナーで組んだアプリと偽のエージェント (tests/fake) で流すので、
  # 本物のエージェント・通知領域のアプリ・入れ方・文書・配備には触らない
  case "$f" in
    docs/* | site/* | *.md | agent/* | android/* | tray/* | install.sh | install.ps1 | talos/* | charts/* | deploy/* | \
      scripts/build-wdi-simple.ps1 | tests/install-* | tests/native-* | compose.prod.yml | renovate.json | LICENSE | \
      .github/ISSUE_TEMPLATE/* | .github/FUNDING.yml) ;;
    .github/workflows/*.yml | .github/*.sh | .github/*.c | .github/*.Dockerfile | .github/*.ts) ;;
    *) e2e=true ;;
  esac

  case "$f" in
    agent/*) windows=true macos=true android=true ;;
    tray/Denpa.Tray/* | tray/Denpa.Tray.Tests/* | install.ps1 | scripts/build-wdi-simple.ps1) windows=true ;;
    tray/mac/* | install.sh) macos=true ;;
    android/* | .github/workflows/android.yml | .github/openssl-android.sh | .github/android-agent-smoke.sh | .github/android-app-smoke.sh | \
      .github/fake-usb-broker.c) android=true ;;
  esac

  # 配布物 (windows-server.yml・macos-server.yml) と、それを確かめる server-windows・server-macos が使うもの。
  # アプリ全体の中身は E2E が見ているので、ここでは OS ごとに違う所 (ffmpeg・bun の配布物・入れ方・
  # 電源やプロセスの扱い) と、配布物の形を決めるもの (Dockerfile の native-files 段に入るもの・依存) だけを見る
  case "$f" in
    .github/workflows/windows-server.yml | .github/workflows/macos-server.yml | .github/ffmpeg-windows.sh | .github/ffmpeg-macos.sh | \
      patches/* | Dockerfile | .dockerignore | install.sh | install.ps1 | tests/native-* | tests/install-mac-migrate.sh | \
      package.json | packages/*/package.json | bun.lock | server.js | vite.config.ts | drizzle/* | wasm/* | packages/arib/src/* | \
      src/lib/server/awake.ts | src/lib/server/stream.ts | src/lib/server/uhd.ts | src/lib/server/power.ts | src/lib/server/hwenc.ts | \
      src/lib/server/auth.ts | src/lib/server/address.ts | src/lib/server/compress.ts | src/lib/server/fresh-worker.ts | \
      src/lib/server/hold-signals.ts)
      bundle=true
      ;;
  esac
done <<< "$files"

if [ "$bundle" = true ]; then windows=true macos=true; fi
echo "e2e=$e2e"
echo "windows=$windows"
echo "macos=$macos"
echo "android=$android"
echo "bundle=$bundle"
