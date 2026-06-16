# Changelog

All notable changes to `@proof/trading-sdk` (and the `proof-trading-sdk` Python
package) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

Initial public release.

- TypeScript client: Ed25519 signing, MessagePack codec, timestamp-nonce
  allocation, and CometBFT/gateway submission helpers.
- Python package (`proof-trading-sdk`): PyO3 bindings over the shared Rust core
  for signing and codec, with a native HTTP/WebSocket gateway client.
- Wire envelope v2 with the `ProofExchange-v3` signing domain and 32-byte
  `chain_id` binding.

[Unreleased]: https://github.com/Proof-labs/trading-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Proof-labs/trading-sdk/releases/tag/v0.1.0
