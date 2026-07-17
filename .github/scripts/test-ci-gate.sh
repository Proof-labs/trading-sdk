#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
verifier="$script_dir/verify-ci-gate.sh"
accepted=0
rejected=0

run_verifier() {
  local detector="$1"
  local contract="$2"
  local ts_selected="$3"
  local ts_result="$4"
  local rust_selected="$5"
  local rust_result="$6"
  local python_selected="$7"
  local python_result="$8"
  local format_selected="$9"
  local format_result="${10}"

  env \
    DETECTOR_RESULT="$detector" \
    CONTRACT_RESULT="$contract" \
    TS_SELECTED="$ts_selected" \
    TS_RESULT="$ts_result" \
    RUST_SELECTED="$rust_selected" \
    RUST_RESULT="$rust_result" \
    PYTHON_SELECTED="$python_selected" \
    PYTHON_RESULT="$python_result" \
    FORMAT_SELECTED="$format_selected" \
    FORMAT_RESULT="$format_result" \
    "$verifier"
}

expect_accept() {
  local label="$1"
  shift
  local output

  if ! output="$(run_verifier "$@" 2>&1)"; then
    printf 'expected acceptance for %s, but the verifier rejected it:\n%s\n' \
      "$label" "$output" >&2
    exit 1
  fi
  accepted=$((accepted + 1))
}

expect_reject() {
  local label="$1"
  shift
  local output

  if output="$(run_verifier "$@" 2>&1)"; then
    printf 'expected rejection for %s, but the verifier accepted it:\n%s\n' \
      "$label" "$output" >&2
    exit 1
  fi
  rejected=$((rejected + 1))
}

selection_for_mask() {
  local mask="$1"
  local bit="$2"

  if ((mask & (1 << bit))); then
    printf 'true success'
  else
    printf 'false skipped'
  fi
}

# Every legitimate selection combination must pass: selected suites succeed,
# and unselected suites skip.
for mask in {0..15}; do
  read -r ts_selected ts_result <<<"$(selection_for_mask "$mask" 0)"
  read -r rust_selected rust_result <<<"$(selection_for_mask "$mask" 1)"
  read -r python_selected python_result <<<"$(selection_for_mask "$mask" 2)"
  read -r format_selected format_result <<<"$(selection_for_mask "$mask" 3)"
  expect_accept "valid selection mask $mask" \
    success success \
    "$ts_selected" "$ts_result" \
    "$rust_selected" "$rust_result" \
    "$python_selected" "$python_result" \
    "$format_selected" "$format_result"
done

# Change detection and this contract job are unconditional prerequisites.
for result in failure cancelled skipped neutral timed_out ""; do
  expect_reject "detector result '${result:-<empty>}'" \
    "$result" success \
    false skipped false skipped false skipped false skipped
done
for result in failure cancelled skipped neutral timed_out ""; do
  expect_reject "contract result '${result:-<empty>}'" \
    success "$result" \
    false skipped false skipped false skipped false skipped
done

# Each detector output is an exact boolean, not merely a truthy-looking value.
for suite_index in {0..3}; do
  for invalid in "" TRUE True 1 yes; do
    args=(success success false skipped false skipped false skipped false skipped)
    args[$((2 + suite_index * 2))]="$invalid"
    expect_reject "suite $suite_index selector '${invalid:-<empty>}'" "${args[@]}"
  done
done

# A selected suite can only succeed; in particular, an unexpected skip fails.
for suite_index in {0..3}; do
  for invalid in failure cancelled skipped neutral timed_out ""; do
    args=(success success false skipped false skipped false skipped false skipped)
    args[$((2 + suite_index * 2))]=true
    args[$((3 + suite_index * 2))]="$invalid"
    expect_reject \
      "selected suite $suite_index result '${invalid:-<empty>}'" "${args[@]}"
  done
done

# An unselected suite must be skipped. Unexpected success is also a wiring bug.
for suite_index in {0..3}; do
  for invalid in success failure cancelled neutral timed_out ""; do
    args=(success success false skipped false skipped false skipped false skipped)
    args[$((3 + suite_index * 2))]="$invalid"
    expect_reject \
      "unselected suite $suite_index result '${invalid:-<empty>}'" "${args[@]}"
  done
done

[[ "$accepted" -eq 16 ]] ||
  { echo "expected 16 accepted cases, ran $accepted" >&2; exit 1; }
[[ "$rejected" -eq 80 ]] ||
  { echo "expected 80 rejected cases, ran $rejected" >&2; exit 1; }

echo "CI gate truth table passed: $accepted accepted and $rejected rejected cases."
