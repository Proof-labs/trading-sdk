#!/usr/bin/env bash
# PreToolUse hook — blocks Edit/Write/NotebookEdit on disallowed branches.
#
# The branch name itself is the sentinel: if the current branch is a
# feature branch (optionally prefixed with the GitHub issue it closes),
# editing is allowed. Otherwise the hook exits 2, which is a blocking
# error in Claude Code: stderr is shown back to the model and the tool
# call is refused.
#
# Accepted shapes:
#   GH<issue>/<type>/<slug>    e.g. GH98/fix/oracle-source-vectors
#   GH<issue>/W##-NN/<slug>    e.g. GH12/W28-15/oi-cap-contract
#   <type>/<slug>              no GitHub issue (Linear ticket or ad-hoc)
#   W##-NN/<slug>              ProofOfBrain card without a GitHub issue
#
# Plan-mode exception: plan mode is read-only apart from the plan file under
# ~/.claude/plans, so a write there must not require a feature branch. The
# tool payload arrives on stdin as JSON; a call made in plan mode, or one whose
# target path is outside this repository, is allowed through regardless of
# branch. The branch rule keeps guarding every write inside the repo.

set -euo pipefail

cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"

input=$(cat 2>/dev/null || true)
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  mode=$(jq -r '.permission_mode // empty' <<<"$input" 2>/dev/null || true)
  if [ "$mode" = "plan" ]; then
    exit 0
  fi
  target=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input" 2>/dev/null || true)
  if [ -n "$target" ]; then
    repo=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")
    case "$target" in
      "$repo"/*) ;;      # inside the repo — subject to the branch rule below
      *) exit 0 ;;       # outside (e.g. ~/.claude/plans/*.md) — not ours to gate
    esac
  fi
fi

branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)

# Strip an optional `GH<issue>/` prefix; the remainder must still be a
# feature branch of one of the accepted shapes.
rest="$branch"
if [[ "$branch" =~ ^GH[0-9]+/ ]]; then
  rest="${branch#*/}"
fi

case "$rest" in
  W[0-9][0-9]-[0-9]*/*)
    exit 0
    ;;
  chore/*|feat/*|fix/*|docs/*|hotfix/*|infra/*|refactor/*|revert-*|dependabot/*|renovate/*)
    exit 0
    ;;
  *)
    cat >&2 <<EOF
Edit/Write blocked: branch '${branch:-<none>}' is not a feature branch.

Branch off dev before editing:
  git checkout -b GH<issue>/<type>/<slug>   # work that closes a GitHub issue
  git checkout -b <type>/<slug>             # no GitHub issue (Linear ticket or ad-hoc)
  # type ∈ chore, feat, fix, docs, hotfix, infra, refactor
  # ProofOfBrain cards: GH<issue>/W##-NN/<slug> or W##-NN/<slug>

Then re-try the edit. See CONTRIBUTING.md for the workflow. If this is
intentional exploration with no intent to commit, you can disable this hook
locally in .claude/settings.local.json.
EOF
    exit 2
    ;;
esac
