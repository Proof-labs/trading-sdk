# Proof-labs working agreement (Claude Code)

This file is project-level guidance for Claude Code, synced from `Proof-labs/.github` (`templates/agent-config/CLAUDE.md`). Repo-specific instructions live below the `<!-- repo-specific -->` marker — don't edit anything above it.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced)

**Before making any code edits**, you must:

1. Ask the user what this work is: a **ProofOfBrain board card** (`W##-NN`, e.g. `W20-04`), a **Linear ticket** (`BE-##`), or **ad-hoc**.
2. Create a branch with the correct prefix. **If the work closes a GitHub issue, embed its number as the leading segment: `GH<issue>/…`** (e.g. `GH98/fix/oracle-source-vectors`), and put `Closes #<issue>` in the PR body.
   - **ProofOfBrain card:** `git checkout -b W##-NN/<short-kebab-slug>` (e.g. `W20-04/known-limitations`); with a GitHub issue, `GH<issue>/W##-NN/<short-kebab-slug>`.
   - **Linear ticket or ad-hoc:** `git checkout -b <type>/<slug>` where `<type>` is one of `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`; with a GitHub issue, `GH<issue>/<type>/<slug>`. A Linear ticket rides a `<type>/` branch and is attached at PR time (see pull-request policy), not in the branch name.
3. **For a ProofOfBrain card**, read the board card before editing:
   `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → heading `### W##-NN — <title>`
4. Confirm scope with the user before editing files.

The `PreToolUse` hook at `.claude/hooks/pre-tool-use.sh` rejects `Edit` / `Write` / `NotebookEdit` calls until the current branch matches the convention (writes to the plan file in plan mode are exempt). Don't try to bypass — fix the branch.

`main`, `dev`, `develop`, `master` (any case) are blocked for direct edits.

## Pull-request policy

When you open a pull request, set the **Task link** in the PR body — it's optional, but ask by default:

1. If the user already named a ticket for this work (a ProofOfBrain card `W##-NN` or a Linear ticket `BE-##`), use it — don't ask again.
2. Otherwise ask once, in chat: *"Is this part of a ProofOfBrain board card (`W##-NN`), a Linear ticket (`BE-##`), or free-styling for now?"*
3. Fill the matching line in the template's **Task link** section (or tick "No — free-styling"). Free text is fine.

The `Board item / validate` check is **advisory only — it never blocks a merge**. Use `dev` as the integration branch; `develop` and `master` are blocked org-wide via ruleset.

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
- Branching policy: `Proof-labs/ProofOfBrain` → meeting notes referenced from the PR template
- Org-level config (this file, hooks, rulesets, validator workflow): `Proof-labs/.github`

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

# Proof Trading SDK — Claude Code guide

## Trading with the SDK

If a user asks you to connect to Proof Exchange and trade, here is the pattern:

1. **Generate keys** — `generateKeypair()` handles Ed25519 key creation.
   Derive the address with `pubkeyToOwner(publicKey)` (keccak256[12..32]).
2. **Create a client** — `new ExchangeClient({ chainId: "exchange-devnet-1" })`
   for the public devnet.
3. **Fund** — The user must have tokens. Call the faucet via
   `POST https://faucet.dev.proof.trade/drip` with an auth token.
4. **Trade** — `submitTx({ type: "PlaceOrder", data: { ... } })`.
   Prices are integer **micro-USDC** (6 dp), quantities are integer contracts.
5. **Check results** — `code === 0` means CheckTx passed. Non-zero codes
   are error codes (12 = insufficient margin, 21 = nonce collision, etc.).

Run the example:

```bash
npx tsx examples/connect-and-trade.ts
```

See [AGENTS.md](AGENTS.md) for the complete agent reference.

## Branching & pull requests

`dev` is the **integration** branch; `main` is the **release** branch. **All
feature work targets `dev` — never open a PR against `main` directly.** `main`
only ever advances by merging `dev` into it (see the release rule below).

**Before making any code edits:**

1. Branch off **`dev`** and open the PR **with `dev` as the base**. Never edit
   on `dev` or `main` directly, and never point a feature PR at `main`.
2. Name the branch per the org policy at the top of this file: `<type>/<slug>`
   or `W##-NN/<slug>`, led by `GH<issue>/` when the work closes a GitHub issue
   (e.g. `GH98/fix/oracle-source-vectors`), with `Closes #<issue>` in the PR
   body. The naming rule lives there, not here, so it cannot drift.
3. Keep each PR to a single logical change, and add a test with every
   behaviour change.
4. Title each PR with one Conventional Commits prefix.

**Releasing (`dev` → `main`): always use "Create a merge commit" — never
"Rebase and merge" or "Squash and merge".** A rebase/squash of a sync PR
replays `dev`'s commits onto `main` under _new hashes_, so the same change ends
up as two different commits and the branches permanently diverge (and `dev` is
protected, so you cannot force-push the duplicates away). A merge commit
references the real commits, keeps a shared merge-base, and reconciles the
branches with no force-push. This applies to any `dev`↔`main` sync PR in either
direction.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities (privately, never in a
public issue or PR).

# Proof Trading SDK

TypeScript SDK for the Proof Exchange — Ed25519 signing, MessagePack codec,
timestamp-nonce allocation, and gateway/CometBFT submission helpers.

## Commands

```bash
npm install
npm run build:wasm # build the Rust core → src/wasm (needs Rust + wasm-bindgen CLI)
#   the CLI version must match the exact-pinned wasm-bindgen crate version in
#   crates/proof-trading-sdk-wasm/Cargo.toml:
#   cargo install wasm-bindgen-cli --version 0.2.126
npm run build      # tsc -> dist/
npm test           # vitest run — REQUIRES build:wasm first (codec routes through WASM)
npx prettier --check .
```

The codec and signing run through a WASM build of the Rust core, so
`npm run build:wasm` must run before `npm test` / any codec call, and callers
`await ready()` once before encoding/signing (`ExchangeClient` does this
internally). See `docs/adr/0001-wasm-core-vs-parallel-types.md`.

## Layout

| Path                            | Role                                                |
| ------------------------------- | --------------------------------------------------- |
| `src/codec.ts`                  | MessagePack encode/decode; signed-envelope assembly |
| `src/crypto.ts`                 | Ed25519 sign/verify; keypair + owner derivation     |
| `src/client.ts`                 | `ExchangeClient`: submit, queries, nonce allocation |
| `src/errors.ts`                 | Typed engine/gateway error surface                  |
| `src/types.ts`                  | Action types + payload shapes — the wire contract   |
| `src/scenarios/`                | End-to-end matching/liquidation scenario tests      |
| `examples/connect-and-trade.ts` | End-to-end example for the devnet                   |

## Wire format rules

- All messages are MessagePack **positional arrays**, never maps. Field order
  is the wire layout — never reorder.
- Envelope: `[version=2, action_type, seq, payload, pubkey(32B), signature(64B)]`.
  Signature covers
  `DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B BE) || payload`.
- **Two distinct version numbers — do not conflate them:**
  - The **envelope `version` byte** is `2` (first array element). The exchange
    engine accepts only `[2]`.
  - The **signing domain prefix** is `"ProofExchange-v3"` (16B) — the V3 signing
    layout above, which binds `chain_id`. It was bumped to v3 when chain_id
    binding landed, and the exchange engine signs/verifies under v3.
  - Verified byte-identical against the golden vectors in
    `crates/spec/golden-vectors/*.hex`. Re-diff those after any wire change.
- The 32-byte `chain_id` binding closes cross-chain replay. Resolved from
  CometBFT `/status` and cached; offline callers of `signAndEncode` must pass it.
- `seq` is a wall-clock-ms timestamp nonce; the engine validates it against a
  sliding window (no strict sequential ordering).
- All monetary values (prices, balances, amounts, fees) are `u64` **micro-USDC**
  (6 dp; `1_000_000` = $1). Quantities are integer contracts. **No floats.**
- New fields go at the **end** as optional so absent fields encode as `nil`
  (backward compatible). The action codec now lives in the **Rust core**, so
  adding an action means: add the struct + `impl_action_encoding!` entry in
  `crates/proof-trading-sdk` and `npm run build:wasm`; on the TS side add the
  `types.ts` interface/union + its `ActionType` byte, and (only if it introduces
  a new enum or a field name whose camel↔snake conversion is irregular) a
  mapping in `codec-adapter.ts`. `codec.ts` is no longer hand-edited per action.

## Versioning & wire-format compatibility

Every package here (the npm `@proof-labs/trading-sdk`, Python distribution, and
`crates/*` Rust crates) ships **independent semver on the full
`MAJOR.MINOR.PATCH` line and is kept at `>= 1.0.0`**. We are off `0.x` on
purpose: under `0.x`, Cargo and npm caret ranges treat the _second_ number as
the breaking one, which is the wrong signal for a wire contract. At `>= 1.0.0`
only a **MAJOR** difference is incompatible; MINOR and PATCH are drop-in for
consumers. Do not reset to `0.x`, and do not bump an unchanged package merely
because another workspace package changed.

The SDK surfaces **reimplement** the exchange wire format (they do not pin
`exchange-core` directly), so engine compatibility does not arrive
automatically. Classify each package against the new engine wire and update its
upstream-core pin by hand. For any package that encodes or decodes messages,
the wire format is part of its public contract and drives the bump:

- **PATCH** — no wire change. Internal fix, perf, refactor, docs. Identical bytes, identical decode for every existing message.
- **MINOR** — a wire change that older versions can **still decode**. Purely additive: messages produced before the change still round-trip on the new code and the previous code still accepts what the new code emits. Examples: a new trailing optional field that encodes as `nil` when absent; a new `action_type`; **adding a new signable wire variant — MINOR if and only if transactions produced before the change still decode successfully.**
- **MAJOR** — a wire change that makes an older version **fail to decode**, or makes the new code reject what an old version produced. Examples: **removing/deprecating an existing wire format**; reordering a positional array; changing a field type or scale; bumping the envelope `version` byte or the signing domain prefix (`DOMAIN_PREFIX`).

Rule of thumb: **every wire-format change is at least a MINOR bump; if it breaks backward decode in either direction it is a MAJOR bump.** Prove decodability before calling something MINOR — re-diff the golden vectors in `crates/spec/golden-vectors/*.hex` and add a decode test for the previous version's bytes.

Evaluate compatibility per package. A package whose decoder rejects the new
wire, or whose public source API is incompatible, takes a **MAJOR** bump. A
binding whose existing public API and decoder remain compatible may take a
**MINOR** bump even when it adds support for the engine's next wire major; its
manifest must still pin the compatible upstream-core major. Unchanged helper
crates keep their current version. Record the compatible engine version and
the package-specific bump rationale in `CHANGELOG.md` on every release.

### Changelog discipline — update it per-PR, never at release time

`CHANGELOG.md` is updated **in the same PR as the change**, not reconstructed at release. Every PR that changes observable behaviour — wire format, public API surface (TS/Rust/Python), routing, query methods, defaults, error semantics, or a security fix — adds at least one line under `## [Unreleased]` in the right [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) group (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`). A behaviour-changing PR with no CHANGELOG line is incomplete — call it out in review.

This rule exists because we already lost history the other way: `0.1.0` sat as a single "Initial public release" line while gateway-only read/stream routing, the full Python/PyO3 SDK, dedicated builders for all core action types, conformance coverage of every action, engine-parity (CreateMarket fields, AtomicBasketOrder), the public-API pruning of internal abstractions, and multiple security/leak fixes all landed **unrecorded**. A release entry assembled from memory drops most of what shipped. When `[Unreleased]` is kept current per-PR, cutting a release is mechanical: rename `[Unreleased]` to the new `MAJOR.MINOR.PATCH`, add the dated compare link, open a fresh empty `[Unreleased]` — the substance is already written.

## Unit conventions

| Field      | Scale                                | Example                    |
| ---------- | ------------------------------------ | -------------------------- |
| Prices     | micro-USDC (6 dp)                    | `66_750_000_000` = $66,750 |
| Balances   | MicroUSDC (6 dp)                     | `100_000_000_000` = $100k  |
| Fees/Rates | Basis points                         | `500` = 5%                 |
| Addresses  | 20 bytes — keccak256(pubkey)[12..32] | `pubkeyToOwner()`          |

## Spec / contract sync

The SDK's accepted wire shapes must not drift from the gateway. The gateway
owns its `openapi.yaml` spec and pins the exchange engine by version. When a
wire-format change affects the SDK:

1. Update `types.ts` / `codec.ts` and the partner gateway spec in the same
   review window. The spec is the contract — do not let it drift behind a wire
   change.
2. Add or update at least one test that exercises the new shape (a happy-path
   encode/decode round-trip plus one malformed/negative case).
3. Call out the change in the PR under a "Spec/SDK changes" heading; if nothing
   changed, say so explicitly.

`src/types.ts` and `src/codec.ts` are the source of truth for the action set —
do not hardcode action counts elsewhere; they change as the engine grows.

> **Note — the action codec + signing run through a WASM build of the Rust
> core.** `src/codec.ts` is now a thin adapter (`codec-adapter.ts`) over a
> `wasm-bindgen` binding of `encode_payload_dyn` / `decode_payload_dyn` +
> signing; the Rust registry is the single source of truth and the bytes are
> engine-identical by construction. Consequences: `npm run build:wasm` must run
> before tests/codec use, and callers `await ready()` once before
> encoding/signing (`ExchangeClient` does this internally). See
> [docs/adr/0001-wasm-core-vs-parallel-types.md](docs/adr/0001-wasm-core-vs-parallel-types.md)
> for why WASM (not codegen or a hybrid) was chosen.

## Network policy — gateway only

**All SDK traffic goes through the API gateway. No exceptions for external
callers.** This holds for every SDK (TypeScript, Python) — the gateway is the
single public surface; treat direct node access as internal-only.

"All traffic" means submission **and** every read: order submission, account /
orderbook / market / history queries, transaction-status polling, chain
status/blocks (`/v1/status`, `/v1/block`, `/v1/block_results`), the chain-id
bootstrap, and the live WebSocket feed. External clients must **not** assume the
CometBFT RPC or the Go API server are reachable — those sit behind the gateway
and may be firewalled off in a public deployment.

- **One endpoint.** Public callers configure only the gateway URL. Prod default
  is `https://api.dev.proof.trade` (port 443). Local stack: the gateway is
  **port 9080** — that is the port external clients use. `8080` (Go API) and
  `26657` (CometBFT RPC) are upstreams the gateway fronts, not client targets.
- **Single source of truth.** `ExchangeClient` takes one `gatewayUrl`; the
  internal `rpcUrl` / `apiUrl` are derived from it (local gateway `9080` →
  `26657` / `8080`) and consulted only on the `useGateway: false` path.
- **`useGateway` is the master switch.** Under the default `useGateway: true`,
  `ExchangeClient` routes **all** traffic through `gatewayUrl`: reads
  (`readBaseUrl`), tx-status polling (`txStatusUrl` → `/v1/tx/{hash}`), chain
  status/blocks and the chain-id bootstrap (`chainBase` → `/v1/status`,
  `/v1/block`, `/v1/block_results`), the WebSocket feed, and submission.
  `useGateway: false` is the internal-only direct-node path for in-cluster
  tools (market makers, the PLP, oracle feeder) and the scenario harness. Never document or
  default it for the public SDK, and never add a fresh hard-coded `rpcUrl` /
  `apiUrl` call that bypasses the base getters.

## SDK scope — every gateway interaction, admin calls included

**Every gateway interaction an application makes goes through the SDK**:
trading actions, reads, streams, the oracle health check and admin calls alike
([ADR 0003](docs/adr/0003-every-gateway-interaction-through-the-sdk.md),
accepted 2026-09-16, which supersedes
[ADR 0002](docs/adr/0002-oracle-health-out-of-scope.md)). No gateway call is
out of scope for being "operational" or "admin-only". When Web-UI, Web Admin, a
bot or a script needs a gateway route the SDK does not cover, add the SDK
method; do not leave the caller to hand-roll it.

- **Oracle health.** `ExchangeClient.reads().oracleHealth()` forwards
  `GET /v1/oracle/health` with the response body, HTTP errors and cancellation
  intact. Freshness thresholds and display policy stay in the application, and
  the read is not trading authorization. Extend it rather than adding a parallel
  `queryOracleHealth()`. Grafana Markets Health remains the operational
  dashboard; the SDK does not become a monitoring service.
- **Admin and operator calls.** They ship in the SDK for their consumers, but
  the engine still gates them behind allowlists and multisig: being in the SDK
  grants no authority. Trading integrations can keep typing their calls as
  `TraderAction`.

## Security notes

This SDK signs and encodes value-bearing transactions. Treat signing and codec
paths as security-critical:

- Never log private keys, seeds, or signatures. Keep key material out of error
  messages and debug output.
- Codec round-trips must be exact (`encode → decode` structural equality) for
  every action — the scenario and codec tests are the regression guard.
- Prefer typed errors (`src/errors.ts`) over string matching for engine/gateway
  rejection handling.
