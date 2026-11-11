#!/usr/bin/env bash
# Proof-labs SessionStart hook.
#
# Reads the current git branch and injects context via SessionStart's
# `hookSpecificOutput.additionalContext` so Claude opens the session with
# the right framing. Hard enforcement (blocking Edit/Write on disallowed
# branches) lives in the sibling pre-tool-use.sh hook.

set -euo pipefail

cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)

# Strip an optional `GH<issue>/` prefix (a branch that closes a GitHub issue);
# the remainder is what the shapes below are matched against.
rest="$branch"
if [[ "$branch" =~ ^GH[0-9]+/ ]]; then
  rest="${branch#*/}"
fi

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

if [ -z "$branch" ] || [ "$branch" = "main" ] || [ "$branch" = "dev" ]; then
  emit_context "## Proof-labs branching policy (REQUIRED)

You are on \`${branch:-<no branch>}\`. Before making any code edits, you MUST:

1. Ask the user: **\"Is this a ProofOfBrain board card (\`W##-NN\`, e.g. W20-04), a Linear ticket (\`BE-##\`), or ad-hoc work?\"**
2. Wait for the user's response.
3. Create a branch with the correct prefix. If the work closes a GitHub issue, lead with \`GH<issue>/\` (e.g. \`GH98/fix/oracle-source-vectors\`) and put \`Closes #<issue>\` in the PR body:
   - **ProofOfBrain card:** \`git checkout -b W##-NN/<short-kebab-slug>\` (e.g. \`W20-04/known-limitations\`); with a GitHub issue, \`GH<issue>/W##-NN/<short-kebab-slug>\`.
   - **Linear ticket or ad-hoc:** \`git checkout -b <type>/<slug>\` where \`<type>\` is one of: \`chore\`, \`feat\`, \`fix\`, \`docs\`, \`hotfix\`, \`infra\`, \`refactor\`; with a GitHub issue, \`GH<issue>/<type>/<slug>\`. A Linear ticket is attached at PR time, not in the branch name.
4. If a ProofOfBrain card: read the board card from \`Proof-labs/ProofOfBrain\` at \`delivery/boards/YYYY-Www.md\` (heading \`### W##-NN — <title>\`) before editing. Use \`gh api\` or the GitHub MCP if available.
5. Confirm scope with the user before editing any files.

> The PreToolUse hook will reject Edit/Write tool calls until the current branch matches one of these patterns (writes to the plan file in plan mode are exempt). Do not try to bypass — fix the branch."
  exit 0
fi

case "$rest" in
  W[0-9][0-9]-[0-9]*/*)
    ticket="${rest%%/*}"
    week="${ticket:1:2}"
    year=$(date -u +%Y)
    emit_context "## Proof-labs branching policy

Current branch: \`$branch\`
Ticket: **$ticket** (week W$week, year $year)
Board card: \`Proof-labs/ProofOfBrain\` → \`delivery/boards/${year}-W${week}.md\` → heading \`### $ticket — …\`

If you have not already read the board card this session, do so before editing files to ground your understanding of scope and Definition-of-Done axes."
    ;;
  chore/*|feat/*|fix/*|docs/*|hotfix/*|infra/*|refactor/*|revert-*|dependabot/*|renovate/*)
    type="${rest%%/*}"
    emit_context "## Proof-labs branching policy

Current branch: \`$branch\` (type: \`$type\`, no ProofOfBrain card).

When you open the PR, set the optional **Task link** in the body — a Linear ticket (\`BE-##\`) if this maps to one, otherwise tick \"No — free-styling\". It's advisory and never blocks a merge."
    ;;
  *)
    emit_context "## Proof-labs branching policy (ALERT)

Current branch: \`$branch\` — does **not** match the Proof-labs naming convention.

Allowed patterns:
- \`W##-NN/<slug>\` for board-ticket work
- \`<type>/<slug>\` where type ∈ {chore, feat, fix, docs, hotfix, infra, refactor}
- either of the above led by \`GH<issue>/\` when the work closes a GitHub issue (e.g. \`GH98/fix/oracle-source-vectors\`)

The PreToolUse hook will reject Edit/Write calls (writes to the plan file in plan mode are exempt). Switch to a compliant branch (or rename this one) before editing."
    ;;
esac
