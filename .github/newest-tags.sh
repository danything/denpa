#!/bin/sh
# いま main の先頭で数えたイメージのタグを出す。**この run のタグが古くなっていないか**を見るのに使う。
#
# push の通知は順に届くとは限らない。続けて2つマージしたとき、先のコミットの通知が1分遅れて届き、
# 後のコミットの run のあとに走ったことがある (#1229 と #1230)。古い run が後から `develop` と
# deploy の印を書くと、本番が古いイメージに戻る。main の先頭で数え直したタグがこの run のタグと
# 違えば、もっと新しいイメージを組む run がある (あった) ので、`develop` と印には触らない。
#
# 使い方: . .github/newest-tags.sh  → $NEWEST_AGENT_TAG と $NEWEST_DENPA_TAG が入る
# (fetch-depth: 0 で checkout してあること)
set -eu

git fetch -q origin main
newest=$(mktemp -d)
git worktree add -q --detach "$newest" origin/main
# 数え方は image-tags.sh 1つに置いてある。main の先頭のものを、main の先頭で使う
NEWEST_AGENT_TAG=$(cd "$newest" && . .github/image-tags.sh && echo "$AGENT_TAG")
NEWEST_DENPA_TAG=$(cd "$newest" && . .github/image-tags.sh && echo "$DENPA_TAG")
git worktree remove --force "$newest"
