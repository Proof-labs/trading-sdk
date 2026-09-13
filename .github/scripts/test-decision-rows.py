#!/usr/bin/env python3
"""Run the actual inline workflow programs with synthetic data, no credentials."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/decision-rows.yml").read_text()


def inline_program(step_id):
    """Extract a literal run block; fail loudly if the workflow shape changes."""
    step = WORKFLOW.split(f"        id: {step_id}\n", 1)[1]
    block = step.split("        run: |\n", 1)[1]
    lines = []
    for line in block.splitlines():
        if line and not line.startswith("          "):
            break
        lines.append(line[10:] if line else "")
    program = "\n".join(lines) + "\n"
    compile(program, f"decision-rows.yml:{step_id}", "exec")
    return program


def decision(number, status="Decided"):
    return f"| DEC-{number} | private decision text | {status} |\n"


class DecisionRowsTests(unittest.TestCase):
    def run_program(self, step="validate", body="DEC-162", draft="false",
                    have_app="true", register=None, read_ok="true"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if register is not None:
                path = root / ".decision-register/delivery/decision-register.md"
                path.parent.mkdir(parents=True)
                if isinstance(register, bytes):
                    path.write_bytes(register)
                else:
                    path.write_text(register)
            output = root / "output"
            env = {
                "PATH": os.defpath,
                "PR_BODY": body,
                "PR_DRAFT": draft,
                "HAVE_APP": have_app,
                "REGISTER_READ_OK": read_ok,
                "GITHUB_OUTPUT": str(output),
            }
            result = subprocess.run(
                [sys.executable, "-c", inline_program(step)], cwd=root,
                env=env, text=True, capture_output=True, timeout=10,
            )
            emitted = output.read_text() if output.exists() else ""
            return result.returncode, result.stdout + result.stderr, emitted

    def assert_gate(self, expected, **kwargs):
        code, logs, _ = self.run_program(**kwargs)
        self.assertEqual(code, expected, logs)
        return logs

    def test_draft_does_not_require_credentials_or_register(self):
        self.assert_gate(0, draft="true", have_app="false")

    def test_ready_without_decisions_preserves_no_reference_policy(self):
        self.assert_gate(0, body="Routine CI repair", have_app="false")

    def test_cited_decision_requires_credentials(self):
        self.assert_gate(1, have_app="false", register=decision(162))

    def test_cited_decision_requires_register(self):
        self.assert_gate(1)

    def test_failed_checkout_cannot_pass_with_a_leftover_file(self):
        self.assert_gate(1, read_ok="false", register=decision(162))

    def test_unknown_decision_fails(self):
        self.assert_gate(1, register=decision(163))

    def test_open_blocked_and_malformed_statuses_fail(self):
        for status in ("Open", "Blocked", "Pending", "", "Not Decided"):
            with self.subTest(status=status):
                self.assert_gate(1, register=decision(162, status))

    def test_all_cited_rows_must_be_decided(self):
        self.assert_gate(1, body="DEC-162, DEC-163", register=(
            decision(162) + decision(163, "Open")))

    def test_all_decided_passes(self):
        self.assert_gate(0, body="DEC-162, DEC-163", register=(
            decision(162) + decision(163)))

    def test_markdown_case_and_decision_annotations_preserved(self):
        for status in ("**Decided**", "`DECIDED`", "~~Decided~~", "Decided — approved"):
            with self.subTest(status=status):
                self.assert_gate(0, register=decision(162, status))

    def test_repeated_citation_only_requires_one_row(self):
        self.assert_gate(0, body="DEC-162 and DEC-162", register=decision(162))

    def test_duplicate_register_rows_fail_closed(self):
        self.assert_gate(1, register=decision(162) + decision(162, "Open"))

    def test_invalid_register_encoding_fails_without_leaking_content(self):
        logs = self.assert_gate(1, register=b"private-secret\xff")
        self.assertNotIn("private-secret", logs)
        self.assertNotIn("Traceback", logs)

    def test_invalid_draft_metadata_fails_closed(self):
        for value in ("", "FALSE", "unknown"):
            with self.subTest(value=value):
                self.assert_gate(1, draft=value, body="")

    def test_private_status_and_workflow_commands_are_not_logged(self):
        secret = "private-secret ::error::injected%0A"
        logs = self.assert_gate(1, register=decision(162, secret))
        self.assertNotIn("private-secret", logs)
        self.assertNotIn("injected", logs)
        self.assertNotIn("private decision text", logs)

    def test_pr_body_is_data_not_code_and_is_not_logged(self):
        body = "DEC-162 $(exit 77) `exit 78` ${{ secrets.TEST }} ::error::private-body"
        logs = self.assert_gate(0, body=body, register=decision(162))
        self.assertNotIn("private-body", logs)

    def test_classification_only_requests_needed_register_reads(self):
        for draft, body, expected in (
            ("true", "DEC-162", "false"),
            ("false", "routine repair", "false"),
            ("false", "DEC-162", "true"),
            ("", "DEC-162", "false"),
        ):
            with self.subTest(draft=draft, body=body):
                code, logs, output = self.run_program("classify", body, draft)
                self.assertEqual(code, 0, logs)
                self.assertEqual(output, f"needs_register={expected}\n")

    def test_workflow_trust_boundary(self):
        self.assertNotIn("pull_request_target:", WORKFLOW)
        self.assertNotIn("uses: Proof-labs/.github/", WORKFLOW)
        self.assertIn("contents: read", WORKFLOW)
        self.assertNotRegex(WORKFLOW, r"(?m)^\s+[\w-]+: write\s*$")
        self.assertIn("ready_for_review", WORKFLOW)
        self.assertIn("synchronize", WORKFLOW)
        self.assertEqual(WORKFLOW.count("uses: actions/checkout@"), 1)
        self.assertIn("repository: Proof-labs/ProofOfBrain", WORKFLOW)
        self.assertIn("sparse-checkout: delivery/decision-register.md", WORKFLOW)
        self.assertIn("persist-credentials: false", WORKFLOW)
        self.assertIn("permission-contents: read", WORKFLOW)
        self.assertIn("steps.vault-token.outcome == 'success'", WORKFLOW)
        self.assertIn("steps.register-checkout.outcome == 'success'", WORKFLOW)
        self.assertNotIn("skip-token-revoke:", WORKFLOW)
        self.assertNotIn("actions/upload-artifact", WORKFLOW)
        final_step = WORKFLOW.split("      - name: Validate the cited decision rows", 1)[1]
        self.assertNotIn("continue-on-error", final_step)
        self.assertNotIn("        if:", final_step)
        for name in ("classify", "validate"):
            self.assertNotIn("${{", inline_program(name))

    def test_regression_suite_is_wired_to_always_running_gate(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        contract = ci.split("  gate-contract:\n", 1)[1].split("\n  ts:", 1)[0]
        self.assertIn("python3 .github/scripts/test-decision-rows.py", contract)
        self.assertNotIn("\n    if:", contract)


if __name__ == "__main__":
    unittest.main(verbosity=2)
