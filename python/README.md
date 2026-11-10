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
The server rejects windows wider than roughly 50,000 resolution widths with
`window_too_large`; request a narrower time window even when `limit` is small.
Coarser candles aggregate only source rows inside the requested window, so a
boundary candle may be partial and its label may precede `from_`. Align window
edges to the resolution boundaries when complete historical bars are required;
paging by that partial bar's label does not recover its excluded source rows.
This also applies to a call that omits `from_` on a stride that is not a native
bar (for example `5m`), because the server's default window is not aligned. In
that case `candles[0].time < from_` marks a partial first bar, and its missing
rows are not returned by later pages. Pass aligned `from_` and `to` for complete
history. Native `1m`, `1h` and `1d` bars and calendar strides are not affected.

These are indexer observations, not witnessed finalized-state proofs. A failed
or malformed read raises an SDK error, rather than becoming an empty page.

## Python coverage

Track the remaining Python capabilities and their PRs in
[#362](https://github.com/Proof-labs/trading-sdk/issues/362).
This change covers candle history; capabilities in other open PRs become
available when those changes are merged and released.

## Callback signer

```python
# wallet_public_key is 32 bytes; wallet_sign_raw accepts bytes and returns
# the 64-byte Ed25519 signature from your wallet or device.
client.set_external_signer(pts.ExternalSigner(wallet_public_key, wallet_sign_raw))
envelope = client.sign_action(action)  # Signing only; no network submission.
```

This is the synchronous counterpart of TS `setExternalSigner`. The callback
receives immutable, domain-separated message bytes prepared by Rust. Rust
verifies every signature before it is encoded or returned as account-stream
authentication. `sign_action`, `submit`, owner-derived helpers and
`account_auth` all use the connected signer. The nonce allocator and chain
configuration are unchanged; set the correct chain ID explicitly. Without one,
transaction signing raises `SigningError` before the callback runs.

Connecting snapshots the public key and callable and drops the client's
references to its previous secret key or opaque handle. It cannot erase copies
held by the caller. Connecting another signer while a callback is running
discards the old result with `SigningError`, including reentrant replacement.
The TP/SL helpers bind owner selection to that same connection; replacement
before signing fails without asking the new wallet to sign the old request.
Signature bytes, public-key bytes and payload bytes are copied at the boundary.

Callbacks must return bytes (or a bytearray/memoryview), never an awaitable.
The synchronous API cannot forcibly cancel a wallet prompt or device call; the
callback must provide its own timeout. Ordinary callback failures become a
generic `SigningError` without logging or chaining wallet diagnostics.
`KeyboardInterrupt` and `SystemExit` propagate. Signing does not retry the
callback; account-stream authentication retains its documented bounded retry
policy and signs again on reconnect. Callbacks must therefore tolerate repeated
authentication prompts. Existing `SigningHandle`/PKCS#11 support is unchanged.

## Private account events

`client.account_event_stream(owner)` sends the client's API key when configured.
When a secret key, signing handle or external signer is connected, it also signs the gateway's
subscription challenge on every attempt, matching TypeScript. A stale or
non-admin API key therefore does not suppress valid signed authentication.
The default authentication factory checks the current signer on every attempt,
including one connected after stream creation. The subscribed owner stays fixed;
a signer for another owner produces an error rather than an unsigned fallback.
Set the client's chain ID to the gateway's chain: Python does not resolve it
automatically. `account_auth()` raises `SigningError` for an unbound chain ID
before signing; a stream reports the signing failure through its bounded retry
error frames and never sends an unsigned subscription. An opaque signing handle
keeps private key material in Rust memory or the HSM.

Signed authentication supports the signer's own account only. A trading-agent
grant does not authorize reading another owner's private feed. With a signer,
this restriction also applies when an API key is configured. Use a client with
only an authorized API key for another owner's feed. Before the first
subscription is confirmed, signing failures and gateway error codes 401/429/503
yield error frames and retry on the same socket: at most five retries after the
initial attempt, with default delays of 0.5, 1, 2, 4, and 8 seconds. Every attempt
signs fresh authentication; signing failures never send an unsigned subscription.
Exhaustion yields a final error frame and leaves the socket open without more
subscription attempts. A 403 frame is yielded without retrying or closing.

A matching subscription acknowledgment or account data frame confirms the
subscription and cancels pending retries. Errors after confirmation remain
observable without restarting live delivery. A new connection resets the retry
budget. The synchronous iterator performs retries while it is being consumed;
`stream.close()` cancels pending retries. Synthetic error frames carry the SDK's
fixed `SigningError` text and omit other exception text, which could expose
sensitive diagnostics. HTTP 401/403
refusals during the WebSocket upgrade raise `AuthenticationError` before the
first successful connection. On reconnect, they follow `reconnect_attempts`
and the normal backoff (`None` retries indefinitely), preserving recovery state.
`close()` cancels the wait. This is separate from subscription-error frames.

`client.account_auth(owner, after_id=0)` returns signed subscription parameters.
The optional cursor must be a Python integer in `0..2**53 - 1`, matching the TS
SDK's JSON-safe domain. Zero is signed but omitted from the returned parameters.
Direct helper failures raise `SigningError`. The default account stream signs
cursor zero; its history-based reconnect recovery does not change this cursor.

## Resting orders

`client.open_orders(owner)` returns the shared wire order fields, including
`client_order_id`, `original_quantity`, `filled_quantity`, `created_at_ms`,
`queue_priority`, `time_in_force`, `post_only` and `reduce_only`. Integer values
remain exact; `owner` is 20-byte `bytes`. A missing client ID is `None`.
Legacy six-field orders use the wire's defaults for appended fields: `None`,
zero, `Gtc` and false flags. Zero placement time means no timestamp was recorded.

Malformed or wrong-owner responses, duplicate/out-of-order IDs, zero remaining
quantity, and decoded MessagePack payloads over 1 MiB raise `CodecError`.
This read sends no `limit`, and the gateway refuses a response body over 1 MiB
rather than returning a shorter list, so a very large account gets an error. The
read does not verify a finalized-state witness. The remaining Python API gaps are tracked in
[#362](https://github.com/Proof-labs/trading-sdk/issues/362).

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
