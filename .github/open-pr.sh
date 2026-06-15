#!/usr/bin/env bash
# Open a pull request, asking once for an optional task link.
#
# Synced from Proof-labs/.github (templates/agent-config/.github/open-pr.sh).
# This is the terminal counterpart to the Claude Code chat prompt: it asks the
# same question (ProofOfBrain card / Linear ticket / free-style), then hands off
# to `gh pr create` with your answer in the body. Free text, nothing validated,
# nothing blocked.
#
# Usage:
#   bash .github/open-pr.sh [--base <branch>]
# One-time convenience alias:
#   gh alias set prc '!bash .github/open-pr.sh'   # then just: gh prc
#
# Requires the GitHub CLI (`gh`), authenticated.

set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: the GitHub CLI (gh) is required. See https://cli.github.com/" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

# Args — only --base <branch> / --base=<branch> are supported.
base="dev"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 ;;
    --base=*) base="${1#*=}"; shift ;;
    *) echo "Unknown argument: $1" >&2; echo "Usage: $0 [--base <branch>]" >&2; exit 1 ;;
  esac
done

branch="$(git branch --show-current)"
if [ -z "$branch" ]; then
  echo "Error: detached HEAD — check out a branch before opening a PR." >&2
  exit 1
fi
case "$branch" in
  main|dev|develop|master)
    echo "You're on '$branch' — switch to a feature branch before opening a PR." >&2
    exit 1
    ;;
esac

# Trim leading/trailing whitespace (spaces and tabs).
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Default the title to the latest commit subject.
default_title="$(git log -1 --pretty=%s 2>/dev/null || printf '%s' "$branch")"

echo "Opening a pull request:  $branch → $base"
echo
echo "Is this part of a task list?  (optional)"
echo "  • a ProofOfBrain card   e.g.  W25-07"
echo "  • a Linear ticket       e.g.  BE-63"
echo "  • or just press Enter to free-style this one"
printf "Task › "
read -r task < /dev/tty || task=""
task="$(trim "$task")"

if [ -z "$task" ]; then
  task_line="**Task link:** No — free-styling for now"
  echo "✓ No task linked — free-styling. (you can add one later)"
else
  task_line="**Task link:** $task"
  echo "✓ Linking to $task"
fi

printf "Title [%s] › " "$default_title"
read -r title < /dev/tty || title=""
title="$(trim "$title")"
[ -z "$title" ] && title="$default_title"

body="$(printf '## Task link\n\n%s\n\n<!-- Opened via .github/open-pr.sh — edit to add a summary / test plan. -->\n' "$task_line")"

# Push first so `gh pr create` never falls into its own interactive push prompt.
echo "Pushing $branch…"
git push -u origin "$branch"

echo "Creating pull request…"
gh pr create --base "$base" --head "$branch" --title "$title" --body "$body"
