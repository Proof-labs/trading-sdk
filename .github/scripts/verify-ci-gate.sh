#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

detector_result="${DETECTOR_RESULT-}"
contract_result="${CONTRACT_RESULT-}"

[[ "$detector_result" == "success" ]] ||
  fail "change detection must succeed (got '${detector_result:-<empty>}')"
[[ "$contract_result" == "success" ]] ||
  fail "the CI gate contract must succeed (got '${contract_result:-<empty>}')"

for suite in TS RUST PYTHON FORMAT; do
  selected_name="${suite}_SELECTED"
  result_name="${suite}_RESULT"
  selected="${!selected_name-}"
  result="${!result_name-}"

  case "$selected" in
    true)
      [[ "$result" == "success" ]] ||
        fail "$suite was selected but did not succeed (got '${result:-<empty>}')"
      ;;
    false)
      [[ "$result" == "skipped" ]] ||
        fail "$suite was not selected but did not skip (got '${result:-<empty>}')"
      ;;
    *)
      fail "$selected_name must be the literal 'true' or 'false' (got '${selected:-<empty>}')"
      ;;
  esac
done

echo "Change detection, the gate contract, and every selected suite passed."
