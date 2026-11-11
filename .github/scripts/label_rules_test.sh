#!/usr/bin/env bash
# Self-test for label_rules.sh: glob translation, the rules-file schema guard,
# the path-label matcher against a fixture, and the close-reference scan.
# Offline. Run by the label job before it applies anything.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=label_rules.sh
source "$SCRIPT_DIR/label_rules.sh"

failures=0
check() { # <desc> <expected> <actual>
	if [ "$2" = "$3" ]; then
		echo "ok: $1"
	else
		echo "FAIL: $1: want [$2] got [$3]"
		failures=$((failures + 1))
	fi
}

# --- glob_to_case ---
check "leading globstar" '*.md' "$(glob_to_case '**/*.md')"
check "trailing globstar" 'pkg/*' "$(glob_to_case 'pkg/**')"
check "interior globstar" 'a/*/b' "$(glob_to_case 'a/**/b')"
check "bare globstar" '*' "$(glob_to_case '**')"
check "plain glob unchanged" 'docs/*' "$(glob_to_case 'docs/*')"

# --- the repo's own rules file parses (its categories are repo-specific) ---
if rules_from_json "$RULES" >/dev/null 2>&1; then
	echo "ok: repo rules file parses"
else
	echo "FAIL: repo rules file does not parse: $RULES"
	failures=$((failures + 1))
fi

# --- path_labels against a fixture (multi-rule combination) ---
FIXTURE=$(mktemp)
BAD=$(mktemp)
trap 'rm -f "$FIXTURE" "$BAD"' EXIT
cat >"$FIXTURE" <<'EOF'
{"documentation": {"globs": ["**/*.md"]}, "ABI-breaking": {"globs": ["pkg/**"]}}
EOF
check "markdown" documentation "$(printf 'docs/release.md\nsrc/lib.rs\n' | path_labels "$FIXTURE")"
check "crate path" ABI-breaking "$(printf 'pkg/src/lib.rs\n' | path_labels "$FIXTURE")"
check "md anywhere" documentation "$(printf 'a/b/c/README.md\n' | path_labels "$FIXTURE")"
check "rule is case-sensitive" "" "$(printf 'notes.MD\n' | path_labels "$FIXTURE")"
check "plain code -> nothing" "" "$(printf 'core/src/engine.rs\n' | path_labels "$FIXTURE")"
check "empty input -> nothing" "" "$(printf '' | path_labels "$FIXTURE")"
check "one path can earn several labels" "$(printf 'ABI-breaking\ndocumentation')" \
	"$(printf 'pkg/README.md\n' | path_labels "$FIXTURE")"

# --- rules_from_json: schema guard (fail loud, name the rule) ---
echo '{"documentation":{"globs":"**/*.md"}}' >"$BAD"
if rules_from_json "$BAD" >/dev/null 2>&1; then
	echo "FAIL: string globs must fail loud"
	failures=$((failures + 1))
else
	echo "ok: string globs fail loud"
fi
echo '{"documentation":{}}' >"$BAD"
if rules_from_json "$BAD" >/dev/null 2>&1; then
	echo "FAIL: missing globs must fail loud"
	failures=$((failures + 1))
else
	echo "ok: missing globs fail loud"
fi
echo '{"":{"globs":["*"]}}' >"$BAD"
if rules_from_json "$BAD" >/dev/null 2>&1; then
	echo "FAIL: empty label name must fail loud"
	failures=$((failures + 1))
else
	echo "ok: empty label name fails loud"
fi
echo '{"x":{"globs":[""]}}' >"$BAD"
if rules_from_json "$BAD" >/dev/null 2>&1; then
	echo "FAIL: empty glob must fail loud"
	failures=$((failures + 1))
else
	echo "ok: empty glob fails loud"
fi
echo '{"x":{"globs":["/x/**"]}}' >"$BAD"
if rules_from_json "$BAD" >/dev/null 2>&1; then
	echo "FAIL: leading-slash glob must fail loud"
	failures=$((failures + 1))
else
	echo "ok: leading-slash glob fails loud"
fi
echo '{}' >"$BAD"
check "empty rules file is valid (no categories)" "" "$(rules_from_json "$BAD")"
echo '{"x":{"globs":["*"]}}' >"$BAD"
check "minimal valid rules survive the guard" "$(printf 'x\t*')" "$(rules_from_json "$BAD")"

# --- closed_issues ---
check "closes simple" "736" "$(closed_issues 'Closes #736')"
check "keywords are case-insensitive" "736" "$(closed_issues 'closes #736')"
check "colon form" "4" "$(closed_issues 'fixed: #4')"
check "comma list" "$(printf '1\n2\n3')" "$(closed_issues 'closes #1, fixes #2, RESOLVED: #3')"
check "multiline body" "$(printf '1\n2')" "$(closed_issues $'Closes #1\nunrelated text\nResolves #2.')"
check "trailing punctuation" "2" "$(closed_issues 'Resolves #2.')"
check "non-keyword mentions ignored" "" "$(closed_issues $'Related: #5\nsee #6\n#7')"
check "no ref after keyword ignored" "" "$(closed_issues 'fixes future work')"
check "substring keyword not matched" "" "$(closed_issues 'unfixed #3')"
check "cross-repo refs ignored" "" "$(closed_issues 'Closes owner/repo#12')"
check "empty body" "" "$(closed_issues '')"

if [ "$failures" -ne 0 ]; then
	echo "label_rules_test: $failures failing"
	exit 1
fi
echo "label_rules_test: all green"
