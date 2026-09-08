#!/usr/bin/env bash
# Proof-labs PreToolUse hook — blocks Edit/Write/NotebookEdit on
# disallowed branches.
#
# The branch name itself is the sentinel: if the current branch matches
# the Proof-labs naming convention (W##-NN/<slug> or <type>/<slug>,
# optionally led by GH<issue>/ for a branch that closes a GitHub issue),
# editing is allowed. Otherwise the hook exits 2, which is a blocking
# error in Claude Code: stderr is shown back to the model and the tool
# call is refused.
#
# Exempt: a call whose target path is outside the repository — the plan
# file under ~/.claude/plans that plan mode writes. Plan mode on its own
# never lifts the gate for a path inside the repo.

set -euo pipefail

cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
# Plan-mode exception: plan mode is read-only apart from the plan file under
# ~/.claude/plans, so a write there must not require a feature branch. The
# tool payload arrives on stdin as JSON. The target path decides: outside this
# repository is not ours to gate; inside it the branch rule below applies,
# whatever the permission mode. A relative path is anchored to the project
# directory and the result canonicalised first, so no spelling of an in-repo
# path can slip past the comparison.
input=$(cat 2>/dev/null || true)
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  mode=$(jq -r '.permission_mode // empty' <<<"$input" 2>/dev/null || true)
  target=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input" 2>/dev/null || true)
  if [ -n "$target" ]; then
    repo=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")
    case "$target" in
      /*) ;;
      *) target="$cwd/$target" ;;   # relative — anchor it before comparing
    esac
    # Canonicalise (symlinks, `..`) so a non-canonical spelling of an in-repo
    # path cannot land in the "outside" branch. Works for files that do not
    # exist yet; falls back to the raw string if python3 is unavailable.
    target=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$target" 2>/dev/null || printf '%s' "$target")
    case "$target" in
      "$repo"/*) ;;      # inside the repo — subject to the branch rule below
      *) exit 0 ;;       # outside (e.g. ~/.claude/plans/*.md) — not ours to gate
    esac
  elif [ "$mode" = "plan" ]; then
    exit 0               # plan mode with no target path: nothing in the repo to gate
  fi
fi
branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)

# Strip an optional `GH<issue>/` prefix; the remainder must still match one of
# the accepted shapes below.
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
Edit/Write blocked: branch '${branch:-<none>}' is not a Proof-labs ticket branch.

Required naming:
  ProofOfBrain card      : W##-NN/<short-kebab-slug>   e.g. W20-04/known-limitations
  Linear ticket / ad-hoc : <type>/<slug>               type ∈ chore, feat, fix, docs, hotfix, infra, refactor
  With a GitHub issue    : GH<issue>/<type>/<slug> or GH<issue>/W##-NN/<slug>   e.g. GH98/fix/oracle-source-vectors

To start: ask the user if this is a ProofOfBrain card (W##-NN), a Linear ticket, or ad-hoc, then:
  git checkout -b W##-NN/<slug>     # ProofOfBrain card
  git checkout -b <type>/<slug>     # Linear ticket or ad-hoc
  (lead with GH<issue>/ if the work closes a GitHub issue, and put "Closes #<issue>" in the PR body)

Then re-try the edit. Writes to the plan file in plan mode are exempt from
this check. If this is intentional ad-hoc exploration with no intent to
commit, the user can disable this hook locally in .claude/settings.local.json.
EOF
    exit 2
    ;;
esac
