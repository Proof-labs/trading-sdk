# Changelog

All notable changes to `@proof/trading-sdk` (and the `proof-trading-sdk` Python
package) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
**2.0.0**. Compatible engine: `exchange-core >= 2.0.0, < 3.0.0`.

### Changed

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
  (fail-closed) — deliberately distinct from an empty roster.
- `errors` conformance-vector family (`conformance/errors.ndjson`) pinning the
  ExecError code→name classification across the Rust, TypeScript, and Python
  SDKs. A bare code pins the numeric `ERROR_KINDS` manifest name (including
  `50 → SlippageExceeded` and `51 → OpenInterestLimitExceeded`, the split that
  the pre-#55 SDK would have failed); a code plus canonical DeliverTx log pins
  the log-aware decoder (transitional code-50 slippage/open-interest cases →
  `AmbiguousCode50` without a recognized log). Generated from the Rust core and
  asserted by all three runners. Code 21 is excluded — the TS SDK deliberately
  names it `TimestampNonceRejected` vs the core's `InvalidNonce`, an intentional
  name divergence rather than the code↔code drift this family guards.
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

[Unreleased]: https://github.com/Proof-labs/trading-sdk/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Proof-labs/trading-sdk/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Proof-labs/trading-sdk/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Proof-labs/trading-sdk/releases/tag/v0.1.0
