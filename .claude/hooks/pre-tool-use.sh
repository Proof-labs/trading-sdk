#!/usr/bin/env bash
# Proof-labs PreToolUse hook — blocks Edit/Write/NotebookEdit on
# disallowed branches.
#
# The branch name itself is the sentinel: if the current branch matches
# the Proof-labs naming convention (W##-NN/<slug> or <type>/<slug>),
# editing is allowed. Otherwise the hook exits 2, which is a blocking
# error in Claude Code: stderr is shown back to the model and the tool
# call is refused.

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
Edit/Write blocked: branch '${branch:-<none>}' is not a Proof-labs ticket branch.

Required naming:
  ProofOfBrain card      : W##-NN/<short-kebab-slug>   e.g. W20-04/known-limitations
  Linear ticket / ad-hoc : <type>/<slug>               type ∈ chore, feat, fix, docs, hotfix, infra, refactor

To start: ask the user if this is a ProofOfBrain card (W##-NN), a Linear ticket, or ad-hoc, then:
  git checkout -b W##-NN/<slug>     # ProofOfBrain card
  git checkout -b <type>/<slug>     # Linear ticket or ad-hoc

Then re-try the edit. If this is intentional ad-hoc exploration with no
intent to commit, the user can disable this hook locally in
.claude/settings.local.json.
EOF
    exit 2
    ;;
esac
