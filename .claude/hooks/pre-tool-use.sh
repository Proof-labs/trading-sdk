#!/usr/bin/env bash
# Proof-labs PreToolUse hook — two gates:
#
# 1. Edit/Write/NotebookEdit: blocks edits on disallowed branches.
#    The branch name itself is the sentinel: if the current branch matches
#    the Proof-labs naming convention (W##-NN/<slug> or <type>/<slug>,
#    optionally led by GH<issue>/ for a branch that closes a GitHub issue),
#    editing is allowed. Otherwise the hook exits 2, which is a blocking
#    error in Claude Code: stderr is shown back to the model and the tool
#    call is refused.
#
#    Exempt: a call whose target path is outside the repository — the plan
#    file under ~/.claude/plans that plan mode writes. Plan mode on its own
#    never lifts the gate for a path inside the repo.
#
# 2. Bash: blocks `git add` of any file at or over 1 MiB that is not
#    tracked by Git LFS. Git itself resolves which files an add would stage
#    (`git add --dry-run`), so directories, globs and bulk adds are covered.
#    Large binary artifacts must not enter git history — the org ruleset
#    forbids force-pushing dev/main, so a merged blob is permanent. Use
#    `git lfs track '<pattern>'` or external hosting. The org "No large
#    binaries" CI check is the backstop for anything that slips past this
#    hook (for example `git commit -a`).

set -euo pipefail

MAX_BYTES=$((1024 * 1024))

cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
input=$(cat 2>/dev/null || true)

# Which tool is being called. Without jq, fall back to a plain match so the
# Bash gate still runs; an unreadable payload falls through to the branch gate,
# which fails closed exactly as before this hook gained a second gate.
tool=""
if [ -n "$input" ]; then
  if command -v jq >/dev/null 2>&1; then
    tool=$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null || true)
  else
    tool=$(printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
  fi
fi

# ---------------------------------------------------------------------------
# Gate 2 — no large binaries through `git add` (Bash).
# ---------------------------------------------------------------------------
if [ "$tool" = "Bash" ]; then
  command=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null || true)

  # Cheap pre-filter: only inspect git-add invocations. Other commands pass.
  if ! printf '%s' "$command" | grep -qE '(^|[;&|[:space:]]+)git([[:space:]]+[^;&|]*)?[[:space:]]+add([[:space:]]|$)'; then
    exit 0
  fi

  # Parse the command with shell quoting rules, follow `cd <dir>` and
  # `git -C <dir>` so each add is inspected from the directory it runs in, and
  # ask git which files it would stage (directories, globs, bulk adds). Prints
  # one "  <path> (<KB> KB)" line per non-LFS file at or over the limit.
  # Interactive adds stage hunks of tracked files only and are skipped. If the
  # inspection cannot run (no python3), the add passes and CI is the backstop.
  blocked=$(python3 - "$cwd" "$MAX_BYTES" "$command" <<'PY' 2>/dev/null || true
import os, re, shlex, subprocess, sys

cwd, max_bytes, command = sys.argv[1], int(sys.argv[2]), sys.argv[3]
# A newline separates commands just like `;`, so it is punctuation, not whitespace.
lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
lexer.whitespace = " \t\r"
lexer.whitespace_split = True
tokens = list(lexer)

segments, current = [], []
for tok in tokens:
    if tok and set(tok) <= set(";&|()\n"):
        if current:
            segments.append(current)
        current = []
    else:
        current.append(tok)
if current:
    segments.append(current)

INTERACTIVE = {"-p", "--patch", "-i", "--interactive", "-e", "--edit"}
here = cwd
for seg in segments:
    if seg[0] == "cd" and len(seg) >= 2:
        here = os.path.normpath(os.path.join(here, os.path.expanduser(seg[1])))
        continue
    if seg[0] != "git":
        continue
    run_dir, i = here, 1
    while i < len(seg) and seg[i].startswith("-"):
        if seg[i] == "-C" and i + 1 < len(seg):
            run_dir = os.path.normpath(os.path.join(run_dir, seg[i + 1]))
            i += 2
        elif seg[i] in ("-c", "--git-dir", "--work-tree") and i + 1 < len(seg):
            i += 2
        else:
            i += 1
    if i >= len(seg) or seg[i] != "add":
        continue
    args = seg[i + 1:]
    if not args or INTERACTIVE & set(args):
        continue
    res = subprocess.run(["git", "-C", run_dir, "add", "--dry-run", *args],
                         capture_output=True, text=True)
    top = subprocess.run(["git", "-C", run_dir, "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True).stdout.strip()
    # The dry run prints paths relative to the repository root.
    for line in res.stdout.splitlines():
        m = re.fullmatch(r"add '(.*)'", line)
        if not m or not top:
            continue
        path = os.path.join(top, m.group(1))
        if not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        if size < max_bytes:
            continue
        attr = subprocess.run(["git", "-C", top, "check-attr", "filter", "--", m.group(1)],
                              capture_output=True, text=True).stdout
        if attr.strip().endswith(": lfs"):
            continue
        print(f"  {os.path.relpath(path, cwd)} ({size // 1024} KB)")
PY
)

  if [ -n "$blocked" ]; then
    cat >&2 <<EOF
git add blocked: file(s) at or over 1 MiB must not be committed to a Proof repo.

${blocked}

Blobs merged into dev or main are permanent — the org ruleset forbids
force-pushing there, so the payload would bloat every future clone forever.

Fix — pick one:
  1. Git LFS (if the asset must live in the repo):
       git lfs track '<pattern>' && git add .gitattributes && git add <file>
  2. External hosting (CDN, release asset, storage bucket); reference it
     by URL from the doc or code that needs it.
  3. If the file genuinely belongs (e.g. a fixture), split it out or shrink
     it below the 1 MiB threshold.

The "No large binaries" CI check enforces the same threshold on PRs.
EOF
    exit 2
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Gate 1 — branch sentinel for file-editing tools (unchanged).
# ---------------------------------------------------------------------------
# Plan-mode exception: plan mode is read-only apart from the plan file under
# ~/.claude/plans, so a write there must not require a feature branch. The
# tool payload arrives on stdin as JSON. The target path decides: outside this
# repository is not ours to gate; inside it the branch rule below applies,
# whatever the permission mode. A relative path is anchored to the project
# directory first and containment is decided by filesystem identity, so no
# spelling of an in-repo path can slip past the comparison.
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
  mode=$(jq -r '.permission_mode // empty' <<<"$input" 2>/dev/null || true)
  target=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input" 2>/dev/null || true)
  if [ -n "$target" ]; then
    repo=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")
    case "$target" in
      /*) ;;
      *) target="$cwd/$target" ;;   # relative — anchor it before comparing
    esac
    # Decide containment by filesystem identity, not by string prefix: the
    # target is canonicalised (symlinks, `..`), then its nearest existing
    # ancestor is walked upward and each step is compared with the repository
    # root by inode. That also catches a case-aliased spelling on a
    # case-insensitive filesystem, which a prefix comparison lets through.
    # Works for files that do not exist yet. If the check itself cannot run
    # (no python3), the write is treated as inside: fail closed, never open.
    where=$(python3 - "$target" "$repo" <<'PY' 2>/dev/null || printf 'inside'
import os, sys
target, repo = os.path.realpath(sys.argv[1]), sys.argv[2]
try:
    root = os.stat(repo)
except OSError:
    sys.exit(1)
path = target
while True:
    try:
        if os.path.samestat(os.stat(path), root):
            print("inside")
            sys.exit(0)
    except OSError:
        pass
    parent = os.path.dirname(path)
    if parent == path:
        break
    path = parent
print("outside")
PY
)
    case "$where" in
      outside) exit 0 ;;   # e.g. ~/.claude/plans/*.md — not ours to gate
      *) ;;                # inside, or undecidable — subject to the branch rule below
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
