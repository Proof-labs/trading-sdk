#!/usr/bin/env bash
# Labels a pull request from the org templates in
# `templates/agent-config/.github/`:
#
#   1. `critical` inherited from a same-repo issue the PR body closes and that
#      carries the `critical` label — the behavioural rule a path matcher cannot
#      express. Closing keywords: `close[sd]` / `fix(es|ed)` / `resolve[sd]`,
#      optional colon, comma list, same line; cross-repo refs ignored. A PR that
#      closes a critical issue is itself critical, so the label tracks the
#      change's blast radius through to the pull request.
#   2. Path categories from `.github/label-rules.json` (label -> globs, matched
#      case-sensitively), optional and repo-specific — the default template file
#      defines none. Adding a category is a JSON edit, no code.
#
# Labels are additive — a label is added, never removed. GitHub errors fail the
# run: a silent mislabel is worse than a red step (an inherited `critical` label
# already exists on the issue, so inheriting it can never 422 on a missing
# label; a path category the repo has not created yet will).
#
# Usage: label_rules.sh [--dry-run] <pr>   (GH_REPO=OWNER/REPO, GH_TOKEN set)

set -euo pipefail

CLOSES='\b(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]*:?[[:space:]]+(#[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+)([[:space:]]*,[[:space:]]*(#[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+))*'
REF='(#[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+)'
RULES=${LABEL_RULES:-"$(cd "${BASH_SOURCE[0]%/*}" && pwd)/../label-rules.json"}

# One extraction expression, used both for the loud pre-flight in main and
# inside path_labels: any category present must carry a non-empty globs array,
# named on failure. Zero categories is valid — the behavioural rule stands alone.
EXTRACT='to_entries
	| .[] | .key as $l
	| if ($l | length) == 0 then error("rules contain an empty label name") else . end
	| .value.globs as $g
	| if ($g | type) != "array" or ($g | length) == 0
	  then error("label \($l): globs must be a non-empty array")
	  else $g[] end
	| if . == "" then error("label \($l): globs entries must be non-empty") else . end
	| if startswith("/") then error("label \($l): glob \(.) must not start with \"/\"") else . end
	| [$l, .] | @tsv'

rules_from_json() { # $1 = rules json -> "label<TAB>glob" lines; loud on schema abuse
	# No `-e`: an empty rules file is valid and produces no rows, while a
	# schema violation still exits non-zero through `error()`.
	jq -r "$EXTRACT" "$1"
}

glob_to_case() { # minimatch-style glob -> bash case pattern ('*' crosses '/')
	local p=$1
	p=${p//\/\*\*\//\/\*\/}                       # a/**/b   -> a/*/b
	[[ $p == *\/\*\* ]] && p=${p%\/\*\*}'/*'    # x/**     -> x/*
	[[ $p == \*\*\/?* ]] && p=${p#\*\*/}        # **/*.md  -> *.md
	p=${p//\*\*/\*}                         # leftover -> *
	printf '%s' "$p"
}

path_labels() { # $1 = rules json; filenames on stdin -> labels on stdout
	local -a rules=() files=()
	local f label pat i
	while IFS=$'\t' read -r label pat; do
		rules+=("$label" "$(glob_to_case "$pat")")
	done < <(rules_from_json "$1")
	while IFS= read -r f; do files+=("$f"); done
	for ((i = 0; i < ${#rules[@]}; i += 2)); do
		label=${rules[i]} pat=${rules[i + 1]}
		for f in "${files[@]}"; do
			case "$f" in $pat) echo "$label" ;; esac
		done
	done | sort -u
}

closed_issues() { # body -> same-repo issue numbers it closes
	printf '%s\n' "$1" | grep -Eio "$CLOSES" | grep -Eo "$REF" | grep -v '/' | tr -d '#' | sort -nu || true
}

usage() { echo "usage: label_rules.sh [--dry-run] <pr>" >&2; exit 2; }

main() {
	local dry=0 pr="" a n
	for a in "$@"; do
		case "$a" in --dry-run) dry=1 ;; *) pr="$a" ;; esac
	done
	[[ "$pr" =~ ^[0-9]+$ ]] || usage
	[ $# -le 2 ] || usage
	local base
	base="repos/${GH_REPO:?GH_REPO must be set (OWNER/REPO)}"
	# A rules file that cannot be read or parsed would otherwise fail inside
	# the path_labels process substitution, where its error is swallowed and
	# the run degrades to "no labels" silently.
	[ -r "$RULES" ] || { echo "label_rules: rules file not readable: $RULES" >&2; exit 1; }
	rules_from_json "$RULES" >/dev/null \
		|| { echo "label_rules: invalid rules file: $RULES" >&2; exit 1; }

	local have want files
	have=$(gh pr view "$pr" --repo "$GH_REPO" --json labels --jq '[.labels[].name] | .[]')
	files=$(gh api "$base/pulls/$pr/files" --paginate --jq '.[].filename')
	want=$(printf '%s\n' "$files" | path_labels "$RULES")
	[ "$(printf '%s\n' "$files" | sed '/^$/d' | wc -l)" -lt 300 ] \
		|| echo "::warning::pull request touches the files API cap (300): labels may be incomplete" >&2
	for n in $(closed_issues "$(gh pr view "$pr" --repo "$GH_REPO" --json body --jq '.body // ""')"); do
		gh api "$base/issues/$n" --jq '[.labels[].name]' | grep -q '"critical"' && want+=$'\ncritical'
	done

	local add
	add=$(printf '%s\n' "$want" | sed '/^$/d' | sort -u | grep -Fxvf <(printf '%s\n' "$have") | paste -sd, - || true)
	[ -n "$add" ] || { echo "pr #$pr: current"; exit 0; }
	[ "$dry" = 1 ] && { echo "pr #$pr: would add $add"; exit 0; }
	gh pr edit "$pr" --repo "$GH_REPO" --add-label "$add" >/dev/null
	echo "pr #$pr: + $add"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	main "$@"
fi
