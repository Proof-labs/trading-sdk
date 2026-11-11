#!/usr/bin/env python3
"""Canonical-vocabulary lint (warn-only until the wire renames land).

Synced to every Proof-labs repository from Proof-labs/.github
(templates/agent-config/.github/vocabulary_lint.py). The rule it enforces is
DEC-149 (ProofOfBrain, engine/canonical-vocabulary.md): the engine's PascalCase
action name is the word everywhere, the product words are Event / Conditional /
Perpetual and "prediction binary", the Proof liquidity provider is the PLP, and
a fixed list of older words is retired.

What it checks, on the files given as arguments (or every tracked text file):

1. Retired prose terms ("impact market", "conditional market", "unwind", ...)
   in any text, code comment, docstring, screen string or Markdown. Wire
   identifiers such as `impact_market_id`, `CreateImpactMarket` or
   `ImpactMarketInfo` are legacy names, not prose, and are never matched:
   only the spaced or hyphenated forms are.
2. Renamed names (rule N1 and the N5 branch outcomes). A JSON `type` value
   that is an old action or frame name (`"type": "cancelReplace"`, where the
   name is now `cancelReplaceOrder`), and any quoted old event name
   (`"conditional_settled"`, now `"condition_met"`). The renames come from the
   manifest's `planned_renames` and `event_renames` plus a built-in list for
   the gateway's own JSON and frame names, which the manifest does not carry.

A line containing `vocabulary-lint: allow` is skipped (an old name kept on
purpose, for example to decode stored history); a file containing
`vocabulary-lint: allow-file` is skipped whole.

The source of truth is `protocol-allocations.json` in Proof-labs/exchange
(section `vocabulary`). The CI job checks it out at `dev` and passes its
path via VOCABULARY_MANIFEST. Without it the script falls back to the
built-in lists and says so. VOCABULARY_BUILTIN_ONLY=1 uses the built-in
lists without looking for a manifest: the mode for public repositories,
which have no credential to read the exchange.

Exit status: 0 always, unless VOCABULARY_LINT_STRICT=1, in which case any
finding fails the run. Findings are emitted as GitHub Actions annotations.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

FALLBACK_RETIRED = (
    "impact market",
    "impact-market",
    "impact family",
    "event family",
    "conditional market",
    "conditional-market",
    "event market",
    "event binary",
    "unwind",
    "HLP",
    "Strawberry",
    "LP vault",
    "liquidity-provider vault",
    "liquidity provider vault",
)
# Old name -> new name. The gateway's JSON action types and WebSocket frame
# types are its own surface, not engine names, so the manifest never lists
# them; the N5 event renames are also in the manifest's `event_renames`.
FALLBACK_TYPE_RENAMES = {
    "order": "placeOrder",
    "cancel": "cancelOrder",
    "cancelReplace": "cancelReplaceOrder",
    "account_event": "accountEvent",
    "order_update": "orderUpdate",
    "position_update": "positionUpdate",
    "trigger_update": "triggerUpdate",
    "margin_update": "marginUpdate",
    "account_events": "accountEvents",
}
FALLBACK_EVENT_RENAMES = {
    "conditional_settled": "condition_met",
    "conditional_voided": "condition_not_met",
}
ALLOW_LINE = "vocabulary-lint: allow"
ALLOW_FILE = "vocabulary-lint: allow-file"
TEXT_SUFFIXES = {
    ".rs", ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".md", ".mdx",
    ".yaml", ".yml", ".json", ".toml", ".sql", ".html", ".css", ".txt", ".sh",
}
SKIP_PARTS = {
    ".git", "node_modules", "target", "dist", "build", ".next", "vendor",
    "__pycache__", ".venv", "venv", "pnpm-lock.yaml", "package-lock.json",
    "Cargo.lock", "go.sum", "CHANGELOG.md", ".vocabulary-manifest",
}
# Files whose subject is the vocabulary itself, or a historical record.
EXEMPT_NAMES = {"vocabulary_lint.py", "canonical-vocabulary.md", "protocol-allocations.json"}


class Vocabulary(NamedTuple):
    retired: list[str]
    type_renames: dict[str, str]
    event_renames: dict[str, str]
    source: str


def lower_camel(name: str) -> str:
    return name[:1].lower() + name[1:]


def builtin(source: str) -> Vocabulary:
    return Vocabulary(list(FALLBACK_RETIRED), dict(FALLBACK_TYPE_RENAMES), dict(FALLBACK_EVENT_RENAMES), source)


def load_manifest() -> Vocabulary:
    if os.environ.get("VOCABULARY_BUILTIN_ONLY") == "1":
        return builtin("built-in list (public repository)")
    path = os.environ.get("VOCABULARY_MANIFEST", "")
    if path and Path(path).is_file():
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            vocab = data.get("vocabulary", {})
            retired = list(vocab.get("retired_terms") or FALLBACK_RETIRED)
            types = dict(FALLBACK_TYPE_RENAMES)
            for old, r in (vocab.get("planned_renames") or {}).items():
                if r.get("json_type"):
                    types[lower_camel(old)] = r["json_type"]
            events = dict(FALLBACK_EVENT_RENAMES)
            for r in (vocab.get("event_renames") or {}).values():
                if r.get("emitted_from") and r.get("emitted_to"):
                    events[r["emitted_from"]] = r["emitted_to"]
            return Vocabulary(retired, types, events, f"manifest {path}")
        except (OSError, ValueError, AttributeError) as e:  # pragma: no cover
            print(f"::notice::vocabulary manifest unreadable ({e}); using the built-in lists")
    else:
        print("::notice::no vocabulary manifest available; using the built-in lists")
    return builtin("built-in list")


def tracked_files() -> list[Path]:
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout
    return [Path(p.decode()) for p in out.split(b"\0") if p]


def wanted(p: Path) -> bool:
    if p.suffix.lower() not in TEXT_SUFFIXES:
        return False
    if p.name in EXEMPT_NAMES:
        return False
    return not any(part in SKIP_PARTS for part in p.parts)


def alternation(names) -> str:
    return "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))


def main(argv: list[str]) -> int:
    vocab = load_manifest()
    retired, source = vocab.retired, vocab.source
    def plural(t: str) -> str:
        return re.escape(t[:-1]) + "(?:y|ies)" if t.endswith("y") else re.escape(t) + "s?"

    retired_re = re.compile(r"(?<![\w-])(" + "|".join(plural(t) for t in retired) + r")(?![\w-])", re.I)
    # `"type": "order"`, `type: 'cancel'`, `{"stream":"account_events"}`: the value of a
    # `type` or `stream` key, in JSON, JavaScript, TypeScript, Python or YAML.
    type_re = re.compile(r"""(?<![\w-])["']?(?:type|stream)["']?\s*[:=]\s*["'](""" + alternation(vocab.type_renames) + r""")["']""")
    event_re = re.compile(r"""["'](""" + alternation(vocab.event_renames) + r""")["']""")
    paths = [Path(a) for a in argv] if argv else tracked_files()
    paths = [p for p in paths if p.is_file() and wanted(p)]
    findings: list[tuple[str, int, str]] = []
    for p in paths:
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if ALLOW_FILE in text:
            continue
        seen: set[str] = set()
        for i, line in enumerate(text.splitlines(), 1):
            if ALLOW_LINE in line:
                continue
            for regex, renames, what in ((type_re, vocab.type_renames, "JSON type"),
                                         (event_re, vocab.event_renames, "event name")):
                for m in regex.finditer(line):
                    old = m.group(1)
                    findings.append((p.as_posix(), i, f'renamed {what} "{old}": write "{renames[old]}" (the canonical vocabulary, DEC-149)'))
            # In Markdown a retired word inside a code span is a quotation, not a
            # use. In JavaScript and TypeScript a backtick delimits a template
            # literal, which IS a screen string, so nothing is stripped there.
            if p.suffix.lower() in {".md", ".mdx"}:
                line = re.sub(r"`[^`]*`", "", line)
            for m in retired_re.finditer(line):
                term = re.sub(r"(?:ie)?s$", lambda k: "y" if k.group(0) == "ies" else "", m.group(1).lower())
                if term in seen:
                    continue
                seen.add(term)
                findings.append((p.as_posix(), i, f'retired term "{term}" (see the canonical vocabulary: Event / Conditional / Perpetual / prediction binary / PLP)'))
    for path, line, msg in findings:
        print(f"::warning file={path},line={line}::{msg}")
    strict = os.environ.get("VOCABULARY_LINT_STRICT") == "1"
    print(f"\nvocabulary-lint: {len(findings)} finding(s) across {len(paths)} file(s), vocabulary from {source}, mode {'strict' if strict else 'warn-only'}.")
    return 1 if (findings and strict) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
