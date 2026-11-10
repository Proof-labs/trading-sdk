# proof-trading-sdk (Rust core)

The Rust core of the Proof trading SDK: the MessagePack wire codec, Ed25519
signing, and the action and read types, shared with the exchange engine. It is
the hub of the SDK. The TypeScript SDK (through WebAssembly) and the Python SDK
(through PyO3) are thin bindings over this crate, so all three produce the same
bytes as the engine.

The default build has **no network, no async runtime and no I/O**. That is what
lets it compile to `wasm32-unknown-unknown`. A native gateway transport is
available behind the opt-in `gateway` feature.

> **Building a trading bot?** Use
> [`proof-sdk-rs`](../proof-sdk-rs). It adds nonce
> allocation, submission, receipts, order helpers and typed reads on top of this
> crate, without adding tokio to it.

## Install

The crate is not yet on crates.io (its `proof-wire` dependency is a pinned git
dependency; see [#425](https://github.com/Proof-labs/trading-sdk/issues/425)).
Depend on the repository at a pinned commit:

```toml
[dependencies]
proof-trading-sdk = { git = "https://github.com/Proof-labs/trading-sdk", rev = "<commit>" }

# Native gateway transport (reqwest + tokio). Leave this off for wasm builds.
# proof-trading-sdk = { git = "...", rev = "<commit>", features = ["gateway"] }
```

| Feature   | Default | Adds                                                                                         |
| --------- | ------- | -------------------------------------------------------------------------------------------- |
| _(none)_  | yes     | Codec, signing, wire and read types, error-code decode. No I/O; builds for wasm.            |
| `gateway` | no      | `gateway::GatewayClient`: a bounded, gateway-only HTTPS transport (`reqwest`, `tokio` time). |

## Sign an order

Everything a transaction needs is a typed `Action`, a chain id, a nonce and a
key:

```rust
use ed25519_dalek::SigningKey;
use proof_trading_sdk::{codec, crypto, types::{Action, PlaceOrder, Side, TimeInForce}};

let key = SigningKey::from_bytes(&[7u8; 32]);
let owner = crypto::pubkey_to_owner(&key.verifying_key().to_bytes());
let chain_id = crypto::chain_id_from_string("exchange-devnet-1");

let action = Action::PlaceOrder(PlaceOrder {
    market: 1,
    owner,
    side: Side::Buy,
    price: 66_750_000_000, // $66,750 in micro-USDC
    quantity: 1,           // integer contracts
    client_order_id: Some(42),
    post_only: true,
    time_in_force: TimeInForce::Gtc,
    ..Default::default()
});

// `seq` is a wall-clock-millisecond timestamp nonce, unique per signature.
let seq = 1_762_000_000_000;
let wire = codec::sign_and_encode_with_chain(&chain_id, &action, seq, &key)
    .map_err(|e| e.to_string())?; // `ExecError` implements `Display` only
// Submit `wire` as `{"action": "<base64>"}` to `POST {gateway}/exchange`.
```

To keep the key out of process memory, implement [`Signer`](src/signer.rs) for
your HSM, KMS or remote signer. `LocalSigner` is the in-memory implementation and
zeroizes its key on drop. Sign
`crypto::signing_message(chain_id, action_type, seq, payload)` and assemble the
envelope with `codec::encode_signed_tx_raw`.

## Wire rules

- Every message is a MessagePack **positional array**. Field order is the wire
  layout.
- Envelope: `[version = 2, action_type, seq, payload, pubkey(32), signature(64)]`.
  The signature covers
  `"ProofExchange-v3"(16) || chain_id(32) || action_type(1) || seq(8, BE) || payload`.
  The chain id binding stops a transaction from replaying on another chain.
- `seq` is a millisecond timestamp nonce. The engine checks it against a sliding
  window, not a strict sequence. Reusing a nonce is rejected with code 21
  (`InvalidNonce`).
- Money is `u64` **micro-USDC** (6 dp, `1_000_000` = $1). Quantities are integer
  contracts. Fees and rates are basis points. There are no floats anywhere on the
  wire.
- An owner address is `keccak256(pubkey)[12..32]`: `crypto::pubkey_to_owner`.

## Modules

| Module                            | What it holds                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`, `codec`, `crypto`        | Re-exported from [`proof-wire`](https://github.com/Proof-labs/wire), the engine's own wire crate: `Action` and every payload, encode/decode, signing. |
| `signer`                          | The `Signer` seam (`LocalSigner`, or bring your own custody backend).                                                                                 |
| `errors`                          | Engine result codes as a typed `ErrorKind` (`decode_exec_error_kind`, `error_code_manifest`).                                                         |
| `query`, `reads`                  | Read-model types and `reads::decode`, which tolerates fields a newer engine appends to a stored record.                                              |
| `binary`                          | Trade an event's binary book in No terms (`yes_order`, `yes_limb`, `binary_position_view`).                                                          |
| `ticker`                          | The market ticker rule, checked before signing a `CreateMarket`.                                                                                     |
| `governance`                      | Admin-proposal types and the proposal content hash.                                                                                                  |
| `market_snapshot`                 | The atomic committed markets snapshot (`MarketsSnapshotClient`) and its witness.                                                                     |
| `msgpack`, `wire`                 | Strict MessagePack preflight (`reject_floats`) and byte-field newtypes.                                                                              |
| `gateway` _(feature `gateway`)_   | `GatewayClient`, documented below.                                                                                                                   |

`types` and `codec` are the source of truth for the action set. A new action
appears in this crate when the `proof-wire` pin moves.

## Read decoding

A read whose response type lives in `proof-wire` decodes as that type, through
`reads::decode` and the record's `Shape`:

```rust,ignore
use proof_trading_sdk::{reads, types::MarketConfig};

let bytes = base64_decode(json["data"]); // the gateway's `{"data": "<base64 msgpack>"}`
let markets: Vec<MarketConfig> =
    reads::decode(&bytes, &reads::Shape::List(&reads::MARKET_CONFIG))?;
```

Do not walk the MessagePack by index. An engine that appends a field to a record
breaks an index walk silently, while `reads::decode` cuts the record to the
pinned width and decodes it as the typed struct.

## Gateway transport (`gateway` feature)

`gateway::GatewayClient` is a bounded transport over the public API gateway. It
never reaches the node, and it holds no keys and allocates no nonces:

| Method                              | Route                                       |
| ----------------------------------- | ------------------------------------------- |
| `chain_identity`                    | `GET /v1/status`                            |
| `oracle_permissions`                | `GET /v1/oracle/permissions/{market}`       |
| `account_valuation`                 | `POST /info` (`clearinghouseState`)         |
| `submit_signed_bytes`               | `POST /exchange`                            |
| `submit_signed_bytes_with_evidence` | `POST /exchange`, with the refusal classified |
| `committed_receipt`                 | `GET /v1/tx/{hash}`                         |

The base URL must be HTTPS. Plain HTTP is accepted only for a loopback IP
literal (`http://127.0.0.1:9080`, not `http://localhost:9080`). Redirects,
proxies and automatic retries are disabled, and an API key is sent only as
`X-Api-Key` and never appears in diagnostics.

A `GatewayError` whose `reconcile_hash` is set means the POST may have landed.
Keep the exact signed bytes and reconcile by that hash with `committed_receipt`.
Do not re-sign them under a new nonce. The repository
[README](../../README.md#optional-native-rust-gateway-transport) covers the
submission and refusal contract in full.

A read-only example:

```sh
cargo run -p proof-trading-sdk --features gateway --example gateway_oracle_probe -- \
  http://127.0.0.1:9080 EXPECTED_CHAIN 1
```

## Lint guarantees

This crate inherits the engine's wire-layer lints, enforced under
`cargo clippy`: no `unwrap`/`expect`/`panic`, no float arithmetic, and no
unchecked arithmetic side effects.

## Versioning

The crate follows the wire-format rules in the repository's
[CLAUDE.md](../../CLAUDE.md#versioning--wire-format-compatibility). Any wire
change is at least a MINOR bump, and one that breaks decoding in either direction
is a MAJOR bump. The compatible `proof-wire` major is pinned in `Cargo.toml`.

## License

Apache-2.0.
