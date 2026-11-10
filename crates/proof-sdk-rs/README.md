# proof-sdk-rs

An async (tokio) trading client for the Proof Exchange, built on the
[`proof-trading-sdk`](../proof-trading-sdk) core. The core signs and encodes
transactions exactly as the engine does. This crate adds what a trading bot
needs on top: nonce allocation, submission, receipts, order helpers and typed
reads.

- **Thin and fast.** Signing is pure CPU (no I/O, no locks). The nonce
  allocator is a single atomic. Clones share one keep-alive connection pool.
  Every call is exactly one request, with no hidden retries.
- **Unopinionated.** No strategy, no order book cache, no background tasks. Use
  the typed helpers, or sign any `Action` yourself and submit it.
- **Gateway only.** Every request goes to the API gateway; there is no
  direct-node path.
- **Keeps the core lean.** tokio and reqwest live here, not in the core, so the
  core's wasm build and the TypeScript and Python SDKs over it are unaffected.

## Install

Not yet on crates.io (see [#425](https://github.com/Proof-labs/trading-sdk/issues/425)).
Depend on the repository at a pinned commit:

```toml
[dependencies]
proof-sdk-rs = { git = "https://github.com/Proof-labs/trading-sdk", rev = "<commit>" }
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

The core is re-exported as `proof_sdk_rs::core`, so one dependency
is enough.

## Quick start

```rust,no_run
use std::time::Duration;
use proof_sdk_rs::{Action, ClientConfig, ExchangeClient, LocalSigner, Side};

#[tokio::main]
async fn main() -> Result<(), proof_sdk_rs::Error> {
    let seed = proof_sdk_rs::random_seed(); // or load your own 32-byte seed
    let client = ExchangeClient::connect(&ClientConfig::devnet(), LocalSigner::from_bytes(&seed)).await?;
    println!("trading as 0x{}", client.address());

    // Reads
    let book = client.info().orderbook(1).await?;
    let account = client.info().account(client.address()).await?;
    println!("bid {:?} ask {:?} balance {}", book.best_bid(), book.best_ask(), account.balance);

    // A post-only bid, tagged with a client order id
    let mut order = client.limit_order(1, Side::Buy, 60_000_000_000, 1); // $60,000 x 1
    order.post_only = true;
    order.client_order_id = Some(42);
    let placed = client.submit_and_wait(&Action::PlaceOrder(order), Duration::from_secs(10)).await?;
    if let Some(code) = placed.error_code() {
        eprintln!("refused: {:?}", proof_sdk_rs::core::decode_exec_error_kind(code, None));
    }

    client.cancel_client_order(42).await?;
    Ok(())
}
```

Run the bundled example (read-only unless `PROOF_LIVE=1`):

```sh
cargo run -p proof-sdk-rs --example quickstart
PROOF_PRIVATE_KEY_HEX=<64 hex> PROOF_LIVE=1 cargo run -p proof-sdk-rs --example quickstart
```

On devnet, fund a new address with the faucet first:
`POST https://faucet.dev.proof.trade/drip` with a bearer token and
`{"address": "0x<address>"}`.

## API

### `ExchangeClient`: sign and submit

| Method                                          | Action / route                                     |
| ----------------------------------------------- | -------------------------------------------------- |
| `connect(&config, signer)`                      | reads `GET /v1/status`, binds signatures to it     |
| `offline(&config, signer)`                      | no request; signs for `config.chain_id`            |
| `limit_order(market, side, price, qty)`         | builds a GTC `PlaceOrder` for this account         |
| `place_order(order)`                            | `PlaceOrder`                                       |
| `market_order(market, side, qty)`               | `MarketOrder` (IOC)                                |
| `cancel_order(order_id)`                        | `CancelOrder`                                      |
| `cancel_client_order(client_order_id)`          | `CancelClientOrder`                                |
| `cancel_all_orders(Option<market>)`             | `CancelAllOrders`                                  |
| `amend_order(order_id, new_price, new_qty)`     | `AmendOrder` (same-price size cuts keep priority)  |
| `cancel_replace_order(order)`                   | `CancelReplaceOrder`                               |
| `close_position(market)`                        | `ClosePosition`                                    |
| `submit(&action)`                               | sign with the next nonce, `POST /exchange` once    |
| `submit_and_wait(&action, timeout)`             | `submit`, then wait if the verdict is pending      |
| `sign(&action)` / `send(signed_tx)`             | the two halves, for pre-signing on a hot path      |
| `wait_for_receipt(hash, timeout)`               | polls `GET /v1/tx/{hash}`                          |

Each submission returns a `Submitted`, holding the signed tx with its locally
computed hash plus the gateway's `SubmissionOutcome`:

| Outcome                           | Meaning                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `Committed(receipt)`              | In a block. `receipt.code == 0` is success; otherwise an engine error. |
| `CheckTxRejected { code }`        | Refused before the mempool; it will never execute.                     |
| `Pending { hash }`                | Admitted without a verdict yet; call `wait_for_receipt`.               |
| `RejectedBeforeAdmission { .. }`  | Gateway refusal (auth, rate limit, maintenance); see `retry_after`.     |

`is_success()`, `is_pending()` and `error_code()` cover the common checks. Error
codes decode with `core::decode_exec_error_kind(code, None)` (for example 12 is insufficient
margin and 21 is an invalid nonce).

**Ambiguous submissions.** If the POST may have reached the gateway but no
verdict came back (timeout, 5xx, unreadable body), `send` returns
`Error::Ambiguous { tx, .. }` carrying the exact signed bytes. Reconcile with
`wait_for_receipt(tx.hash, ..)`. **Do not re-sign the same intent under a new
nonce.** Both copies could execute.

### `InfoClient`: reads

`client.info()`, or `InfoClient::new(&config)` for read-only use:

| Method                      | Route                                   | Returns                    |
| --------------------------- | --------------------------------------- | -------------------------- |
| `chain_identity()`          | `GET /v1/status`                        | network, chain binding     |
| `markets()`                 | `GET /v1/markets`                       | `Vec<MarketConfig>`        |
| `events()` / `event(id)`    | `GET /v1/events`, `/v1/event/{id}`      | `EventInfo` (with books)   |
| `orderbook(market)`         | `GET /v1/orderbook/{market}`            | `Orderbook` (best first)   |
| `recent_trades(market, n)`  | `GET /v1/trades/{market}`               | `Vec<Trade>`, newest first |
| `account(owner)`            | `POST /info` `clearinghouseState`       | `AccountInfo`              |
| `open_orders(owner)`        | `POST /info` `openOrders`               | `Vec<Order>`               |
| `recent_nonces(owner)`      | `GET /v1/account/{owner}/recent-nonces` | `Vec<u64>`                 |

Records decode as the engine's own `proof-wire` types through the core's
`reads::decode`, so a field appended by a newer engine does not break a read.
For a route this client does not wrap, use `get_data(path)` (MessagePack bytes
from a `{"data": ...}` route), `get_json(path)` or `post_info(&body)`.

## Nonces

`seq` is a millisecond timestamp. The engine accepts any unseen value inside a
sliding window and does not require a strict sequence. `NonceAllocator` hands
out `max(now_ms, last + 1)` with one atomic compare-and-swap, so tasks sharing a
client never collide. It refuses to run more than 60 s ahead of the clock.

Two **processes** signing with one key can collide inside a millisecond. Give
each process its own key, or trading agent. After a restart, pass
`recent_nonces(owner).max()` to `nonces().next_after(..)` if the old process may
still have nonces ahead of the clock.

## Custom signers

`connect` takes any `Signer` (`public_key` plus `try_sign`), so an HSM, KMS or
remote signer plugs in unchanged and the key never enters the process.
`LocalSigner` keeps the key in memory and zeroizes it on drop. The bytes are
identical to `core::codec::sign_and_encode_with_chain`, and a test checks that.

## Configuration

| `ClientConfig` field | Default                       | Notes                                                               |
| -------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `gateway_url`        | `https://api.dev.proof.trade` | HTTPS, or HTTP on a loopback **IP** (`http://127.0.0.1:9080`)       |
| `chain_id`           | `exchange-devnet-1`           | `connect` checks it against the gateway; `None` trusts the gateway. |
| `api_key`            | none                          | Sent as `X-Api-Key`; redacted from `Debug`.                         |
| `timeout`            | 10 s                          | Per request, 1 ms to 60 s.                                          |
| `max_read_bytes`     | 8 MiB                         | Response cap for reads.                                             |

## Units

Prices, balances and fees are `u64` micro-USDC (`1_000_000` = $1). Quantities
are integer contracts. Round prices to the market's `tick_size` and quantities to
its `lot_size` (both on `MarketConfig`). Nothing is a float.

## Testing

```sh
cargo test -p proof-sdk-rs                     # unit + loopback contract tests
cargo test -p proof-sdk-rs --test devnet -- --ignored   # read-only devnet smoke
```

## License

Apache-2.0.
