# Proof Trading SDK — agent & contributor guide

Tool-agnostic guidance for AI agents (Aider, Codex CLI, Continue, Cursor, and
anything following the `AGENTS.md` convention) and human contributors alike.
Claude Code reads `CLAUDE.md`; the policy is the same.

## Branching & pull requests

1. Branch off `main` using `<type>/<slug>`, where `<type>` is one of `chore`,
   `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`. Never commit directly
   to `main`.
2. Keep each PR to a single logical change, and add a test with every behaviour
   change.
3. Title each PR with one Conventional Commits prefix.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. Report security
vulnerabilities privately via the repository Security tab — never in a public
issue or PR (see [SECURITY.md](SECURITY.md)).

<!-- repo-specific -->
<!-- Add repo-specific agent instructions below this line. -->
