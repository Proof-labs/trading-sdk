#!/usr/bin/env python3
"""Create a stub row in the Proof decision register via the GitHub API.

Called by open-pr.sh when the author answers the decision prompt with a
free-text description instead of existing DEC-N row ids. Needs no local
ProofOfBrain checkout — everything happens through `gh api`.

Synced from Proof-labs/.github (templates/agent-config/.github/new-decision-row.py).

Env:
  DEC_DESC      one-line decision description (required)
  DEC_SRC       source text for the register's Source column (required)
  DEC_TYPE      Product | Economic | Organisational | Release | Engineering-design
                (default: Product)
  DEC_PRIORITY  Critical | High | Medium | Low (default: Medium). Sets the
                decide-by date: Critical = today (ASAP), High = +3 working
                days, Medium = +10 working days, Low = +30 calendar days.
  DEC_REF       register ref to read (default: dev)
  DEC_DRY       set to 1 to compute the next id and stop before any write

Output (last line, tab-separated): DEC-<n>\t<register pull-request url>
"""
import base64
import datetime
import json
import os
import re
import subprocess
import sys

REPO = "Proof-labs/ProofOfBrain"
PATH = "delivery/decision-register.md"
ANCHOR = "\n\n## Dependency-ordered agenda"

TYPES = {"p": "Product", "e": "Economic", "o": "Organisational",
         "r": "Release", "d": "Engineering-design"}
PRIORITIES = ("Critical", "High", "Medium", "Low")


def add_working_days(d, n):
    while n > 0:
        d += datetime.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def decide_by(priority):
    today = datetime.date.today()
    if priority == "Critical":
        return f"Critical — ASAP ({today.isoformat()})"
    if priority == "High":
        return f"High — by {add_working_days(today, 3).isoformat()}"
    if priority == "Medium":
        return f"Medium — by {add_working_days(today, 10).isoformat()}"
    return f"Low — by {(today + datetime.timedelta(days=30)).isoformat()}"


def normalise_type(raw):
    raw = raw.strip()
    if not raw:
        return "Product"
    key = raw[0].lower()
    for full in TYPES.values():
        if raw.lower() == full.lower():
            return full
    return TYPES.get(key, "Product")


def normalise_priority(raw):
    raw = raw.strip()
    if not raw:
        return "Medium"
    for p in PRIORITIES:
        if raw.lower() in (p.lower(), p[0].lower()):
            return p
    return "Medium"


def gh(*args, stdin=None):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, input=stdin)
    if r.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}… failed: {r.stderr.strip()}")
    return r.stdout


def main():
    desc = os.environ.get("DEC_DESC", "").strip()
    src = os.environ.get("DEC_SRC", "").strip() or "unspecified"
    ref = os.environ.get("DEC_REF", "dev").strip()
    dry = os.environ.get("DEC_DRY", "") == "1"
    if not desc:
        sys.exit("DEC_DESC is required")
    # keep the markdown table intact
    desc = desc.replace("|", "/").replace("\n", " ").strip()
    src = src.replace("|", "/").strip()
    dtype = normalise_type(os.environ.get("DEC_TYPE", ""))
    prio = normalise_priority(os.environ.get("DEC_PRIORITY", ""))
    prio_cell = decide_by(prio)

    try:
        f = json.loads(gh("api", f"repos/{REPO}/contents/{PATH}?ref={ref}"))
    except RuntimeError as e:
        sys.exit(
            f"could not read the register at {REPO}:{PATH}@{ref} — "
            f"is ProofOfBrain#330 merged yet? ({e})"
        )
    content = base64.b64decode(f["content"]).decode()
    if ANCHOR not in content:
        sys.exit("register format changed: agenda anchor not found — add the row manually")

    ids = [int(m) for m in re.findall(r"\|\s*DEC-(\d+)\s*\|", content)]
    # ids reserved by open register pull requests (branch convention add/dec-N-*)
    try:
        prs = json.loads(gh("api", f"repos/{REPO}/pulls?state=open&per_page=100"))
        for p in prs:
            m = re.match(r"add/dec-(\d+)-", p["head"]["ref"])
            if m:
                ids.append(int(m.group(1)))
    except RuntimeError:
        pass  # collision would be caught at merge; proceed with what we have
    n = max(ids) + 1 if ids else 1

    slug = re.sub(r"[^a-z0-9]+", "-", desc.lower())[:40].strip("-") or "new-decision"
    branch = f"add/dec-{n}-{slug}"
    stub_txt = (
        f"**{desc}** (stub — refine decider and dependencies at the "
        f"weekly decision moment)."
    )
    # Register v2 has Type + Priority columns; sniff the header so rows stay
    # valid whichever format is live on the ref.
    v2 = "| Type | Priority" in content
    if v2:
        row = (
            f"| DEC-{n} | {stub_txt} | {dtype} | {prio_cell} "
            f"| {src} | Ramon (confirm) | — | Open |"
        )
    else:
        row = (
            f"| DEC-{n} | {stub_txt} ({dtype}; {prio_cell}) "
            f"| {src} | Ramon (confirm) | — | Open |"
        )

    if dry:
        fmt = "v2 (Type/Priority columns)" if v2 else "v1 (folded into text)"
        print(f"dry-run: next id DEC-{n}, branch {branch}, {dtype}, {prio_cell}, format {fmt}")
        print(f"DEC-{n}\t(dry-run)")
        return

    new_content = content.replace(ANCHOR, "\n" + row + ANCHOR, 1)

    dev_sha = json.loads(gh("api", f"repos/{REPO}/git/ref/heads/dev"))["object"]["sha"]
    gh("api", f"repos/{REPO}/git/refs", "-f", f"ref=refs/heads/{branch}", "-f", f"sha={dev_sha}")
    payload = json.dumps(
        {
            "message": f"docs(delivery): DEC-{n} stub — {desc[:60]}",
            "content": base64.b64encode(new_content.encode()).decode(),
            "sha": f["sha"],
            "branch": branch,
        }
    )
    gh("api", "-X", "PUT", f"repos/{REPO}/contents/{PATH}", "--input", "-", stdin=payload)
    url = gh(
        "pr", "create", "-R", REPO, "--base", "dev", "--head", branch,
        "--title", f"docs(delivery): DEC-{n} stub — {desc[:50]}",
        "--body",
        (
            f"Stub decision row auto-created from {src} via `open-pr.sh`.\n\n"
            f"> {desc}\n>\n> Type: {dtype} · Priority: {prio_cell}\n\n"
            "Refine the decider and dependencies at the weekly decision moment; "
            "the originating pull request stays **draft** until this row is Decided.\n\n"
            "Task link: No — decision-register stub."
        ),
    ).strip().splitlines()[-1]
    print(f"DEC-{n}\t{url}")


if __name__ == "__main__":
    main()
