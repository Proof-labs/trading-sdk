# proof-sdk-rs

An async (tokio) trading client for the Proof Exchange, built on the
[`proof-trading-sdk`](../proof-trading-sdk) core. The core signs and encodes
transactions exactly as the engine does. This crate adds what a trading bot
needs on top: nonce allocation, submission, receipts, order helpers, typed
reads and the live WebSocket feed.

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
use proof_sdk_rs::{Action, ClientConfig, Event, ExchangeClient, LocalSigner, Side};

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
    // $60,000 for 0.01 BTC (market 1 has sz_decimals = 5; see Units)
    let mut order = client.limit_order(1, Side::Buy, 60_000_000_000, 1_000);
    order.post_only = true;
    order.client_order_id = Some(42);
    let placed = client.submit_and_wait(&Action::PlaceOrder(order), Duration::from_secs(10)).await?;
    match placed.error() {
        None => {
            for e in placed.receipt().into_iter().flat_map(|r| &r.events) {
                if let Event::OrderPlaced(o) = e {
                    println!("resting as order {}", o.order_id);
                }
            }
        }
        Some(e) => eprintln!("refused: {e}"), // e.g. InsufficientMargin (12)
    }

    client.cancel_order_by_client_id(42).await?;
    Ok(())
}
```

Run the bundled example (read-only unless `PROOF_LIVE=1`):

```sh
cargo run -p proof-sdk-rs --example quickstart
cargo run -p proof-sdk-rs --example stream      # book + trades + signed account feed
PROOF_PRIVATE_KEY_HEX=<64 hex> PROOF_LIVE=1 cargo run -p proof-sdk-rs --example quickstart
```

On devnet, fund a new address with the faucet first:
`POST https://faucet.dev.proof.trade/drip` with a bearer token and
`{"address": "0x<address>"}`.

## API

### `ExchangeClient`: sign and submit

| Method                                          | Action / route                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `connect(&config, signer)`                      | reads `GET /v1/status` and `recent-nonces`, binds signatures to the chain |
| `new(&config, signer)`                          | no request; signs for the config's chain id                               |
| `limit_order(market, side, price, qty)`         | builds a GTC `PlaceOrder` for this account                                |
| `place_order(order)`                            | `PlaceOrder`                                                              |
| `market_order(market, side, qty)`               | `MarketOrder` (IOC)                                                       |
| `cancel_order(order_id)`                        | `CancelOrder`                                                             |
| `cancel_order_by_client_id(client_order_id)`    | `CancelClientOrder`                                                       |
| `cancel_all_orders(Option<market>)`             | `CancelAllOrders`                                                         |
| `amend_order(order_id, new_price, new_qty)`     | `AmendOrder` (same-price size cuts keep priority)                         |
| `cancel_replace_order(order_id, order)`         | `CancelReplaceOrder`                                                      |
| `cancel_replace_order_by_client_id(cid, order)` | `CancelReplaceOrder`, cancelling by client id                             |
| `close_position(market)`                        | `ClosePosition`                                                           |
| `submit(&action)`                               | sign with the next nonce, `POST /exchange` once                           |
| `submit_and_wait(&action, timeout)`             | `submit`, then wait if the verdict is pending                             |
| `sign(&action)` / `send(&signed_tx)`            | the two halves, for pre-signing on a hot path                             |
| `sign_with_seq(&action, seq)`                   | sign under a nonce you allocated                                          |
| `wait_for_receipt(hash, timeout)`               | polls `GET /v1/tx/{hash}`                                                 |
| `address()` / `public_key()` / `network()`      | this signer's account, key and chain id                                   |
| `nonces()` / `info()`                           | the shared nonce allocator; the read client                               |
| `ws_config()`                                   | a feed config with this account's signed auth                             |

Every helper is a function in `proof_sdk_rs::actions` with this client's
address, submitted at once. Call those directly to build an `Action` without
sending it: to gate submission yourself, batch, or trade for another owner.

```rust,ignore
use proof_sdk_rs::actions;

let order = client.limit_order(1, Side::Buy, price, 10);
let action = actions::cancel_replace_order_by_client_id(old_cid, order); // keeps brackets
let tx = client.sign(&action)?;
```

Each submission returns a `Submitted`, holding the signed tx with its locally
computed hash, a `TxStatus`, and `retry_after: Option<Duration>`:

| `TxStatus`           | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Committed(receipt)` | In a block. `receipt.error` is `None` on success. `receipt.events` says what it did.                                 |
| `Rejected(error)`    | Refused at `CheckTx`; it will never execute.                                                                         |
| `Pending`            | Admitted without a verdict yet; call `wait_for_receipt`.                                                             |
| `Refused(reason)`    | Turned away by the gateway (`Unauthorized`, `RateLimited`, `Paused`, `CancelOnly`, `Unavailable`, `InvalidRequest`). |

`TxStatus` is exhaustive, so a `match` decides every case. Only `Committed`
executed; `Pending` may still.

`is_success()`, `is_pending()`, `error()` and `receipt()` cover the common
checks. An `EngineError` is `Known(ErrorKind)` (`InsufficientMargin`,
`InvalidNonce`, ...) or `Unknown(code)` for a code newer than this SDK;
`is_order_not_found()` says a cancel or replace found nothing to act on.

The gateway answers once the transaction is in a block, so the receipt
carries its events, typed, in emission order: `Event::OrderPlaced` carries
the resting order's `order_id` (a basket or cancel-replace can emit several),
and `Event::Fill` is each fill it took. An order that fully fills on arrival
emits no `OrderPlaced`. Every account-level event carries the `owner` it
happened to: a fill updates the maker's position as well as yours, in the same
receipt. A kind this SDK does not type stays raw in
`Event::Other`; a typed kind whose attributes do not read stays raw in
`Event::Malformed`, so a bad fill is never mistaken for an unknown event. An
attribute the engine always writes is required, so a renamed one reads as
`Malformed`, never as a silent 0.

**Failed submissions.** The client posts once and keeps no state. Engine
rejections and gateway refusals are `TxStatus`, not errors. When a
submission may have landed without a verdict (transport failure, 5xx,
unreadable answer), every submitting call, the order helpers included,
returns `Error::Unconfirmed { tx, source }` with the exact signed transaction.
Any other `Err` means nothing executed.

```rust,ignore
match client.place_order(order).await {
    Ok(s) => { /* verdict */ }
    Err(Error::Unconfirmed { tx, .. }) => { /* wait_for_receipt(tx.hash), or send(&tx) again */ }
    Err(e) => { /* not sent */ }
}
```

Resending the same `tx` is safe (same nonce, executes at most once).
**Signing the action again makes a second transaction.** Each method's
`# Errors` doc lists what it returns.

### `InfoClient`: reads

`client.info()`, or `InfoClient::new(&config)` for read-only use:

| Method                     | Route                                   | Returns                    |
| -------------------------- | --------------------------------------- | -------------------------- |
| `chain_status()`           | `GET /v1/status`                        | network, height            |
| `markets()`                | `GET /v1/markets`                       | `Vec<MarketConfig>`        |
| `events()` / `event(id)`   | `GET /v1/events`, `/v1/event/{id}`      | `EventInfo` (with books)   |
| `orderbook(market)`        | `GET /v1/orderbook/{market}`            | `Orderbook` (best first)   |
| `recent_trades(market, n)` | `GET /v1/trades/{market}`               | `Vec<Trade>`, newest first |
| `account(owner)`           | `POST /info` `clearinghouseState`       | `AccountInfo`              |
| `account_state(owner)`     | `GET /v1/account/{owner}/state`         | `AccountState` (at height) |
| `open_orders(owner)`       | `POST /info` `openOrders`               | `Vec<Order>`               |
| `recent_nonces(owner)`     | `GET /v1/account/{owner}/recent-nonces` | `Vec<u64>`                 |

Records decode as the engine's own `proof-wire` types through the core's
`reads::decode`, so a field appended by a newer engine does not break a read.
For a route this client does not wrap, use `get_data(path)` (MessagePack bytes
from a `{"data": ...}` route), `get_json(path)` or `post_info(&body)`.

### `WsClient`: live feed (feature `ws`, default)

One socket carries every subscription. A background task (spawned with
`tokio::spawn`, so `connect` needs a tokio runtime) owns it, sends an
app-level ping every 5 s, and reconnects with backoff when nothing at all
arrives for 10 s after a ping, or the socket drops. Each failed attempt is a
`Disconnected`. It then re-sends every subscription, paced to the gateway's
budget (60 at once, then 15 a second).

```rust,no_run
use proof_sdk_rs::{Event, ExchangeClient, Orderbook, Subscription, WsClient, WsMessage};

# async fn run(client: ExchangeClient) -> Result<(), proof_sdk_rs::Error> {
// wss://…/ws, the client's API key, and signed accountEvents subscribes.
let (ws, mut rx) = WsClient::connect(client.ws_config()).await?;
ws.subscribe(Subscription::Orderbook(1))?;
ws.subscribe(Subscription::Trades(1))?;
ws.subscribe(Subscription::AccountEvents(client.address()))?;

let mut book = Orderbook::default();
while let Some(msg) = rx.recv().await {                      // or use it as a `Stream`
    match msg {
        WsMessage::OrderbookSnapshot { book: b, .. } => book = b,
        WsMessage::OrderbookUpdate { side, level, .. } => book.apply(side, level),
        WsMessage::Trade(t) => {}
        WsMessage::AccountSnapshot { account, .. } => {}      // typed AccountInfo
        WsMessage::AccountEvent(e) => match e.event {         // typed, as on a receipt
            Event::Fill(f) => {
                let (side, fee) = if f.maker_owner == client.address() {
                    (f.maker_side, f.maker_fee)               // micro-USDC; negative = rebate
                } else {
                    (f.taker_side(), f.taker_fee)
                };
            }
            Event::OrderPlaced(o) => {}                       // o.order_id, keyed by o.client_order_id
            Event::OrderCancelled(c) => {}
            Event::PositionUpdated(p) => {}
            _ => {}                                           // `Other` / `Malformed`: raw attributes
        },
        WsMessage::Reconnected => {}                          // books re-snapshot next
        WsMessage::Refused { subscription, code, .. } => {}   // no longer held; subscribe again to retry
        WsMessage::Malformed { subscription, .. } => {}       // subscribe again for a fresh snapshot
        _ => {}
    }
}
# Ok(()) }
```

- **Account auth.** Gateways running with an API key, the public devnet among
  them, refuse an unsigned `accountEvents` subscribe with 401.
  `client.ws_config()` sets it up; for a read-only or external signer, use
  `WsConfig::for_gateway(&config).with_account_auth(AccountAuth::new(signer, network))`.
  `AccountAuth` signs
  `"ProofExchange-account-events-v1" || chain_id || owner_hex || after_id || timestamp_ms`
  afresh on every (re)subscribe, through any `Signer`.
- **After a reconnect** each book re-sends its snapshot. Account events from
  the gap are **not** replayed (the TypeScript SDK's history backfill is not
  ported). Reconcile through `InfoClient::open_orders` / `account_state` (balance
  and positions at a block height) if a missed fill matters.
- **Account events are typed** with the same `Event` as receipts: `Fill`,
  `OrderPlaced`, `OrderCancelled`, `OrderAmended`, `OrderRejected`,
  `MarketOrderProcessed`, `PositionUpdated`, `PositionClosed`,
  `FundingSettled`, `Deposited`. Any other kind is `Event::Other`, and a known
  kind whose payload does not read is `Event::Malformed`; both carry the
  engine event name and raw attributes. `tx_hash` is the causing
  transaction's `TxHash`, `None` for block events (funding, expiry);
  `tx_index` and `event_index` place the event in its block.
- **Snapshot boundary.** An `AccountSnapshot` already includes every event at or
  below its `height`; the client drops those if they arrive after it, so
  applying events on top of the snapshot never counts one twice.
- **Resync or retry** by subscribing again: the gateway answers a repeat
  subscribe with a fresh snapshot, in order after the updates already
  delivered. A refused subscription is dropped, so subscribing again retries
  it. The feed has no sequence numbers, so a long-quiet book is worth
  resyncing.
- **Order ids.** Your own submission's receipt events carry them
  (`Event::OrderPlaced`). `OrderPlaced` on the feed carries the same id, with your
  `client_order_id`, for orders placed by another process.
- **Backpressure.** Messages buffer up to `WsConfig::with_buffer` (default 4096). A
  consumer that falls further behind pauses socket reads; frames queued behind
  it still count as signs of life, so a slow consumer does not drop a busy
  socket. Keep the receive loop fast and hand slow work to another task.
- Turn the feature off with `default-features = false` to drop
  `tokio-tungstenite`.

## Nonces

`seq` is a millisecond timestamp. The engine accepts it within 2 days behind
and 1 day ahead of block time, refuses one it remembers, and remembers the last
100 per key: once it holds 100, anything at or below the oldest is refused. So
order does not matter within the last 100. Send roughly in nonce order and keep
fewer than 100 signed-but-unsent transactions per key, or a cancel signed early
but delivered late is refused and its order stays on the book.

`NonceAllocator` hands out `max(now_ms, last + 1)` with one atomic
compare-and-swap, so tasks sharing a client never collide. It refuses to run
more than 60 s ahead of the clock, keeping nonces near where a restarted process
starts. `connect` starts it above the highest nonce the engine remembers for
the key, so a restart never signs behind its predecessor.

Two **processes** signing with one key can collide inside a millisecond. Give
each process its own key, or trading agent.

## Custom signers

`connect` takes any `Signer` (`public_key` plus `try_sign`), so an HSM, KMS or
remote signer plugs in unchanged and the key never enters the process.
`LocalSigner` keeps the key in memory and zeroizes it on drop. The bytes are
identical to `core::codec::sign_and_encode_with_chain`, and a test checks that.

## Configuration

`ClientConfig::new(url)` or `ClientConfig::devnet()`, then:

| Setter                | Default (`devnet()`)          | Notes                                                                |
| --------------------- | ----------------------------- | -------------------------------------------------------------------- |
| _(constructor URL)_   | `https://api.dev.proof.trade` | HTTPS, or HTTP on a loopback **IP** (`http://127.0.0.1:9080`)        |
| `with_chain_id`       | `exchange-devnet-1`           | `connect` checks it against the gateway; unset, `connect` trusts it. |
| `with_api_key`        | none                          | Sent as `X-Api-Key`; redacted from `Debug`.                          |
| `with_timeout`        | 10 s                          | Per request, 1 ms to 60 s.                                           |
| `with_max_read_bytes` | 8 MiB                         | Response cap for reads.                                              |

## Units

Prices, balances and fees are `u64` micro-USDC (`1_000_000` = $1). A quantity
is an integer count of `10^-sz_decimals` base units: on a market with
`sz_decimals = 5`, `100_000` is one whole BTC and `1` is 0.00001 BTC. Prices
must be multiples of `tick_size` and quantities multiples of `lot_size`; all
three are on `MarketConfig`. Nothing is a float.

## Testing

```sh
cargo test -p proof-sdk-rs                              # unit + loopback contract tests
cargo test -p proof-sdk-rs --test devnet -- --ignored   # end to end on devnet: reads and the feed
PROOF_FAUCET_TOKEN=<token> cargo test -p proof-sdk-rs --test devnet -- --ignored  # also trades
```

## License

Apache-2.0.
