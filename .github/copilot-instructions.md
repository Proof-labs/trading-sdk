# Proof-labs working agreement (GitHub Copilot)

Synced from `Proof-labs/.github` (`templates/agent-config/.github/copilot-instructions.md`). Same policy lives in `AGENTS.md`, `CLAUDE.md`, and `.cursorrules`.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy

Before any code suggestion that would be committed:

1. The current branch must be either `W##-NN/<slug>` (ticket work) or `<type>/<slug>` (non-ticket work, where `<type>` ∈ `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`). If the work closes a GitHub issue, its number leads the name — `GH<issue>/W##-NN/<slug>` or `GH<issue>/<type>/<slug>` (e.g. `GH98/fix/oracle-source-vectors`) — and the PR body carries `Closes #<issue>`.
2. `main`, `dev`, `develop`, `master` are blocked for direct commits org-wide.
3. For ticket work, the corresponding board card lives at `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → heading `### W##-NN — <title>`.

## Pull-request policy

When you open a PR, set the optional **Task link** in the PR body — ask once if you don't already know it:

- `W##-NN` (ProofOfBrain board card)
- `BE-##` (Linear ticket)
- No — free-styling for now

Free text is fine. The `Board item / validate` workflow is **advisory only — it never blocks a merge**. From the terminal, `bash .github/open-pr.sh` asks the same question, then runs `gh pr create`.

## Linked GitHub issues and labels

Work that closes a GitHub issue names it in both places: the branch leads with `GH<issue>/`
and the PR body carries `Closes #<issue>` (see the branching and pull-request policy above).

**A pull request inherits the labels of the issue it closes.** In particular, a PR that
closes a `critical` issue is itself `critical`: the label records the change's blast radius,
and the closing keyword in the PR body is the signal (`close[sd]` / `fix(es|ed)` /
`resolve[sd]`, optional colon, comma lists, same-repo refs; cross-repo refs are ignored).
Labels are additive and never removed; a GitHub API error fails the run rather than
mislabeling silently. The org ships this as a copyable GitHub Actions workflow —
`.github/workflows/label.yml` with `.github/scripts/label_rules.sh` and its self-test;
`.github/label-rules.json` is an optional per-repo list of path-based label categories.
`scripts/sync-agent-config.sh` in `Proof-labs/.github` distributes them.

## Pull-request queue discipline

- **Draft means the author is not requesting review yet.** Authors choose draft independently of pending decisions.
- **Pending decisions block merge, not review.** If merging requires a product, economic, organisational, or release decision, cite its `DEC-N` rows from `Proof-labs/ProofOfBrain` → `delivery/decision-register.md`. Review and discuss the proposal in the PR; the authorised decision owner records the outcome in the register. Do not merge until every cited row is Decided.
- **Re-scan at PR time.** Re-read the full branch diff and fill the **Decisions** section: no decision required, routine engineering decisions made (with a real list), or decisions needing authority (with register rows). The PR-creation hook validates this declaration, not decision status. If no row exists, use `.github/new-decision-row.py` or `open-pr.sh --new-decision` to create a stub and link it.
- **Merge check.** `Decision rows` fails for missing or undecided cited rows, an unreadable register, or a checked “Needs authority” declaration without rows. It does not change draft status. Require `decision-rows / validate` in branch protection for enforcement; after the register changes, re-run the check before merging.

## Scope: one logical change per PR

Each PR does exactly one logical change — one concern, one Conventional Commits type
(`feat` / `fix` / `refactor` / `style` / `chore` / `docs` / `test` / `perf`). Never bundle a
feature with a fix, or a behaviour change with a structural one (refactor, rename,
reformat, lint). If a request mixes concerns, make the change but split it into separate
PRs by type, and tell the user which split you made and why. Full rule: `Proof-labs/.github`
→ `CONTRIBUTING.md`.

## Binary artifacts and large files (never commit)

Never stage or commit any file **at or over 1 MiB** into a Proof repo — video, audio,
images, archives, design exports, model weights, datasets. Blobs that reach `dev` or
`main` are permanent: the org ruleset forbids force-pushing protected branches, so the
payload bloats every future clone forever.

- **Small assets referenced from docs (under 1 MiB) are fine** — the vault convention
  deliberately allows images and PDFs next to their notes.
- **Larger assets** go through **Git LFS** (`git lfs track '<pattern>'`, commit
  `.gitattributes`, then add the file — LFS pointers pass every check) or are hosted
  externally and referenced by URL.
- **Already staged?** `git rm --cached <file>` (amend if not yet pushed). Never push
  first and clean up later — removing a pushed blob needs a history rewrite.
- Enforcement: the Claude Code `pre-tool-use` hook blocks oversized `git add`; the
  `No large binaries` CI check (opt-in per repo) enforces the same threshold on PRs.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Org-level config: `Proof-labs/.github`

## Naming policy — one canonical vocabulary (DEC-149)

One name per function and entity, in every repository, screen, document and vault note (ProofOfBrain → `engine/canonical-vocabulary.md`; machine-readable in Proof-labs/exchange → `protocol-allocations.json`, section `vocabulary`).

- **The engine's PascalCase action name is the word** (`CreateMarket`, `CreateEvent`, `OracleUpdate`). Code identifiers use it unchanged. The gateway's JSON `type` is its lowerCamel form (`createMarket`) and nothing else; emitted events are the same words in snake-case past tense (`market_created`); prose and screen text write the same words with spaces ("Create market"). Never a synonym.
- **Product words:** **Event** (the question, its Yes/No prediction binaries, its resolution), **Conditional** (one perpetual attached to one event), **Perpetual**. The Yes/No books are **prediction binaries**.
- **The Proof liquidity provider is the PLP.** Spell it out once per document as "Proof liquidity provider (PLP)", then write PLP. It is the protocol's liquidity-provider account and the market maker that trades it, one entity under one name. Never `HLP`, never `Strawberry`, and never `the vault`, `LP vault` or `liquidity-provider vault` for it. Identifiers follow the same word (`PlpConfig`, `plp_absorbed`).
- **Retired words** — do not write them in new code comments, screen strings, docs or notes: `impact market`, `impact family`, `event family`, `conditional market`, `event market`, `event binary`, `unwind`, `HLP`, `Strawberry`, `LP vault`, `liquidity-provider vault`. Legacy identifiers (`CreateImpactMarket`, `impact_market_id`, `ImpactMarketInfo`) have left the wire and survive only in stored history; never add a new use, and gloss them as "the legacy event-plus-conditional record" where a reader needs it.
- **Names being renamed (hard cutover, no aliases):** the branch outcome events `conditional_settled` / `conditional_voided` become `condition_met` / `condition_not_met` ("Condition met" / "Condition not met"; "Void" stays the whole-event outcome); the gateway JSON types `order` / `cancel` / `cancelReplace` become `placeOrder` / `cancelOrder` / `cancelReplaceOrder`; the gateway WebSocket frame types `account_event`, `order_update`, `position_update`, `trigger_update`, `margin_update` become lowerCamel. Write only the new names in new code; a line that must keep an old name (decoding stored history) carries the comment `vocabulary-lint: allow`.
- **Naming something new:** name it after the entity it acts on, check the manifest for the name first, and add the derived forms in the same pull request. The `Vocabulary lint` check warns on retired words and on renamed names; it becomes blocking per repository once that repository is clean.

## Network policy — gateway only (client-facing code)

All client traffic — SDKs, frontends, bots, scripts — goes through the **API gateway**. The CometBFT RPC (`:26657`) and the node REST API (`:8080` / `:1317`) are internal upstreams the gateway fronts; they are **never** client targets and may be firewalled off in production.

- **Through the SDK, never hand-rolled HTTP.** The gateway is the *network* boundary; the Proof SDK (`@proof-labs/trading-sdk`, source of truth `Proof-labs/trading-sdk`) is the *client* boundary. Application code — frontends, bots, scripts, services — calls the SDK for every gateway interaction; it never hand-rolls `POST /exchange` bodies, signing, nonces / sequence numbers, or wire codecs against the gateway. If the SDK lacks a method for a gateway route, add the SDK method first, then consume it — same pattern as the gateway rule below. Exceptions: the SDK's own transport internals, and contract tests that deliberately pin the raw route / request shape (e.g. proof-integration scenarios).
- **Default to the gateway.** A direct-to-node path may exist only as an explicit, non-default opt-out (e.g. `useGateway: false`) for in-cluster tools (market-makers, PLP, oracle feeder, test harness) — never the public default, never documented for external callers.
- **Never hardcode or default to** node ports (`:26657`, `:8080`, `:1317`), raw CometBFT methods (`/status`, `/block`, `/tx?hash=`, `broadcast_tx_*`), or a node mode (`apiMode: 'node'`). Use the gateway surface: `POST /exchange`, `POST /info`, `GET /v1/*`, `/v1/tx/{hash}`, `/v1/status`, `/ws`.
- **If the gateway doesn't serve a read you need, add the gateway route first**, then consume it — do not reach past the gateway to the node.
- Scope: client-facing code only. Does **not** apply to the gateway itself or to node / infra repos, which legitimately talk to the node.

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->
<!-- Add repo-specific Copilot instructions below this line. -->
