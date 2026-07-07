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
   Prices are integer cents, quantities are integer contracts.
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
replays `dev`'s commits onto `main` under *new hashes*, so the same change ends
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
npm run build     # tsc -> dist/
npm test          # vitest run (codec, crypto, client, scenarios)
npx prettier --check .
```

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
- All prices and quantities are `u64` (cents / microUSDC). **No floats.**
- New fields go at the **end** as optional so absent fields encode as `nil`
  (backward compatible). Adding an action means: define its type/payload in
  `types.ts`, assign its `action_type` byte and encode/decode arms in `codec.ts`.

## Versioning & wire-format compatibility

Every package here (the npm `@proof/trading-sdk` and the `crates/*` Rust crates) ships **semver on the full `MAJOR.MINOR.PATCH` line and is kept at `>= 1.0.0`**. We are off `0.x` on purpose: under `0.x`, Cargo and npm caret ranges treat the *second* number as the breaking one, which is the wrong signal for a wire contract. At `>= 1.0.0` only a **MAJOR** difference is incompatible; MINOR and PATCH are drop-in for consumers. Do not reset to `0.x`.

This SDK **reimplements** the exchange wire format (it does not pin `exchange-core` as a dependency), so it does not get the engine's version automatically — keep it in lockstep by hand. The wire format is the contract that drives the bump, and the rule matches the engine's exactly:

- **PATCH** — no wire change. Internal fix, perf, refactor, docs. Identical bytes, identical decode for every existing message.
- **MINOR** — a wire change that older versions can **still decode**. Purely additive: messages produced before the change still round-trip on the new code and the previous code still accepts what the new code emits. Examples: a new trailing optional field that encodes as `nil` when absent; a new `action_type`; **adding a new signable wire variant — MINOR if and only if transactions produced before the change still decode successfully.**
- **MAJOR** — a wire change that makes an older version **fail to decode**, or makes the new code reject what an old version produced. Examples: **removing/deprecating an existing wire format**; reordering a positional array; changing a field type or scale; bumping the envelope `version` byte or the signing domain prefix (`DOMAIN_PREFIX`).

Rule of thumb: **every wire-format change is at least a MINOR bump; if it breaks backward decode in either direction it is a MAJOR bump.** Prove decodability before calling something MINOR — re-diff the golden vectors in `crates/spec/golden-vectors/*.hex` and add a decode test for the previous version's bytes.

Lockstep with the engine: this SDK's **MAJOR must equal the engine wire MAJOR it speaks.** When the engine cuts a MAJOR (breaking wire), the SDK cuts a MAJOR in the same change window; an additive engine MINOR that the SDK starts emitting/accepting is a SDK MINOR. Record the compatible engine version in `CHANGELOG.md` on every release. The npm package and the Rust crates move together — bump all of them, never just one.

### Changelog discipline — update it per-PR, never at release time

`CHANGELOG.md` is updated **in the same PR as the change**, not reconstructed at release. Every PR that changes observable behaviour — wire format, public API surface (TS/Rust/Python), routing, query methods, defaults, error semantics, or a security fix — adds at least one line under `## [Unreleased]` in the right [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) group (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`). A behaviour-changing PR with no CHANGELOG line is incomplete — call it out in review.

This rule exists because we already lost history the other way: `0.1.0` sat as a single "Initial public release" line while gateway-only read/stream routing, the full Python/PyO3 SDK, dedicated builders for all core action types, conformance coverage of every action, engine-parity (CreateMarket fields, AtomicBasketOrder), the public-API pruning of internal abstractions, and multiple security/leak fixes all landed **unrecorded**. A release entry assembled from memory drops most of what shipped. When `[Unreleased]` is kept current per-PR, cutting a release is mechanical: rename `[Unreleased]` to the new `MAJOR.MINOR.PATCH`, add the dated compare link, open a fresh empty `[Unreleased]` — the substance is already written.

## Unit conventions

| Field      | Scale                                | Example                   |
| ---------- | ------------------------------------ | ------------------------- |
| Prices     | Integer cents (2 dp)                 | `6675000` = $66,750       |
| Balances   | MicroUSDC (6 dp)                     | `100_000_000_000` = $100k |
| Fees/Rates | Basis points                         | `500` = 5%                |
| Addresses  | 20 bytes — keccak256(pubkey)[12..32] | `pubkeyToOwner()`         |

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

> **Note — the TS codec is migrating to a WASM build of the Rust core.** The
> hand-written parallel codec in `src/codec.ts` is being replaced by a
> `wasm-bindgen` binding over `encode_payload_dyn` / `decode_payload_dyn`, so
> the Rust registry becomes the single source of truth. Read
> [docs/adr/0001-wasm-core-vs-parallel-types.md](docs/adr/0001-wasm-core-vs-parallel-types.md)
> before touching `codec.ts` — it records why WASM (not codegen or a hybrid) was
> chosen, so the tradeoff does not get re-argued.

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
