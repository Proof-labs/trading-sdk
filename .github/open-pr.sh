#!/usr/bin/env bash
# Open a pull request with the queue discipline built in: task link, why,
# and the end-of-work decision scan.
#
# Synced from Proof-labs/.github (templates/agent-config/.github/open-pr.sh).
# Interactive by default. Every queue-discipline answer can also be given as a
# flag, and when no terminal is available the decision answer MUST come from a
# flag — the script FAILS CLOSED instead of silently opening a ready PR with
# "No decision required".
#
# Usage:
#   bash .github/open-pr.sh [--base <branch>] [--title <text>] [--task <text>]
#                           [--why <text>]
#                           [--no-decision
#                            | --decision "DEC-1 DEC-2"
#                            | --new-decision "<one-line description>"
#                                [--type p|e|o|r|d] [--priority c|h|m|l]
#                            | --draft]
#
# Queue discipline (CLAUDE.md → Decision Routing & Review-Queue Discipline):
#   - decision-bearing PRs stay DRAFT until their DEC rows are Decided —
#     citing or creating rows here always opens the PR as draft;
#   - the org-wide work-in-progress cap (5 ready-for-review PRs per author:
#     open + non-draft + authored by you + any Proof-labs repo) is counted
#     before a ready PR is created; at or over the cap — or when the count
#     cannot be determined — the PR opens as DRAFT instead (fail closed).
#
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

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

# ── args ──
base="dev"
title=""
task=""
why=""
decrows=""
newdec=""
dec_type=""
dec_prio=""
no_decision=0
draft_flag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 ;;
    --base=*) base="${1#*=}"; shift ;;
    --title) title="${2:-}"; shift 2 ;;
    --task) task="${2:-}"; shift 2 ;;
    --why) why="${2:-}"; shift 2 ;;
    --no-decision) no_decision=1; shift ;;
    --decision) decrows="${2:-}"; shift 2 ;;
    --new-decision) newdec="${2:-}"; shift 2 ;;
    --type) dec_type="${2:-}"; shift 2 ;;
    --priority) dec_prio="${2:-}"; shift 2 ;;
    --draft) draft_flag="--draft"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
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

# ── terminal detection: decision answers must never default silently ──
have_tty=0
if { : < /dev/tty; } 2>/dev/null; then
  have_tty=1
fi

if [ "$have_tty" -eq 0 ] && [ "$no_decision" -eq 0 ] && [ -z "$decrows" ] \
   && [ -z "$newdec" ] && [ -z "$draft_flag" ]; then
  cat >&2 <<'EOF'
Error: no terminal available and no decision answer given — refusing to open
a ready PR with an implicit "No decision required" (fail closed).

Non-interactive runs must state the decision scan's outcome explicitly:
  --no-decision                       the work needs no decision
  --decision "DEC-1 DEC-2"            cites existing register rows (opens draft)
  --new-decision "<description>"      creates a stub row (opens draft)
      [--type p|e|o|r|d] [--priority c|h|m|l]
  --draft                             park as draft, declare later
EOF
  exit 1
fi

# Read one line from the terminal; abort (fail closed) if that's impossible.
ask() { # ask <prompt> <varname>
  local __prompt="$1" __var="$2" __ans=""
  printf "%s › " "$__prompt"
  if ! read -r __ans < /dev/tty; then
    echo "" >&2
    echo "Error: could not read from the terminal — aborting (fail closed). Use the flags in --help for non-interactive runs." >&2
    exit 1
  fi
  printf -v "$__var" '%s' "$(trim "$__ans")"
}

# Default the title to the latest commit subject.
default_title="$(git log -1 --pretty=%s 2>/dev/null || printf '%s' "$branch")"

echo "Opening a pull request:  $branch → $base"
echo

# ── task link ──
if [ -z "$task" ] && [ "$have_tty" -eq 1 ]; then
  echo "Is this part of a task list?  (optional)"
  echo "  • a ProofOfBrain card   e.g.  W25-07"
  echo "  • a Linear ticket       e.g.  BE-63"
  echo "  • or just press Enter to free-style this one"
  ask "Task" task
fi
if [ -z "$task" ]; then
  task_line="**Task link:** No — free-styling for now"
  echo "✓ No task linked — free-styling. (you can add one later)"
else
  task_line="**Task link:** $task"
  echo "✓ Linking to $task"
fi

# ── why ──
if [ -z "$why" ] && [ "$have_tty" -eq 1 ]; then
  echo "Why are we building this?  (one line — the goal this serves; Enter to fill in later)"
  ask "Why" why
fi
[ -z "$why" ] && why="_fill in before review_"

# ── title ──
if [ -z "$title" ] && [ "$have_tty" -eq 1 ]; then
  ask "Title [$default_title]" title
fi
[ -z "$title" ] && title="$default_title"

# ── decision scan ──
if [ "$no_decision" -eq 0 ] && [ -z "$decrows" ] && [ -z "$newdec" ] \
   && [ -z "$draft_flag" ] && [ "$have_tty" -eq 1 ]; then
  echo
  echo "Does merging this PR require a product / economic / organisational decision?"
  echo "  (a new policy, parameters, ownership, release authority — see"
  echo "   Proof-labs/ProofOfBrain → delivery/decision-register.md)"
  echo "  • press Enter for no"
  echo "  • list existing register rows   e.g.  DEC-7 DEC-10"
  echo "  • or describe the NEW decision in one line"
  ask "Decision" dec_answer
  if [ -z "$dec_answer" ]; then
    no_decision=1
  elif printf '%s' "$dec_answer" | grep -Eq '^DEC-[0-9]+([ ,]+DEC-[0-9]+)*$'; then
    decrows="$dec_answer"
  else
    newdec="$dec_answer"
  fi
fi

decision_line=""
if [ -n "$newdec" ]; then
  # A decision with no register row yet → create the stub row now.
  mkrow="y"
  if [ "$have_tty" -eq 1 ]; then
    echo "New decision (no DEC-N rows yet):"
    echo "    $newdec"
    ask "Create the stub register row in ProofOfBrain now? [Y/n]" mkrow
  fi
  if [ "$have_tty" -eq 1 ] && [ -z "$dec_type" ] && { [ "$mkrow" != "n" ] && [ "$mkrow" != "N" ]; }; then
    echo "Decision type?  [p]roduct  [e]conomic  [o]rganisational  [r]elease  [d]esign (engineering)"
    ask "Type [product]" dec_type
  fi
  if [ "$have_tty" -eq 1 ] && [ -z "$dec_prio" ] && { [ "$mkrow" != "n" ] && [ "$mkrow" != "N" ]; }; then
    echo "Priority?  [c]ritical = ASAP   [h]igh = 3 working days   [m]edium = 2 working weeks   [l]ow = a month"
    ask "Priority [medium]" dec_prio
  fi
  repo_slug="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "this repository")"
  if [ "$mkrow" = "n" ] || [ "$mkrow" = "N" ]; then
    decision_line="- [x] **Needs authority** — register rows: TBD (\"$newdec\" — add before review) — stays **draft**"
    draft_flag="--draft"
    echo "✓ Skipped row creation — remember to add it. Opening as DRAFT."
  elif out="$(DEC_DESC="$newdec" DEC_SRC="$repo_slug \`$branch\`" DEC_TYPE="$dec_type" DEC_PRIORITY="$dec_prio" python3 "$(dirname "$0")/new-decision-row.py" 2>&1)"; then
    dec_id="$(printf '%s' "$out" | tail -1 | cut -f1)"
    dec_url="$(printf '%s' "$out" | tail -1 | cut -f2)"
    decision_line="- [x] **Needs authority** — register row: $dec_id (stub: $dec_url) — stays **draft** until it is Decided"
    draft_flag="--draft"
    echo "✓ Created $dec_id → $dec_url"
    echo "✓ Opening this pull request as DRAFT per the queue discipline."
  else
    echo "⚠ Could not create the register row automatically:" >&2
    printf '%s\n' "$out" >&2
    decision_line="- [x] **Needs authority** — register rows: TBD (\"$newdec\" — add before review) — stays **draft**"
    draft_flag="--draft"
    echo "✓ Opening as DRAFT anyway — add the row manually."
  fi
elif [ -n "$decrows" ]; then
  if ! printf '%s' "$decrows" | grep -Eq '^DEC-[0-9]+([ ,]+DEC-[0-9]+)*$'; then
    echo "Error: --decision expects register row ids like \"DEC-7 DEC-10\" (got: $decrows)." >&2
    exit 1
  fi
  decision_line="- [x] **Needs authority** — register rows: $decrows — stays **draft** until they are Decided"
  draft_flag="--draft"
  echo "✓ Needs authority ($decrows) — opening as DRAFT per the queue discipline."
elif [ "$no_decision" -eq 1 ]; then
  decision_line="- [x] **No decision required** — routine work, reviewable on its merits"
  echo "✓ No decision required."
else
  # --draft with no declaration: park now, declare before marking ready.
  decision_line="- [ ] draft parked — run the decision scan and check a lane before marking ready"
  echo "✓ Parking as DRAFT — declare the decision scan before marking ready."
fi

# ── org-wide work-in-progress cap: 5 ready-for-review PRs per author ──
# Semantics: open + non-draft + authored by you + any Proof-labs repository.
# At/over the cap, or when the count can't be determined: open as DRAFT.
if [ -z "$draft_flag" ]; then
  count="$(gh search prs --owner Proof-labs --author "@me" --state open --draft=false \
            --limit 100 --json id --jq 'length' 2>/dev/null || true)"
  if ! printf '%s' "$count" | grep -Eq '^[0-9]+$'; then
    draft_flag="--draft"
    echo "⚠ Could not verify the 5-ready work-in-progress cap — opening as DRAFT (fail closed)."
  elif [ "$count" -ge 5 ]; then
    draft_flag="--draft"
    echo "⚠ Work-in-progress cap reached ($count ready PRs across Proof-labs; cap 5) — opening as DRAFT until a slot frees."
  fi
fi

body="$(printf '## Why\n\n%s\n\n## Task link\n\n%s\n\n## Decisions\n\n%s\n\n<!-- Opened via .github/open-pr.sh — edit to add a summary / test plan. -->\n' "$why" "$task_line" "$decision_line")"

# Push first so `gh pr create` never falls into its own interactive push prompt.
echo "Pushing $branch…"
git push -u origin "$branch"

echo "Creating pull request…"
gh pr create --base "$base" --head "$branch" --title "$title" --body "$body" $draft_flag
