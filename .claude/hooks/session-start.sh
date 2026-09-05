#!/usr/bin/env bash
# SessionStart hook.
#
# Reads the current git branch and injects context via SessionStart's
# `hookSpecificOutput.additionalContext` so Claude opens the session with
# the right framing. Hard enforcement (blocking Edit/Write on disallowed
# branches) lives in the sibling pre-tool-use.sh hook.

set -euo pipefail

cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)

emit_context() {
  # Escapes input for embedding in a JSON string field.
  python3 -c '
import json, sys
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": sys.stdin.read(),
  }
}))
' <<<"$1"
}

if [ -z "$branch" ] || [ "$branch" = "main" ] || [ "$branch" = "dev" ] || [ "$branch" = "master" ]; then
  emit_context "## Branching reminder

You are on \`${branch:-<no branch>}\`. Before making any code edits, branch off
\`dev\`:

    git checkout -b GH<issue>/<type>/<slug>   # work that closes a GitHub issue
    git checkout -b <type>/<slug>             # no GitHub issue (Linear ticket or ad-hoc)
    # type ∈ chore, feat, fix, docs, hotfix, infra, refactor

The PreToolUse hook rejects Edit/Write until you are on a feature branch of
one of those shapes (the plan file in plan mode is exempt). See CONTRIBUTING.md
for the workflow."
  exit 0
fi

# Strip an optional GH<issue>/ prefix (mirrors pre-tool-use.sh).
rest="$branch"
if [[ "$branch" =~ ^GH[0-9]+/ ]]; then
  rest="${branch#*/}"
fi

case "$rest" in
  chore/*|feat/*|fix/*|docs/*|hotfix/*|infra/*|refactor/*|W[0-9][0-9]-[0-9]*/*|revert-*|dependabot/*|renovate/*)
    : # feature branch — nothing to flag
    ;;
  *)
    emit_context "## Branching reminder (ALERT)

Current branch \`$branch\` does not match \`GH<issue>/<type>/<slug>\` or
\`<type>/<slug>\` (type ∈ chore, feat, fix, docs, hotfix, infra, refactor). The
PreToolUse hook will reject Edit/Write calls — switch to a feature branch (or
rename this one) before editing."
    ;;
esac
