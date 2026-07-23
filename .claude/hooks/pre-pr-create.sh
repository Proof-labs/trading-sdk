#!/usr/bin/env bash
# Proof-labs PreToolUse hook (matcher: Bash) — the end-of-work decision scan.
#
# At the START of a piece of work you often don't know a decision is hiding in
# it; by PR-creation time you do. This hook intercepts `gh pr create` and
# refuses a READY pull request until the Decisions section of the body has
# actually been answered. Detection and validation are STRUCTURAL:
#
#   - the command is tokenized (shlex) and split into segments on && ; | — a
#     segment is gated when it actually invokes gh's `pr create` subcommand
#     (global flags like `--repo X` between `gh` and `pr` are recognised), and
#     a segment is exempt only when it actually EXECUTES .github/open-pr.sh —
#     merely mentioning the helper (a comment, an echo) exempts nothing;
#   - a lane only counts when its checkbox is CHECKED (`- [x]`) — a body
#     copied from the PR template with unchecked `- [ ]` lines is refused;
#   - "Decisions made in this PR" needs at least one real bullet — HTML
#     comments, "e.g.", "TBD", "…" placeholders don't count;
#   - "Needs authority" rows are verified against the live decision register
#     (Proof-labs/ProofOfBrain → delivery/decision-register.md): every cited
#     DEC-N row must be Decided, otherwise the PR must be `--draft`;
#   - the org-wide work-in-progress cap (5 ready-for-review pull requests per
#     author: open + non-draft + authored by you + any Proof-labs repo) is
#     counted before a ready PR may be created;
#   - ALL failures fail closed: missing jq or python3, an unparsable hook
#     payload, an unreadable body file, an unreachable register, an
#     uncountable cap — each refuses the creation with a reason.
#
# `gh pr create --draft` in the gated segment always passes: draft is the
# parking state; declarations follow before the PR is marked ready.
#
# QUEUE_DISCIPLINE_SKIP="register,cap" skips the two network checks — for
# hook tests only, never in normal use.
#
# Exit 2 = blocking: stderr is shown to the model and the tool call refused.

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "PR-creation gate cannot run: jq is missing (fail closed). Install jq, or create the PR with --draft after installing." >&2
  exit 2
fi

payload="$(cat)"
if ! cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"; then
  echo "PR-creation gate could not parse the hook payload (fail closed)." >&2
  exit 2
fi
[ -z "$cmd" ] && exit 0

# Cheap prefilter — anything that can possibly be a gh pr create goes to the
# structural check; everything else passes immediately.
case "$cmd" in
  *gh*create*) ;;
  *) exit 0 ;;
esac

if ! command -v python3 >/dev/null 2>&1; then
  echo "PR creation blocked: python3 is required by the queue-discipline gate (or create the PR with --draft)." >&2
  exit 2
fi

CMD="$cmd" python3 - <<'PY'
import base64, json, os, re, shlex, subprocess, sys

cmd = os.environ.get("CMD", "")
skip = os.environ.get("QUEUE_DISCIPLINE_SKIP", "")

HELP = """PR creation blocked: the decision scan hasn't been answered (queue discipline).

Decisions usually only become visible at the END of the work. Re-read the FULL
branch diff, then put a CHECKED lane in the body's `## Decisions` section:

  - [x] **No decision required** — routine work, reviewable on its merits
or
  - [x] **Decisions made in this PR** — routine engineering calls, for review here:
    - <the actual decisions the work made — at least one real bullet>
or
  - [x] **Needs authority** — register rows `DEC-N` — plus `--draft` while any
        row is still Open (ready is allowed only when every cited row is Decided)

Register: Proof-labs/ProofOfBrain → delivery/decision-register.md
(`.github/new-decision-row.py` creates a stub row — env DEC_DESC, DEC_TYPE,
DEC_PRIORITY). Interactive alternative: bash .github/open-pr.sh.
`--draft` always passes: draft is the parking state."""


def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


try:
    argv = shlex.split(cmd)
except ValueError:
    # Unparsable shell — we cannot know what it does. Fail closed.
    block("PR-creation gate could not tokenize this command (fail closed). "
          "Simplify the command, or create the PR with --draft.")

SEPARATORS = {"&&", "||", ";", "|", "&"}


def segments(tokens):
    seg = []
    for t in tokens:
        if t in SEPARATORS:
            if seg:
                yield seg
            seg = []
        else:
            seg.append(t)
    if seg:
        yield seg


ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
GH_VALUE_FLAGS = {"-R", "--repo", "--hostname"}


def executable_index(seg):
    i = 0
    while i < len(seg) and ENV_ASSIGN.match(seg[i]):
        i += 1
    return i if i < len(seg) else None


def is_helper(seg):
    """True only when this segment EXECUTES open-pr.sh."""
    i = executable_index(seg)
    if i is None:
        return False
    head = os.path.basename(seg[i])
    if head.endswith("open-pr.sh"):
        return True
    if head in ("bash", "sh", "zsh"):
        for t in seg[i + 1:]:
            if t.startswith("-"):
                continue
            return os.path.basename(t).endswith("open-pr.sh")
    return False


def is_gh_pr_create(seg):
    """True when this segment invokes gh's `pr create`, global flags included."""
    i = executable_index(seg)
    if i is None or os.path.basename(seg[i]) != "gh":
        return False
    sub = []
    j = i + 1
    while j < len(seg) and len(sub) < 2:
        t = seg[j]
        if t in GH_VALUE_FLAGS:
            j += 2
            continue
        if t.startswith("-"):
            j += 1
            continue
        sub.append(t)
        j += 1
    return sub[:2] == ["pr", "create"]


gated = [s for s in segments(argv) if is_gh_pr_create(s) and not is_helper(s)]
if not gated:
    sys.exit(0)


def read_body(seg):
    body = None
    for i, a in enumerate(seg):
        if a in ("--body", "-b") and i + 1 < len(seg):
            body = seg[i + 1]
        elif a.startswith("--body="):
            body = a[len("--body="):]
        elif a in ("--body-file", "-F") and i + 1 < len(seg):
            try:
                body = open(seg[i + 1]).read()
            except OSError:
                block(f"PR creation blocked: --body-file {seg[i+1]} is unreadable (fail closed).\n\n{HELP}")
        elif a.startswith("--body-file="):
            try:
                body = open(a[len("--body-file="):]).read()
            except OSError:
                block(f"PR creation blocked: body file is unreadable (fail closed).\n\n{HELP}")
    return body


PLACEHOLDER = re.compile(r"^\s*[-*]\s*(<!--|…\s*$|\.\.\.\s*$|e\.g\.|tbd\b|todo\b)", re.I)


def validate(seg):
    if "--draft" in seg or "-d" in seg:
        return  # parking state — always allowed

    body = read_body(seg)
    if body is None:
        block(HELP)
    lines = body.splitlines()

    def lane_checked(label):
        pat = re.compile(r"^\s*[-*]\s*\[[xX]\]\s*(\*\*)?" + re.escape(label))
        for idx, l in enumerate(lines):
            if pat.match(l):
                return idx
        return None

    no_dec = lane_checked("No decision required")
    made = lane_checked("Decisions made in this PR")
    needs = lane_checked("Needs authority")

    if no_dec is None and made is None and needs is None:
        block(HELP)
    if no_dec is not None and (made is not None or needs is not None):
        block("PR creation blocked: contradictory Decisions lanes — 'No decision "
              "required' is checked together with a decisions lane. Check the "
              "lanes that are true and uncheck the rest.")

    if made is not None:
        real = False
        for l in lines[made + 1:]:
            if re.match(r"^\s*[-*]\s*\[", l) or l.startswith("#"):
                break
            if re.match(r"^\s*[-*]\s+\S", l) and not PLACEHOLDER.match(l):
                real = True
                break
        if not real:
            block("PR creation blocked: 'Decisions made in this PR' is checked "
                  "but lists nothing real (placeholders like comments, 'e.g.', "
                  "'TBD', '…' don't count). List the actual decisions the work "
                  "made — that inventory is the point of the lane.")

    if needs is not None:
        rows = sorted({int(n) for n in re.findall(r"DEC-(\d+)", body)})
        if not rows:
            block("PR creation blocked: 'Needs authority' is checked but no "
                  "DEC-N rows are cited. Cite the register rows (or create "
                  "stubs via .github/new-decision-row.py) and use --draft "
                  "while they are Open.")
        if "register" not in skip:
            try:
                out = subprocess.run(
                    ["gh", "api",
                     "repos/Proof-labs/ProofOfBrain/contents/delivery/decision-register.md?ref=dev"],
                    capture_output=True, text=True, timeout=30)
                if out.returncode != 0:
                    raise RuntimeError(out.stderr.strip()[:200])
                content = base64.b64decode(json.loads(out.stdout)["content"]).decode()
            except Exception as e:  # noqa: BLE001 — any failure fails closed
                block(f"PR creation blocked: could not verify the cited DEC rows "
                      f"against the live register ({e}). Fail closed — retry, or "
                      f"open with --draft.")
            for n in rows:
                m = re.search(rf"^\|\s*DEC-{n}\s*\|.*$", content, re.M)
                if not m:
                    block(f"PR creation blocked: DEC-{n} is cited but not in the "
                          f"register. Create the row first "
                          f"(.github/new-decision-row.py) and use --draft.")
                cells = [c.strip() for c in m.group(0).split("|")]
                status = cells[-2] if len(cells) >= 2 else ""
                if not status.startswith("Decided"):
                    block(f"PR creation blocked: DEC-{n} is '{status or 'unknown'}', "
                          f"not Decided. A needs-authority PR stays --draft until "
                          f"every cited row is Decided.")

    # ── org-wide work-in-progress cap: 5 ready-for-review PRs per author ──
    # Semantics: open + non-draft + authored by the current gh user + any
    # Proof-labs repository.
    if "cap" not in skip:
        try:
            out = subprocess.run(
                ["gh", "search", "prs", "--owner", "Proof-labs", "--author", "@me",
                 "--state", "open", "--draft=false", "--limit", "100",
                 "--json", "id", "--jq", "length"],
                capture_output=True, text=True, timeout=30)
            if out.returncode != 0:
                raise RuntimeError(out.stderr.strip()[:200])
            count = int(out.stdout.strip())
        except Exception as e:  # noqa: BLE001
            block(f"PR creation blocked: could not count your open "
                  f"ready-for-review pull requests ({e}). Fail closed — retry, "
                  f"or open with --draft.")
        if count >= 5:
            block(f"PR creation blocked: work-in-progress cap reached — you "
                  f"already have {count} ready-for-review pull requests across "
                  f"Proof-labs (cap: 5). Open this one with --draft, or get an "
                  f"open one merged or closed first.")


for seg in gated:
    validate(seg)

sys.exit(0)
PY
rc=$?
[ "$rc" -eq 0 ] && exit 0
exit 2
