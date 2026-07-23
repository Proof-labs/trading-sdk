# Proof-labs working agreement (Claude Code)

This file is project-level guidance for Claude Code, synced from `Proof-labs/.github` (`templates/agent-config/CLAUDE.md`). Repo-specific instructions live below the `<!-- repo-specific -->` marker — don't edit anything above it.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced)

**Before making any code edits**, you must:

1. Ask the user what this work is: a **ProofOfBrain board card** (`W##-NN`, e.g. `W20-04`), a **Linear ticket** (`BE-##`), or **ad-hoc**.
2. Create a branch with the correct prefix:
   - **ProofOfBrain card:** `git checkout -b W##-NN/<short-kebab-slug>` (e.g. `W20-04/known-limitations`)
   - **Linear ticket or ad-hoc:** `git checkout -b <type>/<slug>` where `<type>` is one of `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`. A Linear ticket rides a `<type>/` branch and is attached at PR time (see pull-request policy), not in the branch name.
3. **For a ProofOfBrain card**, read the board card before editing:
   `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → heading `### W##-NN — <title>`
4. Confirm scope with the user before editing files.

The `PreToolUse` hook at `.claude/hooks/pre-tool-use.sh` rejects `Edit` / `Write` / `NotebookEdit` calls until the current branch matches the convention. Don't try to bypass — fix the branch.

`main`, `dev`, `develop`, `master` (any case) are blocked for direct edits.

## Pull-request policy

When you open a pull request, set the **Task link** in the PR body — it's optional, but ask by default:

1. If the user already named a ticket for this work (a ProofOfBrain card `W##-NN` or a Linear ticket `BE-##`), use it — don't ask again.
2. Otherwise ask once, in chat: *"Is this part of a ProofOfBrain board card (`W##-NN`), a Linear ticket (`BE-##`), or free-styling for now?"*
3. Fill the matching line in the template's **Task link** section (or tick "No — free-styling"). Free text is fine.

The `Board item / validate` check is **advisory only — it never blocks a merge**. Use `dev` as the integration branch; `develop` and `master` are blocked org-wide via ruleset.

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
- Branching policy: `Proof-labs/ProofOfBrain` → meeting notes referenced from the PR template
- Org-level config (this file, hooks, rulesets, validator workflow): `Proof-labs/.github`

## Network policy — gateway only (client-facing code)

All client traffic — SDKs, frontends, bots, scripts — goes through the **API gateway**. The CometBFT RPC (`:26657`) and the node REST API (`:8080` / `:1317`) are internal upstreams the gateway fronts; they are **never** client targets and may be firewalled off in production.

- **Through the SDK, never hand-rolled HTTP.** The gateway is the *network* boundary; the Proof SDK (`@proof/trading-sdk`, source of truth `exchange/sdk`) is the *client* boundary. Application code — frontends, bots, scripts, services — calls the SDK for every gateway interaction; it never hand-rolls `POST /exchange` bodies, signing, nonces / sequence numbers, or wire codecs against the gateway. If the SDK lacks a method for a gateway route, add the SDK method first, then consume it — same pattern as the gateway rule below. Exceptions: the SDK's own transport internals, and contract tests that deliberately pin the raw route / request shape (e.g. proof-integration scenarios).
- **Default to the gateway.** A direct-to-node path may exist only as an explicit, non-default opt-out (e.g. `useGateway: false`) for in-cluster tools (market-makers, HLP, oracle feeder, test harness) — never the public default, never documented for external callers.
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

1. Branch off **`dev`** using `<type>/<slug>`, where `<type>` is one of `chore`,
   `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`, and open the PR **with
   `dev` as the base**. Never edit on `dev` or `main` directly, and never point
   a feature PR at `main`.
2. Keep each PR to a single logical change, and add a test with every
   behaviour change.
3. Title each PR with one Conventional Commits prefix.

The `PreToolUse` hook at `.claude/hooks/pre-tool-use.sh` rejects `Edit` /
`Write` / `NotebookEdit` calls until the branch matches `<type>/<slug>`. Fix
the branch rather than bypassing it.

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
npm run build:wasm # build the Rust core → src/wasm (needs Rust + wasm-bindgen)
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

Every package here (the npm `@proof/trading-sdk`, Python distribution, and
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
  tools (MMs, HLP, oracle feeder) and the scenario harness. Never document or
  default it for the public SDK, and never add a fresh hard-coded `rpcUrl` /
  `apiUrl` call that bypasses the base getters.

## Out of scope — do not implement

Some surfaces have been explicitly rejected. Do not add them back without a new
product decision that reverses the one on record (link a superseding ADR).

- **Oracle health (`queryOracleHealth()` / any read of `/v1/oracle/health`).**
  **Prohibited.** Feed liveness/freshness is an operational-monitoring concern
  owned by **Grafana (Markets Health)**, not the SDK; no trading or admin caller
  needs it. Proposed in PR #26 and **closed unmerged** (2026-07-06 weekly
  meeting; Web Admin is read-only and does not consume it). Full rationale and
  the (narrow) scope of the ban — including that `MarketConfig.maxOpenInterest`
  is only _deferred_, not banned — are in
  [docs/adr/0002-oracle-health-out-of-scope.md](docs/adr/0002-oracle-health-out-of-scope.md).
  Oracle _operation_ (`OracleUpdate` / `OracleUpdateComposite`) stays in the
  SDK, but as `OperatorAction`s for operator-tooling completeness only —
  **not** for the SDK's primary trader users (allowlist-gated; see AGENTS.md
  "Operator actions — privileged, not for trading integrations"). Oracle
  _health monitoring_ is not a wire action at all and does not belong here.

## Security notes

This SDK signs and encodes value-bearing transactions. Treat signing and codec
paths as security-critical:

- Never log private keys, seeds, or signatures. Keep key material out of error
  messages and debug output.
- Codec round-trips must be exact (`encode → decode` structural equality) for
  every action — the scenario and codec tests are the regression guard.
- Prefer typed errors (`src/errors.ts`) over string matching for engine/gateway
  rejection handling.
