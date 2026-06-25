# Changelog

All notable changes to `@proof/trading-sdk` (and the `proof-trading-sdk` Python
package) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Proof-labs/trading-sdk/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Proof-labs/trading-sdk/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Proof-labs/trading-sdk/releases/tag/v0.1.0
