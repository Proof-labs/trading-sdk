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

## Pull-request queue discipline

- **Decision-bearing pull requests stay draft.** If merging the PR requires a product, economic, or organisational decision (a new policy, a parameter set, an ownership assignment, release authority), reference its `DEC-N` rows from `Proof-labs/ProofOfBrain` → `delivery/decision-register.md` in the PR body and keep the PR **draft** until every linked row is Decided. **Re-scan at PR time** — decisions usually only become visible at the end of the work: before `gh pr create`, re-read the full branch diff and fill the template's **Decisions** section as an inventory: decisions **made** during the work (routine engineering calls — list them, they are reviewed in this PR) and decisions **needing authority** (→ register rows + draft). A `PreToolUse` hook enforces this structurally on every ready-for-review `gh pr create`: the body's Decisions section needs a **checked** lane (`- [x]`) — "No decision required", a made-list with at least one real bullet, or "Needs authority" with rows the hook verifies are **Decided** in the live register (still-Open rows require `--draft`) — and the org-wide 5-ready work-in-progress cap is counted at creation. Verification failures fail closed. `--draft` always passes. **If no row exists yet, create the stub first**: answer `open-pr.sh`'s decision prompt with a one-line description (it allocates the next `DEC-N` and opens the register pull request for you, via `.github/new-decision-row.py`), or append the row yourself via a small ProofOfBrain pull request into `dev` on branch `add/dec-N-<slug>` — then link both pull requests. Decisions are made in the weekly decision moment, not argued in review threads.
- **Work-in-progress cap.** Each author keeps at most **5 pull requests in ready-for-review across the whole organisation**. Further output opens as **draft** (or as an issue) until a slot frees.

## Scope: one logical change per PR

Each PR does exactly one logical change — one concern, one Conventional Commits type
(`feat` / `fix` / `refactor` / `style` / `chore` / `docs` / `test` / `perf`). Never bundle a
feature with a fix, or a behaviour change with a structural one (refactor, rename,
reformat, lint). If a request mixes concerns, make the change but split it into separate
PRs by type, and tell the user which split you made and why. Full rule: `Proof-labs/.github`
→ `CONTRIBUTING.md`.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Org-level config: `Proof-labs/.github`

## Network policy — gateway only (client-facing code)

All client traffic — SDKs, frontends, bots, scripts — goes through the **API gateway**. The CometBFT RPC (`:26657`) and the node REST API (`:8080` / `:1317`) are internal upstreams the gateway fronts; they are **never** client targets and may be firewalled off in production.

- **Through the SDK, never hand-rolled HTTP.** The gateway is the *network* boundary; the Proof SDK (`@proof/trading-sdk`, source of truth `exchange/sdk`) is the *client* boundary. Application code — frontends, bots, scripts, services — calls the SDK for every gateway interaction; it never hand-rolls `POST /exchange` bodies, signing, nonces / sequence numbers, or wire codecs against the gateway. If the SDK lacks a method for a gateway route, add the SDK method first, then consume it — same pattern as the gateway rule below. Exceptions: the SDK's own transport internals, and contract tests that deliberately pin the raw route / request shape (e.g. proof-integration scenarios).
- **Default to the gateway.** A direct-to-node path may exist only as an explicit, non-default opt-out (e.g. `useGateway: false`) for in-cluster tools (market-makers, HLP, oracle feeder, test harness) — never the public default, never documented for external callers.
- **Never hardcode or default to** node ports (`:26657`, `:8080`, `:1317`), raw CometBFT methods (`/status`, `/block`, `/tx?hash=`, `broadcast_tx_*`), or a node mode (`apiMode: 'node'`). Use the gateway surface: `POST /exchange`, `POST /info`, `GET /v1/*`, `/v1/tx/{hash}`, `/v1/status`, `/ws`.
- **If the gateway doesn't serve a read you need, add the gateway route first**, then consume it — do not reach past the gateway to the node.
- Scope: client-facing code only. Does **not** apply to the gateway itself or to node / infra repos, which legitimately talk to the node.

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->
<!-- Add repo-specific Copilot instructions below this line. -->
