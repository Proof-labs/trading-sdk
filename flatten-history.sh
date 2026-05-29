#!/usr/bin/env bash
# Linearize history along the first-parent chain: each mainline commit is
# recreated carrying its own tree, so merge commits become ordinary commits
# with their result tree. No conflicts; the final tree is identical to the
# pre-flatten tip. Run from the repo root.
set -euo pipefail

prev=""
count=0
# first-parent chain, oldest first
for c in $(git rev-list --first-parent --reverse HEAD); do
  tree=$(git rev-parse "$c^{tree}")
  # preserve author + committer identity and dates
  GIT_AUTHOR_NAME=$(git show -s --format='%an' "$c")
  GIT_AUTHOR_EMAIL=$(git show -s --format='%ae' "$c")
  GIT_AUTHOR_DATE=$(git show -s --format='%aI' "$c")
  GIT_COMMITTER_NAME=$(git show -s --format='%cn' "$c")
  GIT_COMMITTER_EMAIL=$(git show -s --format='%ce' "$c")
  GIT_COMMITTER_DATE=$(git show -s --format='%cI' "$c")
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE
  export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE

  if [ -z "$prev" ]; then
    new=$(git show -s --format=%B "$c" | git commit-tree "$tree")
  else
    new=$(git show -s --format=%B "$c" | git commit-tree "$tree" -p "$prev")
  fi
  prev=$new
  count=$((count+1))
done

echo "rebuilt $count commits, new tip $prev"
git update-ref refs/heads/main "$prev"
echo "main moved to $(git rev-parse --short main)"
