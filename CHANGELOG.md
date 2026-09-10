# Changelog

All notable changes to `@prooftrade/trading-sdk` (and the `proof-trading-sdk` Python
package) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.0.0] — 2026-09-10

npm `@proof/trading-sdk` only; the Rust crates and the Python package keep
their current versions until their own tags are cut. Compatible engine:
exchange v2.9.0 (exchange-wire 1.4.0, the pinned `6a640c45`). MAJOR for the
npm package because `ConfirmDeposit` payloads gain an unconditional fifth
element (see Changed); everything else in this release is additive.

### Added

- `AdminAction` gains `CancelAllOrdersForAccount` (inner tag `0x08`,
  exchange#467 / DEC-151): the multisig kill lever that cancels every resting
  order of one wallet, optionally confined to one market. Typed on the
  TypeScript side (`{ owner, market? }`), decoded from proposal reads, and
  pinned by two conformance vectors (scoped and unscoped) plus a content-hash
  golden shared with the Python suite. The `exchange-wire` pin moves to the
  merged exchange#471 revision (wire 1.4.0), which also brings 1.3.0's
  `UpdateAuthoritySet` (inner tag `0x07`) and `AuthorityDomain` into the Rust
  and Python surfaces; the TypeScript mirror of tag `0x07` is tracked in
  exchange#472. Additive (MINOR).

- `@prooftrade/trading-sdk/testing` subpath: `registerTestActions()` makes the
  engine-internal `RunLiquidationSweep` (0x11) and `RunFundingTick` (0x12)
  actions encodable for dev-stack harnesses. Not exported from the main entry.
- **Proposal-lifecycle error codes 54-71** - the multisig-governance error
  family (`ProposalNotFound` ... `InvalidAdminRegistry`) is now mirrored across
  all three bindings from the engine's `ExecError` and the frozen
  `exchange/sdk` reference table. `decodeExecError` / `get_error_name`
  previously returned `null`/unknown for any propose/approve/reject or
  emergency-admin rejection in this range, so Web Admin and governance tooling
  could not name those failures. Decode-only and additive (MINOR): no wire
  change, and the client never constructs these errors, it classifies result
  codes. The `no_code_holes_in_documented_range` gate now covers `1..=71` and
  the `errors.ndjson` conformance manifest pins every new code to its name.
- `AdminAction` gains an `UnpauseBridge` unit variant (inner tag `0x06`), a
  multisig operation that lifts a bridge pause. It carries no fields and
  serializes as the bare string `"UnpauseBridge"` (distinct from the
  `{ Variant: {} }` map form a fieldless struct variant takes), so it is
  additive (MINOR): every pre-existing admin-action payload still decodes
  unchanged. Mirrors engine `exchange-wire` 1.2.0 (exchange#435, DEC-65). New
  conformance vector `propose_admin_action/unpause_bridge` is byte-for-byte the
  engine's frozen wire vector; `decodeAdminAction` renders it on the governance
  read path.
- `ConfirmDeposit` gains a trailing optional `DepositLocator`
  (`{ topIndex, innerIndex? }`) identifying the USDC transfer's instruction
  position within its Solana transaction, so two transfers sharing one Solana
  transaction signature are no longer deduplicated into one credit. Mirrors
  engine `exchange-wire` 1.1.0 (exchange#434). New conformance vectors
  `confirm_deposit/with_locator` and `confirm_deposit/no_locator` pin the bytes.

### Changed

- **BREAKING (npm): the package is now `@prooftrade/trading-sdk`.** The
  npm scope follows the `prooftrade` organisation that owns it on the
  registry; `@proof/trading-sdk` was never published. Consumers that
  install from git rename the dependency key and every import specifier
  (`@prooftrade/trading-sdk`, `@prooftrade/trading-sdk/testing`). The Rust
  crate and the Python package keep their names.

- **BREAKING (MAJOR) — `ConfirmDeposit` payloads gain an unconditional fifth
  element.** The locator is appended as a trailing `nil` even when the caller
  supplies none, so every `ConfirmDeposit` this SDK emits changes from a
  4-element positional array (`94 …`) to a 5-element one (`95 … c0`) — including
  calls whose source code is unchanged. Backward decode holds in one direction
  only: pre-locator bytes still decode on the new code, but a strict 4-field
  `rmp-serde` decoder **rejects** what the new code emits, which
  `exchange-wire`'s own `deposit_locator_is_backward_decodable` test asserts at
  the pinned revision. Per CLAUDE.md ("if it breaks backward decode in either
  direction it is a MAJOR bump") this is a MAJOR bump for every package that
  encodes `ConfirmDeposit` — the same classification this changelog applied to
  the `CreateMarket` open-interest cap, which grew a positional array by one
  unconditional trailing element in exactly the same way.

  Compatible engine: `exchange-core >= 2.6.0` **built against
  `exchange-wire >= 1.1.0`** (exchange#434, rev `2a6d079`). Note `exchange-core`
  reads 2.6.0 both with and without the locator, so it is the `exchange-wire`
  floor — not the `exchange-core` version — that distinguishes an engine which
  accepts these bytes. Pointing this SDK at an engine below that floor fails
  every deposit confirmation, so upgrade the engine first.

- The Python `admin_proposal_content_hash` stub now types `action` as
  `dict[str, object] | str`, and its docstring names the unit-variant form. The
  binding already accepted the bare string at runtime, but the declared type
  rejected it — so a type-checked Python approver could not pass the only
  canonical `UnpauseBridge` shape without suppressing the error.

- Decoding a governance `action` that arrives as a bare string now throws
  unless the string is a known unit variant, matching the allowlist the encode
  direction already used and the fail-closed posture of `decodeAdminAction`. An
  SDK build that does not know an operation must not hand callers a `kind`
  outside the `AdminAction` union for them to render or approve.

- The Rust core's `exchange-wire` pin moves from rev `2a6d079`
  (exchange-wire 1.1.0) to rev `f4feefd3` (exchange-wire 1.2.0, exchange#435),
  which is where `AdminAction::UnpauseBridge` is defined. The wire variant is
  no longer mirrored in this repository — `crates/proof-trading-sdk` re-exports
  it from the shared crate, so the SDK and the engine cannot disagree about it.

### Fixed

- **Python wheel ABI floor pinned to CPython 3.11** (`cp311-abi3`) via the
  `pyo3/abi3-py311` feature in `python/pyproject.toml` and the PyO3 crate,
  instead of bare `abi3`. Bare `abi3` takes the floor from whichever interpreter
  runs the build, so a wheel built under Python 3.14 was tagged `cp314-abi3` and
  would not install on 3.11–3.13 even though `requires-python = ">=3.11"`
  promises them; those users silently fell back to building the sdist, which
  needs a Rust toolchain. CI happened to build on 3.11, so published wheels were
  correct by coincidence rather than by construction (#90). Packaging-only:
  PATCH for the Python distribution, no wire or API change.

## [3.0.0] — 2026-08-24

First published release: this is the first version of any of these packages
to reach npm, crates.io, or PyPI. Earlier entries below describe versions
that were tagged in this changelog only and never published.

The npm, Rust core, PyO3, and Python packages move to **3.0.0**. The MAJOR bump
renumbers `OpenInterestLimitExceeded` from result code 50 to 51 (and repurposes
code 50 to `SlippageExceeded`), which changes the result for any consumer that
switches on the integer code, and adds the public code-51
`OpenInterestLimitExceeded` classification while preserving safe decoding across
a rolling engine upgrade. The WASM crate takes a MINOR bump to **2.1.0** (a new
`admin_proposal_content_hash` export; existing API and wire behaviour
unchanged), the derive crate stays at **1.1.0**, and the unpublished
conformance crate continues to label the v2 vectors as **2.0.0**.

This release also includes the two breaking changes first staged at 2.0.0: the
open-interest-cap wire contract and the cutover of the action codec + signing
onto a WASM build of the Rust core (ADR 0001).

Open-interest cap — every v2 `CreateMarket` wire payload now has one canonical
12-field encoding, including an explicit final `0` for uncapped markets. The npm
input treats omission, null, and explicit zero identically. That changes its
existing uncapped output from 11 to 12 fields and normalizes a decoded legacy
absent tail from `undefined` to `0n`; a v1 gateway/engine cannot be assumed to
accept the new bytes. Frozen v1 `rmp-serde` decoders also reject populated
12-field `CreateMarket` and 21-field `UpdateMarketFees` payloads, and the Rust
wire structs gain source-incompatible fields. The unchanged derive crate stays
at **1.1.0**; the unpublished conformance crate labels the v2 vectors as
**2.0.0**. Compatible engine: `exchange-core >= 2.0.0, < 3.0.0` for the wire as
a whole; the bridge-custody actions added below (`0x22` / `0x23` / `0x24`)
require `exchange-core >= 2.4.0` (the next engine release to declare them,
PR #316 — release C was tagged `v2.3.0` from a cut that predates that wire
surface, and `2.2.0` earlier still) — an earlier engine rejects those
action types.

### Added

- **`SubmissionPending` (Python)** — a new public exception for the gateway
  shape that carries a `txHash` but no engine `code`. The gateway broadcast the
  transaction and could not report its on-chain outcome in time; the tx may
  still commit, so the caller reconciles by `tx_hash` instead of re-submitting.
  Exported from `proof_trading_sdk`.

- **Position-linked stop-loss/take-profit support (W32-10)** — canonical
  `SetPositionTriggers` (`0x25`) and `CancelPositionTriggers` (`0x26`) wire
  actions, governed trigger-market configuration tag `0x05`, delegated-owner
  signing, persistent position-epoch discovery, current trigger/config/status
  reads, and lossless owner/market lifecycle-history reads now ship across the
  Rust, WASM/TypeScript, and Python bindings. Engine-produced golden vectors
  pin both action payloads/envelopes and the administration content hash; all
  JSON-facing `u64` identifiers remain decimal strings or native lossless
  integer types. This additive surface folds into the still-uncut `3.0.0`
  release and requires the coordinated W32-10 engine/gateway contract
  (`exchange-core >= 2.5.0`) before it is advertised as active.
- **Receipt-carrying terminal withdrawal actions `ConfirmWithdrawalReceipt`
  (`0x22`) and `FailWithdrawalReceipt` (`0x23`)** — the operator-multisig
  withdrawal-settlement phase (W28-20). Each carries a
  `BridgeWithdrawalReceipt` (wire mirror of the frozen 327-byte
  `bridge_core::BridgeReceiptV1`, a fixed 16-field record) plus an
  `OperatorReceiptProof` (a signer bitmap and one 64-byte ed25519 signature per
  set bit — `bridge_core::ReceiptProofV1::OperatorEd25519`). The engine verifies
  the operator quorum signed exactly the receipt bytes in consensus, replacing
  the trusted-relayer assertion of the legacy `ConfirmWithdrawal` (`0x0a`) /
  `FailWithdrawal` (`0x0b`). This is **additive and MINOR in nature** — the two
  legacy actions keep their discriminants and still decode byte-for-byte, and
  transactions produced before this change are unaffected. The encoded payloads
  are **byte-identical to the engine's committed golden vectors**
  (`docs/spec/golden-vectors/{confirm,fail}_withdrawal_receipt.hex` on the
  engine branch), proven by the Rust core test
  `codec::tests::w28_20_receipt_action_golden_vectors`, the conformance vectors
  `confirm_withdrawal_receipt/paid` and `fail_withdrawal_receipt/cancelled`, and
  the TypeScript codec round-trip. Mirrors engine PR #316 (+ gateway #100). The
  change folds into this uncut `3.0.0` release; no separate version bump.
- **`AuthorizeWithdrawal` (`0x24`)** — the authorization leg the terminal
  receipts settle against: the operator-quorum-signed 221-byte
  `WithdrawalAuthorizationV1` bytes (`bridge_core` fixed encoding) plus the
  same `OperatorReceiptProof`. The engine requires it recorded before a
  `0x22`/`0x23` receipt can settle. The engine commits no golden `.hex` for
  this action; the byte pin is `crates/spec/golden-vectors/authorize_withdrawal.hex`,
  derived by encoding the fixture with `exchange-core` itself (engine branch
  commit `c32f7d1`, method control-checked against the committed `0x22`
  vector), asserted by the Rust golden test plus the
  `authorize_withdrawal/operator` conformance vector in all three runners.

### Changed

- **BREAKING — the TypeScript `ExecErrorCode.TimestampNonceRejected` (code 21)
  is renamed `InvalidNonce`** (#63), aligning the TS SDK with the engine
  `ExecError` variant and the Rust/Python bindings, which already used that
  name. `decodeExecError(21).name` / `execErrorName(21)` now return
  `"InvalidNonce"`; any TS consumer keying on the old string must update. Code
  21 is now pinned in the `errors` conformance manifest across all three
  bindings (the `MANIFEST_NAME_DIVERGES` carve-out is removed). Folds into this
  uncut `3.0.0` release; no separate version bump.
- **BREAKING — the action codec and signing now run through a WASM build of the
  Rust core** (ADR 0001). `encodeSignedTx` / `signAndEncode` /
  `signEnvelopeFromPayload` / `encodePayloadBytes` / `decodeTx` are byte-identical
  to the exchange engine _by construction_; the ~770-line hand-written TS codec
  is deleted (`codec.ts` is now a thin adapter over the WASM core). Because WASM
  initializes asynchronously, **call `await ready()` once** (exported from the
  package) before any codec/signing call — `ExchangeClient` does this internally
  (`submitTx` / `ready()`); only raw `signAndEncode` / `decodeTx` callers need
  it. Building and testing now require the Rust + `wasm-bindgen` toolchain
  (`npm run build:wasm`). **The wire format is unchanged** — this is an API/build
  break, not a wire break, but the async-init requirement warrants a MAJOR bump.

### Removed

- The hand-written positional MessagePack codec in `src/codec.ts` (~770 lines of
  encode/decode arms + enum/byte helpers) — superseded by the WASM core and
  `src/codec-adapter.ts` (a name/enum translation layer).

### Fixed

- **The Python client no longer reports a rejected submit as a success** (#7).
  `_check_response` handled a fixed set of statuses and then returned the
  response, so any other non-2xx (400, 402, 405–428, 431, 3xx) was treated as a
  successful submit. Every non-2xx now raises: 5xx stays `GatewayError`
  ("retry with backoff"), and a 3xx/4xx raises `TransportError` carrying
  `status_code` — it must not be blind-retried.
- **`submit_action` no longer defaults a missing engine `code` to 0**, and no
  longer mistakes an unresolved broadcast for a rejection (#7). The four
  documented `/exchange` shapes are now dispatched by body, matching the
  contract the TypeScript binding pins in `submitViaGateway`: a structured
  `code` is authoritative; a code-less `{"status": "ok"}` is a legacy CheckTx
  ack and **succeeds**; a code-less body carrying a hash raises
  `SubmissionPending` (reconcile by hash — **not** a rejection, since calling
  it one would make a trader re-place an order that is about to fill); and a
  bare error string recovers its leading `"<code>: "` engine code, falling back
  to 1. Because `_check_response` has already raised for every status >= 300,
  any non-object body reaching this point is a 2xx compatibility error string
  and is classified as an `EngineError`, not a transport failure — a terminal
  rejection reported as transport would invite a pointless resubmit. A body
  that is valid JSON but not an object (a bare string, a list) no longer
  escapes as a raw `AttributeError`, and a non-JSON body no longer propagates a
  raw `JSONDecodeError`.
- **A default-constructed `ExchangeClient()` no longer clobbers env/TOML
  config** (#8). The `config=None` branch passed the falsy constructor defaults
  (`gateway_url=""`, `api_key=""`, `timeout_secs=0`) straight into
  `load_config`, so configured values were ignored and every request ran with
  `httpx.Timeout(0)` and failed instantly. Only truthy overrides are forwarded
  now, restoring the documented precedence (defaults < env < TOML < explicit).
- **`wasm-bindgen` is exact-pinned (`=0.2.126`)** so `npm run build:wasm` (and
  the `pretest` / `build` / `prepare` scripts that depend on it) cannot break
  when a new `0.2.x` release ships: the wasm-bindgen CLI hard-errors on any
  version mismatch with the crate, and with `Cargo.lock` gitignored a caret
  range let every machine float independently of the installed CLI (#58).
  Install the matching CLI with `cargo install wasm-bindgen-cli --version
0.2.126`; CI already resolves the CLI version from the crate graph.
- **A failed WASM init no longer stays cached.** `ready()` used to memoize the
  first instantiation attempt permanently, so a transient failure (e.g. one
  dropped `.wasm` fetch in a browser) made every later `ready()` — and every
  `ExchangeClient` submit — replay the same rejection until page reload. A
  failed attempt is now cleared and the next call retries instantiation.
- **The codec adapter rejects unknown enum values loudly, by field name.** An
  out-of-range numeric enum on encode (`side: 99`) or an unknown variant name
  on decode used to cross the WASM boundary as `undefined` and surface as
  serde's unrelated-looking `invalid type: unit value`; both directions now
  throw e.g. `unknown side enum value: 99` at the adapter.
- **Byte fields decode by name, not by array-shape guess.** The adapter's
  decode direction converted any non-empty all-numbers array to `Uint8Array`,
  which would silently truncate the first future numeric-list wire field; byte
  fields are now an explicit name set (`owner`, `signer`, `agentPubkey`,
  `primaryOracleSigner`, `solanaDestination`, `solanaTxSig`), an empty byte
  field decodes as an empty `Uint8Array` (previously `[]`), and non-u8 content
  in a byte field throws.
- **`peekActionType()` no longer leaks unknown action-type bytes as
  `ActionTypeValue`** (#56). It now returns `null` for an action-type slot
  this SDK build does not know — an unassigned byte, a newer engine's wire
  type under an older SDK, or a non-numeric msgpack value — matching its
  declared return type. Previously the raw slot value was cast through
  unvalidated, so code trusting the type to imply membership (e.g. indexing
  a `Record<ActionTypeValue, …>`) hit `undefined` at runtime. Callers that
  need the raw byte of an unknown envelope should decode it themselves.
- **Documented price unit corrected: order prices are `u64` micro-USDC (6 dp),
  not cents.** `PlaceOrder.price` and every other wire price field (oracle,
  composite, execution, mark, entry, orderbook, amend) are micro-USDC — the unit
  the engine's `notional_micro` margin math actually consumes — but the SDK docs
  and examples described them as "cents (2 dp)", **off by 10,000×**. Anyone who
  followed the docs mispriced orders by that factor. No wire or logic change (the
  SDK passes the `u64` through unchanged); corrects `types.ts` JSDoc, CLAUDE.md,
  AGENTS.md, and `examples/connect-and-trade.ts`. The gateway `openapi.yaml` and
  some `exchange/docs` still say "cents" for order prices — tracked for the
  platform team to reconcile.

- **`UpdateMarketFees.markSourceMode` was encoded as a bare integer** instead of
  its enum variant name (`"OracleOnly"` / `"Median"`), the form the engine's
  `rmp-serde` (and the gateway's signature re-encoding) produce. A
  `markSourceMode` update signed by the SDK therefore disagreed with the
  gateway's canonical payload and was **rejected at signature verification**. No
  conformance vector exercised it, so it went undetected (surfaced by the WASM
  differential test). Encode now emits the variant name; decode still accepts
  the legacy integer form for back-compat. A regression test pins both.
- TypeScript now emits the canonical 12-field `CreateMarket` for omitted, null,
  zero, and non-zero caps, matching the v2 Rust core and gateway re-encoder. It
  also rejects negative/out-of-u64 non-null cap values before encoding.
- Python market reads decode `MarketConfig.max_open_interest` from slot 24.
- Rust `Event::MarketConfigUpdated` now matches the engine's complete event
  shape, including `im_bps`, `mm_bps`, and `max_open_interest`.
- Rolling-upgrade error-code classification across Rust, TypeScript, and
  Python. Upgraded engines use code 50 for `SlippageExceeded` and the new code
  51 for `OpenInterestLimitExceeded`; code 51 decodes directly without a log.
  Legacy code-50 open-interest rejects remain recognizable from their
  canonical DeliverTx prefix, while absent or unknown code-50 logs resolve to
  `AmbiguousCode50` rather than guessing.
- The public Rust `ExecError` mirror now includes `SlippageExceeded` with code
  50, so constructed Rust errors, the error-kind manifest, and the live engine
  agree on both sides of the 50/51 split.

### Added

- **Admin-actions v2 mirrors: `CreateImpactMarket` + `Batch` proposals**
  (engine Proof-labs/exchange#334) — the engine's two new `AdminAction` arms
  land in every SDK surface: tag 3 `CreateImpactMarket` and tag 4 `Batch`, a
  **closed, non-recursive** list of 2–4 market-creation items
  (`AdminBatchItem` ∈ {`CreateMarket`, `CreateImpactMarket`}) executed
  atomically on chain. Implemented once in the Rust core and inherited by the
  WASM (TS) and PyO3 (Python) bridges; the TypeScript surface adds the union
  arms, the read-model decoders (impact payload with its three
  `serde(default)` trailers, oracle source, batch items — each failing closed
  on unknown variants), a kind→tag **table** replacing the previous two-arm
  ternary, and `Batch` recursion in the codec adapter. The engine's v2 golden
  content hashes and frozen canonical wire bytes are pinned byte-for-byte in
  all three languages, and a `propose_admin_action/batch_perp_plus_impact`
  conformance vector asserts the batch bytes cross-language.
  - **Source compatibility:** widening the `AdminAction` union is a
    source-level break for TypeScript consumers that switch exhaustively over
    `action.kind` (an exhaustiveness check stops compiling until the new arms
    are handled — which is the point: an approving client must decide what it
    renders). The **wire** is backward compatible: every pre-existing payload
    encodes byte-identically, and the new tags never appear unless a client
    builds them.
  - **Versioning:** rides this release's already-staged bumps — npm / Rust
    core / PyO3 / Python at **3.0.0**, WASM crate at **2.1.0** (new enum arms
    accepted by existing exports; no new API), derive crate unchanged at
    **1.1.0**, conformance vectors still labeled **2.0.0** (one additive
    case). No further bump beyond what this release already declares.
  - **Compatible engine / activation ordering:** building or hashing the new
    arms requires an engine with admin-actions v2 (exchange#334;
    `exchange-core >= 2.3.0` — release C, tag `v2.3.0`; the earlier "2.2"
    claim here was wrong, that release predates #334). Order of operations
    matters: this SDK (and the
    clients consuming it — Web Admin, signer-cli) must be **deployed before**
    the engine's `UPGRADE_HEIGHT_ADMIN_ACTIONS_V2` is pinned at release-tag
    time. The proposals read fails closed on unknown action variants, so a v2
    proposal reaching a pre-v2 strict client blanks its proposals page — the
    rollout-ordering precondition in WebAdmin Specs §11.4. Against older
    engines the new surface is inert: decoders tolerate the shorter legacy
    impact-market tuples (12/13 slots), and the v2 tags simply never occur.
- `ExchangeClient.queryImpactMarkets()` — impact-market families via the
  gateway's public read (`GET /v1/impact_markets`). Strict, fail-closed
  decoding in the same posture as the governance reads: missing encoded-data
  envelope, non-list payloads, out-of-range integers, malformed text fields,
  unknown status/outcome/oracle variants, and tuple lengths outside the
  supported 12–15 range are refusals, never partial renders. The three
  incrementally-shipped trailers ([12] `oracleSource` BE-54, [13]
  `description` / [14] `rules` admin-actions v2) decode when present and stay
  `undefined` on older gateways so callers can tell "not served" from
  "empty"; decoders are pinned against engine-serialized golden bytes for the
  current 15-slot and both legacy shapes.
- **Admin-multisig governance action mirrors (W30-11)** — the engine's four
  governance wire actions land in every SDK surface: `ProposeAdminAction`
  (0x1E), `ApproveAdminAction` (0x1F), `RejectAdminAction` (0x20), and the
  single-signer `EmergencyAdminAction` (0x21), with the `AdminAction` /
  `EmergencyAction` inner enums. Implemented once in the Rust core
  (`governance.rs` + `impl_action_encoding!`), inherited by the WASM (TS) and
  PyO3 (Python) bridges by construction; the TypeScript surface adds the typed
  interfaces, the `GovernanceAction` union arm, and the externally-tagged enum
  mapping in the codec adapter. The engine's §2.4 domain-separated proposal
  content hash (`admin_proposal_content_hash`) is reproduced in Rust, pinned
  byte-for-byte against the engine's golden vectors, and exported through the
  WASM and PyO3 bridges (`adminProposalContentHash` on npm,
  `admin_proposal_content_hash` in Python) so an approving client verifies a
  server-supplied hash locally instead of trusting it; the governance codec
  vectors are asserted cross-language. Purely **additive** wire change — every
  pre-existing payload encodes and decodes unchanged (MINOR-class; it ships
  inside this release's already-MAJOR bump). The new action types require an
  engine that knows them: `exchange-core >= 2.1.0`.
- `ExchangeClient.queryProposals()` and
  `ExchangeClient.queryAdminSignerRegistry()` — governance reads via the
  gateway proxies (`/v1/proposals`, `/v1/admin/signer-registry`). An absent
  registry decodes as `null`, meaning admin multisig is **inactive**
  (fail-closed) — deliberately distinct from an empty roster. Their typed
  decoders reject missing envelopes, trailing tuple fields, out-of-range
  integers, and action-tag mismatches instead of partially rendering
  malformed or newer governance state.
- **Governance error codes 52 (`AdminGovernanceInactive`) and 53
  (`NotAdminSigner`)** are mirrored from the consensus contract (exchange #282
  / `ddad45b`) into all three error tables (Rust, TypeScript, Python) and
  pinned by the errors conformance manifest. Previously
  `decodeExecError(52/53)` returned `null`, so a live admin-multisig rejection
  decoded as unknown (#60). Purely additive — no existing code changes
  meaning.
- `errors` conformance-vector family (`conformance/errors.ndjson`) pinning the
  ExecError code→name classification across the Rust, TypeScript, and Python
  SDKs. A bare code pins the numeric `ERROR_KINDS` manifest name (including
  `50 → SlippageExceeded` and `51 → OpenInterestLimitExceeded`, the split that
  the pre-#55 SDK would have failed); a code plus canonical DeliverTx log pins
  the log-aware decoder (transitional code-50 slippage/open-interest cases →
  `AmbiguousCode50` without a recognized log). Generated from the Rust core and
  asserted by all three runners. Every code is pinned, including 21 — the TS
  SDK was aligned to the engine name `InvalidNonce` (see Changed), removing the
  earlier carve-out.
- **`ExchangeClient.submitSignedTx(txBytes)` / `submitSignedTxCommit(txBytes)`**
  — public submission of **externally signed** wire bytes (built via
  `signingMessage()` → external signature → `encodeSignedTx()`), for callers
  that never load a private key into the client: hardware/CLI signers and the
  Web Admin's multisig propose/approve flows. Pure byte-exact transport — the
  bytes are never decoded or re-encoded, so what was signed is exactly what
  the gateway receives (and action types newer than this SDK build still
  submit). `submitSignedTx` routes and reconciles identically to `submitTx`
  (gateway by default, same hash-only background verification);
  `submitSignedTxCommit` shares `submitTxCommit`'s finality logic and returns
  the final chain verdict scoped to the call — added after adversarial review
  flagged that without it, external signers had no deterministic commit path
  under degraded-gateway responses (hash-only ambiguous, legacy CheckTx-only
  ack). Previously the only submission paths required `setPrivateKey`,
  forcing external-signer apps toward hand-rolled `POST /exchange` calls. No
  wire change.
- Aggregate open-interest cap support across Rust, TypeScript, and Python:
  `CreateMarket.maxOpenInterest` is an optional/nullable input normalized to
  an explicit zero tail when uncapped,
  `UpdateMarketFees.maxOpenInterest` occupies the engine's trailing slot 20,
  and `MarketConfig.maxOpenInterest` decodes from slot 24. Legacy 11-field
  `CreateMarket` payloads still decode as uncapped, but every new encoding is
  the canonical 12-field form and decodes the cap as `0` / `0n`.
- **`decodeSigningMessage()` + `DecodedSigningMessage`** — decode a v3
  signing preimage (the exact `signingMessage()` output an external signer
  signs) back into chain id, action type + name, seq, and the decoded
  action, so signer-side tools can show a human WHAT they are about to sign
  on a trust base independent of whoever built the bytes (the Web Admin
  signer CLI is the first consumer; any future hardware-signer tool needs
  the same). Structurally-invalid input (short, wrong domain prefix) throws;
  an unknown action-type byte or undecodable payload degrades honestly to
  `action: null` + `decodeError` with the envelope fields still parsed —
  newer wire actions than the SDK build must never look like structural
  rejections. `DOMAIN_PREFIX` is now exported alongside `ENVELOPE_VERSION`.
  Decode-only; no wire change.
- Rust exports a `Milliseconds` alias for every millisecond timestamp/duration
  wire field and `UpdateMarketFees::new(market, signer)` for concise no-op
  defaults; the alias remains source- and wire-identical to `u64`.
- **`ExecErrorCode` enum** export (#29) — branch on
  `code === ExecErrorCode.InsufficientMargin` instead of a bare `12`; kept in
  agreement with the decode table by a test.
- **`ENVELOPE_VERSION` constant** export (#32) — the wire envelope version byte
  (`2`), replacing the bare literal in the encoders/decoder. Documented as
  distinct from the `"ProofExchange-v3"` signing domain prefix.

### Changed

- **Gateway submissions consume the synchronous on-chain result** (#50) when
  available, so `submitTxCommit` no longer repeats a `/v1/tx/{hash}` poll and
  `submitTx` no longer starts a redundant background verifier. Hash-only error
  responses remain ambiguous and are still reconciled; pre-upgrade gateway
  acknowledgements retain the existing polling behavior.
- `UpdateMarketFees` now includes the engine's existing `imBps` and `mmBps`
  tail slots before `maxOpenInterest`, preventing the OI cap from being
  misinterpreted as a margin-ratio update.
- **`TxResult` gains `ok`, `outcome`, and `error`** (#29; additive — `code` /
  `hash` / `height` / `log` / `events` and existing `result.code === 0` checks
  are unchanged). `ok` is a boolean discriminant; `outcome` is
  `"ok" | "engine" | "transport" | "timeout"`; `error` is the auto-decoded
  `ExecErrorInfo` (null off the engine path). Transport/timeout failures are
  tagged via `outcome` so their synthesized HTTP `code` is not mistaken for an
  engine `ExecError`.
- **`hexToBytes` now throws on malformed input** (#32) — an odd number of digits
  or a non-hex character raises instead of silently zero-filling (`parseInt` →
  `NaN` → `0`), preventing silent corruption of a key/address/signature field.

- **WASM core crate (`crates/proof-trading-sdk-wasm`)** — a `wasm-bindgen`
  binding over the Rust core's `encode_payload_dyn` / `decode_payload_dyn` and
  Ed25519 signing, the JS/WASM sibling of the PyO3 crate. Lets the TypeScript
  codec move to bytes that are identical to the exchange engine _by
  construction_ (see `docs/adr/0001-wasm-core-vs-parallel-types.md`). Built with
  `npm run build:wasm` (Rust + `wasm-bindgen` toolchain); a differential test
  (`src/wasm-codec.test.ts`) proves the WASM reproduces every
  `conformance/codec.ndjson` vector byte-for-byte, including full-`u64`
  precision via BigInt. No wire or TS-API change: this lands the crate alongside
  the existing hand-written codec (both coexist); wiring the TS codec to call it
  is the next step.
- **WASM-backed codec path landed alongside the legacy TS codec** (coexist +
  differential; ADR 0001). A lazy loader (`src/wasm-loader.ts` — `ready()` /
  `getWasm()`) and a TS↔WASM field adapter (`src/codec-adapter.ts`) route the TS
  `Action` shape through the Rust core's `encode_payload`. A differential test
  (`src/codec-adapter.test.ts`) proves the WASM path reproduces the legacy
  encode bytes for representative and complex actions (nested `FeeTier`,
  `EventOracleSource` variants, `legs` arrays, enum fields). Not yet wired into
  the public API — the cutover (routing `codec.ts` through WASM, decode, and
  deleting the hand-written arms) follows.

### Notes

- The differential test surfaced a **latent bug in the hand-written TS codec**
  that no conformance vector covers: `UpdateMarketFees.markSourceMode` is encoded
  as the integer variant index, but the authoritative core (and the Python
  binding) encode it as the enum _name_ — so a legacy-signed `markSourceMode`
  update would fail the gateway's signature check. The WASM path is correct; the
  cutover fixes it. (Operator-only action; narrow blast radius.)

- **Convenience action builders on `ExchangeClient`** — `placeOrder`,
  `marketOrder`, `cancelOrder`, `cancelClientOrder`, `cancelAllOrders`,
  `closePosition` — that fill `owner` from the loaded signer key and wrap
  `submitTx`, so callers stop hand-writing `{ type, data: { owner, … } }`
  literals. Raw `submitTx` / `submitTxCommit` remain for power users.

## [1.1.0]

Additive wire change — **MINOR**. Transactions produced before this release
still decode unchanged; the previous SDK still accepts everything this one
emits (the new action is a new `action_type` byte, and the new
`UpdateMarketFees` tail fields are trailing optionals). Golden vectors
re-diffed; a decode test pins that a pre-change composite payload (no trailing
`publish_time_ms`) still round-trips. Compatible engine: `exchange-core >=
1.1.0, < 2.0.0` (BE-31 composite-median wire).

### Added

- **Operator action `OracleUpdateComposite` (0x14)** across all three bindings
  (Rust crate, TypeScript, Python) — submits a composite-CEX price, BE-31
  Phase B's third mark-price-median source. Gated by a **separate** engine
  feeder allowlist (distinct trust domain from `OracleUpdate`); not a trading
  action. Typed builders carry operator-only docs.
- **Operator/trader segregation in the TS surface:** `Action` is now
  `TraderAction | OperatorAction`; trading integrations can narrow to
  `TraderAction` to keep operator actions out of autocomplete. Purely additive
  — `Action`, `submitTx`, and every existing variant are unchanged.
- `UpdateMarketFees` multi-source-mark tunables (`markSourceMode`,
  `maxMarkSpreadBps`, `cexCompositeStalenessMs`) are now exercised end-to-end
  and covered by conformance.
- Conformance vectors for `OracleUpdateComposite` (full + serde-default-tail
  cases) generated by `crates/spec` and asserted by the Rust, TS, and Python
  runners.

## [1.0.0]

First stable release. Adopts semver-only pinning (off the `0.x` track, so only a
MAJOR difference is wire-incompatible — see CLAUDE.md → "Versioning & wire-format
compatibility"). The **wire format is unchanged** from `0.1.0` (envelope v2,
`ProofExchange-v3` signing domain, 32-byte `chain_id` binding); the MAJOR is
justified by the breaking public-API changes below, not a wire bump.

Compatible engine: `exchange-core >= 1.0.0, < 2.0.0`. The SDK MAJOR tracks the
engine wire MAJOR.

This entry recovers history that accumulated under `[0.1.0]` but went
unrecorded; future releases keep `[Unreleased]` current per-PR instead.

### Added

- Gateway-native streaming feed replacing the direct CometBFT WebSocket, with
  Python/TypeScript parity.
- Single-gateway-URL model: all reads, chain status/blocks, tx-status polling,
  the chain-id bootstrap, and the WebSocket now route through the gateway;
  endpoint config consolidated onto one `gatewayUrl`.
- Python/PyO3 SDK: dedicated action builders for all core action types, plus
  query methods (health, ticker, orderbook, ADL queue, status, blocks,
  history), and an ergonomics pass (StrEnum, hex helpers, default account
  owner).
- TypeScript queries: `queryOpenOrders`, `queryBalance`, `queryEquity`, and
  restored `queryTicker` / `queryAdlQueue` (+ `adl_queue` decode).
- Conformance suite wires every core action type and exports
  `signEnvelopeFromPayload` / `encodePayloadBytes`; codec golden-vector tests
  unskipped.
- Engine parity across all bindings: `CreateMarket` fields and
  `AtomicBasketOrder`.

### Changed

- `ExchangeClient` throws typed errors on API failures instead of silently
  returning `[]` / `null`.
- Owner-scoped reads route via `POST /info`; chain reads via `/v1/*`.

### Removed

- **Breaking:** internal engine abstractions pruned from the public TS, Rust,
  and Python SDK API surface.

### Fixed

- Hardened `/info` decode (Python) and owner-bytes coercion (TS).
- Correct msgpack envelope decode for `markets()` / `orderbook()` (Python).
- E2E suite adapted to the testnet gateway.

### Security

- Secret/leak fixes; removed leaking internal abstractions from the public
  surface; CVE fix and audit gates wired into CI.

## [0.1.0]

Initial public release.

- TypeScript client: Ed25519 signing, MessagePack codec, timestamp-nonce
  allocation, and CometBFT/gateway submission helpers.
- Python package (`proof-trading-sdk`): PyO3 bindings over the shared Rust core
  for signing and codec, with a native HTTP/WebSocket gateway client.
- Wire envelope v2 with the `ProofExchange-v3` signing domain and 32-byte
  `chain_id` binding.

[Unreleased]: https://github.com/Proof-labs/trading-sdk/compare/npm-v4.0.0...HEAD
[4.0.0]: https://github.com/Proof-labs/trading-sdk/compare/npm-v3.0.0...npm-v4.0.0
[3.0.0]: https://github.com/Proof-labs/trading-sdk/releases/tag/npm-v3.0.0
[1.1.0]: https://github.com/Proof-labs/trading-sdk/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Proof-labs/trading-sdk/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Proof-labs/trading-sdk/releases/tag/v0.1.0
