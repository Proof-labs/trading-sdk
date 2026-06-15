# Proof-labs working agreement (GitHub Copilot)

Synced from `Proof-labs/.github` (`templates/agent-config/.github/copilot-instructions.md`). Same policy lives in `AGENTS.md`, `CLAUDE.md`, and `.cursorrules`.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy

Before any code suggestion that would be committed:

1. The current branch must be either `W##-NN/<slug>` (ticket work) or `<type>/<slug>` (non-ticket work, where `<type>` ∈ `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`).
2. `main`, `dev`, `develop`, `master` are blocked for direct commits org-wide.
3. For ticket work, the corresponding board card lives at `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → heading `### W##-NN — <title>`.

## Pull-request policy

When you open a PR, set the optional **Task link** in the PR body — ask once if you don't already know it:

- `W##-NN` (ProofOfBrain board card)
- `BE-##` (Linear ticket)
- No — free-styling for now

Free text is fine. The `Board item / validate` workflow is **advisory only — it never blocks a merge**. From the terminal, `bash .github/open-pr.sh` asks the same question, then runs `gh pr create`.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Org-level config: `Proof-labs/.github`

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->
<!-- Add repo-specific Copilot instructions below this line. -->
