#!/usr/bin/env bash
# PreToolUse hook — blocks Edit/Write/NotebookEdit on disallowed branches.
#
# The branch name itself is the sentinel: if the current branch is a
# <type>/<slug> feature branch, editing is allowed. Otherwise the hook
# exits 2, which is a blocking error in Claude Code: stderr is shown back
# to the model and the tool call is refused.

set -euo pipefail

cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)

case "$branch" in
  W[0-9][0-9]-[0-9]*/*)
    exit 0
    ;;
  chore/*|feat/*|fix/*|docs/*|hotfix/*|infra/*|refactor/*|revert-*|dependabot/*|renovate/*)
    exit 0
    ;;
  *)
    cat >&2 <<EOF
Edit/Write blocked: branch '${branch:-<none>}' is not a feature branch.

Branch off main before editing:
  git checkout -b <type>/<slug>     # type ∈ chore, feat, fix, docs, hotfix, infra, refactor

Then re-try the edit. See CONTRIBUTING.md for the workflow. If this is
intentional exploration with no intent to commit, you can disable this hook
locally in .claude/settings.local.json.
EOF
    exit 2
    ;;
esac
