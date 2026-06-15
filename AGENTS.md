# Proof-labs working agreement (any AI agent)

Tool-agnostic agent instructions, synced from `Proof-labs/.github` (`templates/agent-config/AGENTS.md`). Read by Aider, Codex CLI, Continue, Cursor (newer), and any agent that follows the AGENTS.md convention. Claude Code reads `CLAUDE.md` separately but the policy is identical.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced where possible)

Before any code edit:

1. Ask the user what this work is: a **ProofOfBrain board card** (`W##-NN`, e.g. `W20-04`), a **Linear ticket** (`BE-##`), or **ad-hoc**.
2. Create a branch with the correct prefix:
   - **ProofOfBrain card:** `W##-NN/<short-kebab-slug>` (e.g. `W20-04/known-limitations`)
   - **Linear ticket or ad-hoc:** `<type>/<slug>` where `<type>` ∈ `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`. A Linear ticket rides a `<type>/` branch and is attached at PR time, not in the branch name.
3. For a ProofOfBrain card, read the board card before editing: `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → `### W##-NN — <title>`.
4. Confirm scope with the user before editing.

`main`, `dev`, `develop`, `master` are blocked for direct edits (org-wide ruleset).

## Pull-request policy

When you open a pull request, set the **Task link** in the PR body — optional, but ask by default:

1. If the user already named a ticket for this work (a ProofOfBrain card `W##-NN` or a Linear ticket `BE-##`), use it — don't ask again.
2. Otherwise ask once: *"Is this part of a ProofOfBrain board card (`W##-NN`), a Linear ticket (`BE-##`), or free-styling for now?"*
3. Fill the matching line in the template's **Task link** section (or mark "No — free-styling"). Free text is fine.

From the terminal you can use the helper `bash .github/open-pr.sh`, which asks the same question and then runs `gh pr create`. The `Board item / validate` workflow is **advisory only — it never blocks a merge**.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Org-level config (this file, validator workflow, rulesets): `Proof-labs/.github`

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->
<!-- Add repo-specific agent instructions below this line. -->

