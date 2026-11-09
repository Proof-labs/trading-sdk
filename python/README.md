# proof-trading-sdk

Python SDK for the Proof Exchange — Ed25519 signing, MessagePack codec, and
gateway HTTP/WS client.

## Architecture

This package wraps a shared Rust core (codec + signing) via PyO3. Everything
else — HTTP transport, WebSocket streams, nonce generation, config — is native
Python.

```
pip install proof-trading-sdk
```

## Quick Start

The generated owner must have DevNet test funds before placing an order. Use
an active market and adjust the example price/quantity to its tick/lot sizes.
The example's quantities and prices are integers; prices use micro-USDC.

```python
import proof_trading_sdk as pts

kp = pts.generate_keypair()
owner = pts.pubkey_to_owner(kp["public_key"])
client = pts.ExchangeClient(
    config=pts.SdkConfig(
        gateway_url="https://api.dev.proof.trade",
        chain_id="exchange-devnet-1",
    ),
    secret_key=kp["secret_key"],
)

try:
    state = client.account(owner)
    action = pts.PlaceOrder(
        owner=owner,
        market=1,
        side=pts.Side.Buy,
        price=50_000_000_000,  # $50,000 in micro-USDC
        quantity=1,
        post_only=True,
        time_in_force=pts.TimeInForce.Gtc,
    )
    result = client.submit(action)  # Encode, sign, and submit the typed action.
finally:
    client.close()
```

For separate signing and submission, use `envelope = client.sign_action(action)`
followed by `client.submit_action(envelope)`. `submit_action` accepts signed
bytes, not an action dictionary. Keep private keys and signed envelopes out of
logs. A gateway acknowledgement alone is not a final fill. When the outcome is
uncertain the SDK raises `SubmissionPending` carrying the original transaction
hash as `tx_hash`; reconcile that hash before retrying.

See the full API at `help(proof_trading_sdk)`.

## Candle history

`history_candles` reads durable OHLCV bars through the gateway's
`/v1/history/candles`. Prices and volumes remain decimal strings; timestamps
retain the server's original strings, including nanoseconds and extended years
in wide historical windows. No float conversion is applied.

Values retain the indexer's stored units: `volume` sums raw fill quantities,
and `quote_volume` sums stored price × raw quantity. These are not automatically
converted to human-size units or USDC; historical archives may use a different
price representation. Apply the market and data-era scaling contract before
displaying monetary values.

```python
page = client.history_candles(7, "1h", limit=100)
if page.has_more:
    older_than = page.candles[0].time if page.candles else page.from_
    page = client.history_candles(7, "1h", to=older_than, limit=100)
```

The newest bars in the requested window are returned oldest first. Empty
buckets are omitted. `from_` and `to` accept RFC3339 or integer epoch
milliseconds; `to` is exclusive. Omit `from_` when paging backward to let the
server choose the older window. `earliest` is null when no history exists.
The server accepts unsigned four-digit years in RFC3339 request strings;
extended-year response boundaries require integer epoch milliseconds if reused
as request parameters.
Resolutions use a positive count (1–9999) followed by `m`, `h`, `d`, `w`, `M`
or `y`; uppercase `M` means calendar months. The server decides which resolutions
its deployed version accepts. `limit` is 1–5000 (default 1500).

These are indexer observations, not witnessed finalized-state proofs. A failed
or malformed read raises an SDK error, rather than becoming an empty page.

## Python coverage still pending

Tracked in [#362](https://github.com/Proof-labs/trading-sdk/issues/362):

| Capability | Current Python contract / remaining work |
| --- | --- |
| Public trades | `trades(market)` is an HTTP read. A dedicated public trade subscription is not exposed. |
| Finalized state and chain evidence | `status`, `get_block`, and `get_block_results` return gateway data. They do not verify witnesses or establish a trusted finalized checkpoint. Typed reads and the shared verifier still need Python bindings. |
| Authority, financial state, market statistics, oracle health, liquidation configuration | No dedicated typed Python reads. Expose the shared Rust read decoders through PyO3 before adding methods; do not treat generic dictionaries as verified state. |
| Callback signing | `secret_key` and `SigningHandle` (including PKCS#11) are supported. An arbitrary signing callback cannot be supplied to `ExchangeClient`. |
| Resting order client IDs | `open_orders` returns six fields and omits `client_order_id`. Current upstream order reads support the field; Python needs the extended read contract and validation. Do not infer IDs from order placement or incomplete history. |

`history_candles` covers the candle reader portion of #362. The other rows
remain open; raw HTTP calls outside the SDK are not a supported workaround.

## Typed actions

Every action has a typed builder in `proof_trading_sdk.actions`;
`encode_action` turns it into the action byte and canonical payload through the
Rust core, ready for `sign_and_encode`. `RawAction` remains only for an action
newer than this package.

- **Trading:** `PlaceOrder`, `MarketOrder`, `CancelOrder`, `CancelClientOrder`,
  `CancelAllOrders`, `CancelReplaceOrder`, `AmendOrder`, `ClosePosition`,
  `AtomicBasketOrder`, `SetPositionTriggers`, `CancelPositionTriggers`,
  `SetUserMarketLeverage`, `ApproveAgent`, `RevokeAgent`, `CreateSubAccount`,
  `SubAccountTransfer`, `Deposit`, `Withdraw`, `WithdrawRequest`.
- **Operator (privileged):** `SubmitOracleObservation`, `CreateMarket`, `UpdateMarketFees`,
  `ConfirmDeposit`, `ConfirmWithdrawal`, `FailWithdrawal`,
  `AuthorizeWithdrawal`, `ConfirmWithdrawalReceipt`, `FailWithdrawalReceipt`,
  `ClaimWithdrawalPayout`, `RecordWithdrawalPayout`, `ResolveEvent`.
- **Governance (admin multisig):** `ProposeAdminAction`, `ApproveAdminAction`,
  `RejectAdminAction`, `EmergencyAdminAction`. Their `action` is the inner
  admin action in its externally tagged wire form:

```python
from proof_trading_sdk import actions

policy = actions.SetTriggerMarketConfig(
    market=7, enabled=True, max_trigger_slippage_bps=500,
    max_mark_age_ms=5_000, max_future_publish_skew_ms=1_000, max_active_brackets=4,
)
propose = actions.ProposeAdminAction(
    proposer=owner, registry_version=3,
    action={"SetTriggerMarketConfig": policy.as_wire()},
)
action_type, payload = actions.encode_action(propose)
```

## Position stop-loss / take-profit

```python
from proof_trading_sdk import TriggerLimb

position = next(p for p in client.account(owner).positions if p["market"] == 7)
epoch = position["position_epoch"]
if epoch is None:
    raise RuntimeError("position epoch is not backfilled; trigger placement is unavailable")
policy = next(p for p in client.trigger_market_configs() if p.market == 7)
if policy.state.current is None or not policy.state.current.enabled:
    raise RuntimeError("position triggers are disabled for this market")
client.set_position_triggers(
    market=7,
    owner=owner,
    expected_position_epoch=epoch,
    stop_loss=TriggerLimb(trigger_price=95_000, max_slippage_bps=75),
)

page = client.history_triggers(owner, market=7, limit=100)
while page.next_cursor:
    page = client.history_triggers(
        owner, market=7, limit=100, cursor=page.next_cursor
    )
```

`position_triggers()` is the current-state `/v1/triggers/{owner}` read.
`trigger_status()` is deprecated: `GET /v1/triggers/status` is deleted upstream
(the node dropped it with its activation gates, exchange#619, genesis-first;
the gateway drops it in gateway 4.0.0, api-gateway#175). Trigger actions are
permanently active, so there is nothing to read, and the call fails with the
404 response error once a gateway or node stops serving the route. It will be
removed in the next major version. For a first attach, take the epoch from the
canonical account position read; never guess `1`. `owner` defaults to the
signer, but a version-active trading agent may pass its delegated owner and let
the engine verify authorization.
`trigger_market_configs()` is the strict source for the current and scheduled
market policy; absence means disabled and no client default is substituted.

`history_triggers()` and `history_trigger_markets()` use only the public gateway
history routes. Their dataclass pages preserve chain coordinates, market ids,
and every numeric payload value as strings. `next_cursor` is opaque and bound
to the owner/market/time filters that issued it.

## Trading No on an event's binary book

Each event has one binary book, priced in Yes (the event's `eby_market`).
Buying No at `q` is selling Yes at `$1 - q`; the helpers return that Yes
`PlaceOrder`, ready to sign and submit like any other action:

```python
order = pts.buy_no(market=event_book, owner=owner, price=400_000, quantity=10)  # Yes sell at 0.60
order = pts.sell_no(market=event_book, owner=owner, price=300_000, quantity=10, reduce_only=True)
view = pts.binary_position_view("Sell", 600_000, 40)  # No at 0.40, size 40
```

No-priced `stop_loss`/`take_profit` limbs keep their role at the mirrored
trigger. A No price of 0 or `$1` raises `BinaryPriceError`. The translation is
pinned against the Rust core by `conformance/binary.ndjson`.

## Timestamp Nonces

Every signed transaction carries a **timestamp nonce** (`seq`) — a millisecond
Unix timestamp chosen by the client. The SDK allocates nonces via:

```
nonce = max(now_ms, last_nonce + 1)
```

### Why timestamp nonces

Traditional sequential nonces force callers to track a counter and handle
dropped-transaction drift. Timestamp nonces eliminate the client-side counter:
if the engine rejects a nonce (code 21), the caller signs a fresh envelope
with the current wall-clock time and resubmits. No replay-advancement protocol
needed.

### Engine validation

The engine maintains a per-account sorted `Vec<u64>` of recent nonces (capacity
100). On `DeliverTx` it checks:

| Condition | Result |
|-----------|--------|
| `nonce < block_time - 2 days` | `InvalidNonce` (21) — too old |
| `nonce > block_time + 1 day` | `InvalidNonce` (21) — too far future |
| `nonce` already in recent set | `InvalidNonce` (21) — replay |
| recent set full and `nonce <= oldest retained` | `InvalidNonce` (21) — below oldest |

All four map to code 21. Nonces are **burned on success** (the nonce is
persisted even if the handler fails). Only invalid signatures skip the burn.

### Thread safety

`NonceAllocator` is lock-protected and safe for concurrent callers.

### Crash recovery

The allocator is in-memory and does not persist its high-water mark. On restart,
the first allocation uses `now_ms`; this can repeat an already-used nonce or fall
below a previous high-water mark after a burst or clock adjustment. A restart in
the same millisecond is not the only collision case.

A confirmed code-21 rejection permits a fresh nonce allocation, but another
collision is possible. For a submission whose outcome is unknown, reconcile the
original transaction hash before signing a replacement; do not treat a timeout
as a confirmed nonce rejection.

### Multi-process safety

Uniqueness is guaranteed only for callers sharing one `NonceAllocator` instance.
Independent instances or processes can observe the same millisecond and return
the same nonce. Coordinate allocation across workers sharing an account; the
allocator's lock does not coordinate separate instances or processes. The engine
accepts out-of-order unique nonces within its window and rejects replays.

### Key properties

- No sequential ordering required — nonces can arrive out of order
- No sync call needed before the first transaction
- Thread-safe allocation within one shared allocator instance
- Wide engine window (+1 day / −2 days) tolerates NTP skew
