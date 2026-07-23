#!/usr/bin/env bash
# Proof-labs PreToolUse hook (matcher: Bash) — the end-of-work decision scan.
#
# At the START of a piece of work you often don't know a decision is hiding in
# it; by PR-creation time you do. This hook intercepts `gh pr create` and
# refuses a READY pull request until the Decisions section of the body has
# actually been answered. It validates STRUCTURE, not substrings:
#
#   - a lane only counts when its checkbox is CHECKED (`- [x]`) — a body
#     copied from the PR template with unchecked `- [ ]` lines is refused;
#   - "Decisions made in this PR" needs at least one real (non-placeholder)
#     bullet under it;
#   - "Needs authority" rows are verified against the live decision register
#     (Proof-labs/ProofOfBrain → delivery/decision-register.md): every cited
#     DEC-N row must be Decided, otherwise the PR must be `--draft`;
#   - the org-wide work-in-progress cap (5 ready-for-review pull requests per
#     author: open + non-draft + authored by you + any Proof-labs repo) is
#     counted before a ready PR may be created;
#   - verification failures (network, missing rows, unreadable register,
#     uncountable cap) FAIL CLOSED — the creation is refused with a reason.
#
# Allowed through untouched:
#   - anything that isn't `gh pr create`
#   - .github/open-pr.sh (it runs the same discipline interactively)
#   - `gh pr create --draft` (draft is the parking state; declarations follow)
#
# QUEUE_DISCIPLINE_SKIP="register,cap" skips the two network checks — for
# hook tests only, never in normal use.
#
# Exit 2 = blocking: stderr is shown to the model and the tool call refused.

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"

# Only gh pr create is gated.
printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+pr[[:space:]]+create' || exit 0
# The terminal helper enforces the same discipline itself.
printf '%s' "$cmd" | grep -q 'open-pr\.sh' && exit 0

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
    argv = cmd.split()

# Draft is the parking state — always allowed.
if "--draft" in argv or "-d" in argv:
    sys.exit(0)

# ── extract the body (inline or file) ──
body = None
for i, a in enumerate(argv):
    if a in ("--body", "-b") and i + 1 < len(argv):
        body = argv[i + 1]
    elif a.startswith("--body="):
        body = a[len("--body="):]
    elif a in ("--body-file", "-F") and i + 1 < len(argv):
        try:
            body = open(argv[i + 1]).read()
        except OSError:
            block(f"PR creation blocked: --body-file {argv[i+1]} is unreadable (fail closed).\n\n{HELP}")
    elif a.startswith("--body-file="):
        try:
            body = open(a[len("--body-file="):]).read()
        except OSError:
            block(f"PR creation blocked: body file is unreadable (fail closed).\n\n{HELP}")
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
    # Unchecked template copies and bare DEC-N mentions land here on purpose.
    block(HELP)

if no_dec is not None and (made is not None or needs is not None):
    block("PR creation blocked: contradictory Decisions lanes — 'No decision "
          "required' is checked together with a decisions lane. Check the lanes "
          "that are true and uncheck the rest.")

if made is not None:
    # Require ≥1 real bullet under the made-lane, before the next lane/section.
    real = False
    for l in lines[made + 1:]:
        if re.match(r"^\s*[-*]\s*\[", l) or l.startswith("#"):
            break
        if re.match(r"^\s*[-*]\s+\S", l) and not re.match(r"^\s*[-*]?\s*<!--", l):
            real = True
            break
    if not real:
        block("PR creation blocked: 'Decisions made in this PR' is checked but "
              "lists nothing (or only the template placeholder). List the actual "
              "decisions the work made — that inventory is the point of the lane.")

if needs is not None:
    rows = sorted({int(n) for n in re.findall(r"DEC-(\d+)", body)})
    if not rows:
        block("PR creation blocked: 'Needs authority' is checked but no DEC-N "
              "rows are cited. Cite the register rows (or create stubs via "
              ".github/new-decision-row.py) and use --draft while they are Open.")
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
            block(f"PR creation blocked: could not verify the cited DEC rows against "
                  f"the live register ({e}). Fail closed — retry, or open with --draft.")
        for n in rows:
            m = re.search(rf"^\|\s*DEC-{n}\s*\|.*$", content, re.M)
            if not m:
                block(f"PR creation blocked: DEC-{n} is cited but not in the register. "
                      f"Create the row first (.github/new-decision-row.py) and use --draft.")
            cells = [c.strip() for c in m.group(0).split("|")]
            status = cells[-2] if len(cells) >= 2 else ""
            if not status.startswith("Decided"):
                block(f"PR creation blocked: DEC-{n} is '{status or 'unknown'}', not "
                      f"Decided. A needs-authority PR stays --draft until every cited "
                      f"row is Decided.")

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
        block(f"PR creation blocked: could not count your open ready-for-review "
              f"pull requests ({e}). Fail closed — retry, or open with --draft.")
    if count >= 5:
        block(f"PR creation blocked: work-in-progress cap reached — you already "
              f"have {count} ready-for-review pull requests across Proof-labs "
              f"(cap: 5). Open this one with --draft, or get an open one merged "
              f"or closed first.")

sys.exit(0)
PY
rc=$?
[ "$rc" -eq 0 ] && exit 0
exit 2
