#!/bin/sh
# main へ「印/版を書き戻す」PR を出して、自分でマージする。
#
# **main へは直接 push しない。** main は必須チェック (`check`) で守ってあり、手元から
# push できないのと同じで、bot のトークンも素通しにはならない (GITHUB_TOKEN は保護の
# bypass に入れられない仕様)。
#
# そこで、**書き換えた PR を出して、自分でマージする。** PR は GITHUB_TOKEN で開くので、
# GitHub はそこから workflow を1つも動かさない (これも仕様) — 放っておくと必須チェックが
# 永遠に付かず、PR が塞がったままになる。書き換えるのは印/版だけで、指す先のイメージや
# chart は呼び出した run が出したものなので、**確かめるものは残っていない**。必須チェックの
# status はここから付ける (保護は context を GitHub Actions app に固定してあるので、
# この token で付けないと数えられない)。
#
# **付ける context は ruleset から引く。** `check` 1つを決め打ちにしていた頃、ruleset に
# `agent` / `e2e (1)`〜`(4)` / `claude-review` が足された途端に bump の PR が
# 「Expected」のまま塞がった (#99、2026-09-11)。ruleset で足したものにここが自動で
# 追いつくようにする。引けなければ `check` だけ (以前の形) に落ちる。
#
# **2つのワークフローが同じ手を要る** (build-and-deploy の k3s の印と、release の
# Chart.yaml の版)。書き写すと片方だけ直したときに食い違うので、ここ1つに置く
# (image-tags.sh と同じ)。
#
# 使い方 (GH_TOKEN が要る):
#
#   . .github/bump-pr.sh
#   bump_begin  <枝>                                    # いまの origin/main から枝を切る
#   …ファイルを書き換える…
#   bump_finish <枝> <題> <本文> <status の説明> <ファイル>...  # 書き換えが無ければ何もしない
#
# 枝は毎回 **いまの origin/main** から切る。actions/checkout が取るのは「トリガーした
# コミット」で、2つの run が重なると後発は先発の bump を知らないまま同じ行を書き換え、
# GitHub には衝突に見えて誰もマージできない (書き換えは入力から一意に決まるので、
# 何度やっても同じ結果になる)。
#
# 題はそのまま squash のコミットの題になる。`[skip ci]` を付けておくと、main に入った
# ときに他の workflow を動かさない (直接 push していた頃と同じ)
set -eu

bump_begin() {
  git config user.name "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
  git fetch origin main
  git checkout -B "$1" origin/main
}

bump_finish() {
  branch="$1"
  title="$2"
  body="$3"
  description="$4"
  shift 4

  git add "$@"
  if git diff --cached --quiet; then
    echo "書き換えなし: ${title}"
    return 0
  fi
  git commit -m "$title"
  git push --force origin "$branch"

  gh pr create --base main --head "$branch" --title "$title" --body "$body" \
    || gh pr edit "$branch" --title "$title" --body "$body"

  # main に効いている規則から、必須チェックの context を全部拾う。
  # **引けなかったら `check` だけに落ちる** — `set -e` の下では `$(...)` の中の
  # 失敗でここごと止まるので、`|| true` で受けてから空を見る (レビュー指摘)
  contexts=$(gh api "repos/${GITHUB_REPOSITORY}/rules/branches/main" \
    -q '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context' \
    2>/dev/null || true)
  [ -n "$contexts" ] || contexts=check
  sha=$(git rev-parse HEAD)
  printf '%s\n' "$contexts" | while IFS= read -r context; do
    [ -n "$context" ] || continue
    gh api "repos/${GITHUB_REPOSITORY}/statuses/${sha}" \
      -f state=success \
      -f context="$context" \
      -f description="$description" \
      -f target_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
      > /dev/null
  done

  # status が PR に載るまで少し掛かることがある。載っていなければ auto-merge に倒す
  # (保護が満たされた時点で GitHub がマージする。repo の Allow auto-merge は有効)
  gh pr merge "$branch" --squash --subject "$title" --body "$body" \
    || gh pr merge "$branch" --auto --squash --subject "$title" --body "$body"
}
