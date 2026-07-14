# Changelog

All notable changes to `@proof/trading-sdk` (and the `proof-trading-sdk` Python
package) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The npm, Rust core, PyO3, WASM, and Python packages move to **2.0.0** for the
open-interest-cap wire contract. Every v2 `CreateMarket` wire payload now has
one canonical 12-field encoding, including an explicit final `0` for uncapped
markets. The npm input treats omission, null, and explicit zero identically.
That changes its existing uncapped output from 11 to 12 fields and normalizes a
decoded legacy absent tail from `undefined` to `0n`; a v1 gateway/engine cannot
be assumed to accept the new bytes. Frozen v1 `rmp-serde` decoders also reject
populated 12-field `CreateMarket` and 21-field `UpdateMarketFees` payloads, and
the Rust wire structs gain source-incompatible fields. The unchanged derive
crate stays at **1.1.0**; the unpublished conformance crate labels the v2
vectors as **2.0.0**. Compatible engine:
`exchange-core >= 2.0.0, < 3.0.0`.

### Fixed

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

### Added

- Aggregate open-interest cap support across Rust, TypeScript, and Python:
  `CreateMarket.maxOpenInterest` is an optional/nullable input normalized to
  an explicit zero tail when uncapped,
  `UpdateMarketFees.maxOpenInterest` occupies the engine's trailing slot 20,
  and `MarketConfig.maxOpenInterest` decodes from slot 24. Legacy 11-field
  `CreateMarket` payloads still decode as uncapped, but every new encoding is
  the canonical 12-field form and decodes the cap as `0` / `0n`.
- Log-aware error-code classification across Rust, TypeScript, and Python.
  Shared code 50 resolves to `OpenInterestLimitExceeded` or
  `SlippageExceeded` only from the canonical DeliverTx log; absent or unknown
  logs resolve to `AmbiguousCode50` rather than guessing.
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
