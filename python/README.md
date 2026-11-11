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

## Governance reads

```python
authorities = client.authorities()
config = client.liquidation_config()
print(authorities.relayer, config.sequence, config.config.takeover_discount_bps)
```

`authorities()` reads `/v1/admin/authorities` as `AuthoritiesSnapshot`: six
lists of 20-byte addresses (`relayer`, `oracle`, `cex_composite`, `custody`,
`market_params`, `scheduled_ops`). Empty sets are valid; a failed read raises
instead of returning empty sets. Membership facts do not prove that a proposed
action is authorized or that the response is authentic.

`liquidation_config()` reads `/v1/liquidation-config` as `LiquidationConfigInfo`
with exact integer `sequence` and typed `config`. The config includes
`target_ratio_bps`, `full_close_threshold` (numerator/denominator),
`partial_penalty_bps`, `max_book_orders`, `max_committed_fills`, and
`takeover_discount_bps`. The two pacing fields remain readable for wire
compatibility; the engine no longer applies those caps. Legacy five-field
configs default the takeover discount to 50, matching the canonical wire type.
Read decoding preserves numeric facts without enforcing action-admission rules.
For example, a structurally valid `full_close_threshold` with denominator zero
is returned unchanged, matching TypeScript. Check the denominator before division;
successful decoding does not establish that a configuration is usable.

`decode_authorities_snapshot` and `decode_liquidation_config_info` accept the
complete gateway `{"data": "<base64 MessagePack>"}` envelope. Rust owns the wire
decoding. Exact tuple widths, address lengths, integer ranges, 4096 entries per
authority set, and a 1 MiB decoded payload cap are checked; the byte cap can be
reached first when every set is near full. Malformed data raises `CodecError`; HTTP failures retain existing SDK exceptions with no fallback.
These methods use the existing client transport and configured timeout; the
payload cap is checked after HTTP buffering and is not a streaming HTTP-body
limit. They return no finalized witness or cryptographic proof.

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
sensitive diagnostics. Connection failures follow the shared retry policy below,
separately from subscription-error frames. Account reconnects preserve recovery
state and follow `reconnect_attempts` (`None` retries indefinitely).

`client.account_auth(owner, after_id=0)` returns signed subscription parameters.
The optional cursor must be a Python integer in `0..2**53 - 1`, matching the TS
SDK's JSON-safe domain. Zero is signed but omitted from the returned parameters.
Direct helper failures raise `SigningError`. The default account stream signs
cursor zero; its history-based reconnect recovery does not change this cursor.

All three stream classes share connection, cleanup and reconnect handling in
`streams.py`. Before the first successful connection, HTTP 401/403 raises
`AuthenticationError`; other HTTP 4xx except 408/429 raises `TransportError`.
Temporary connection failures (network errors, timeouts, HTTP 408/429 and 5xx)
retry with cancelable exponential backoff, including on startup. Other startup
errors raise `TransportError`. After connecting once, connection failures retry.
A matching subscription acknowledgment or non-error data frame resets attempts
and backoff; a handshake, unrelated acknowledgment or refusal does not.

Account streams retain their signed-subscription retries and history recovery.
Exhausting a configured reconnect budget raises `TransportError` and closes the
stream. Each stream accepts base URLs or `/ws` endpoints and permits one active
iterator. Closing the iterator closes its stream; context managers and `close()`
also release the socket and cancel waits. Iterating after explicit `close()` is
empty; after failure or iterator closure it raises `RuntimeError`, requiring a
new stream. `reconnect_backoff_max` must be finite and positive. These startup
and iterator contract changes are for the next Python MAJOR release.

## Public trade stream

```python
with client.trade_stream(7) as stream:
    for frame in stream:
        if frame["type"] == "error":
            print(frame["error"])
            break
        else:
            print(frame["fillId"], frame["price"], frame["quantity"])
```

`PublicTradeStream(ws_url, market, api_key="")` is also exported. `trade_stream`
uses the client's gateway URL and optional API key; `ws_url=` overrides the
WebSocket base URL or an endpoint already ending in `/ws`; it never adds a
second `/ws` suffix. No account signer is called. Each stream owns one socket;
`close()` or its context manager releases it, independently of `client.close()`.

The first public data is a live `trade`, not a snapshot. Frames retain the
TypeScript feed's gateway keys: `channel`, `type`, `market`, `fillId`,
`makerSide`, `price`, `quantity`, and `payload`. Numeric strings remain strings,
and gateway `null` values remain `None`;
`price` is integer micro-USDC and `quantity` is the raw integer size. Divide
quantity by `10**sz_decimals` from the market configuration for base units;
the stream performs no conversion. Only the requested
channel/market and matching subscription errors are delivered. Control ACKs
are consumed internally. A matching subscription refusal is yielded once; the
next iteration raises `TransportError` with its code and closes the socket.
It does not leave an unsubscribed iterator waiting indefinitely or retry the
refusal automatically. Call `close()` or exit the context manager after handling
an error frame if you do not need the exception.

Connections follow the shared retry policy above. Reconnects resubscribe with
0.5-second exponential backoff, capped at 10 seconds by default
(`reconnect_backoff_max` overrides the cap).
Only one iterator may consume a stream, and reconnect work proceeds as it is
consumed. There is no replay, deduplication or HTTP backfill: disconnected or
slow consumers can miss fills, including gateway queue drops that have no
client-visible gap notification. A stalled consumer can also fill receive queues
and lose the socket; reconnecting does not recover those missed fills.

Python now requires `websockets>=15` for synchronous keepalive; installations
pinned to version 14 must upgrade. The stream explicitly sends protocol-level
Ping frames every 15 seconds and closes an unresponsive socket after a
10-second Pong timeout. TypeScript uses JSON ping/pong frames with those
intervals instead. Both detect half-open connections, but Python's keepalive
runs in the library thread while reconnection waits for iterator consumption.
Closing cancels receive and backoff waits; a connection handshake already in
progress completes or reaches the library's connection timeout before cleanup.
Against a peer that has stopped responding, `close()` itself can block for the
library's 10-second close timeout.

`websockets` 15 connects through proxies named by environment variables such as
`HTTPS_PROXY` by default, and this applies to every WebSocket in this package.

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

## Block headers and witness comparison

`client.block_header(height, chain_id=...)` reads a typed `BlockEvidenceHeader`
through `/v1/block`. The chain pin is required on each call, as a chain name or
32-byte binding; implicit client/environment defaults are not trust pins.
Heights are exact Python integers and timestamps retain their nanoseconds.

```python
from proof_trading_sdk import decode_finalized_read_witness, verify_witness

# witness_json is the witness object accompanying a gateway finalized read.
witness = decode_finalized_read_witness(witness_json)
header = client.block_header(witness.height + 1, chain_id="exchange-devnet-1")
verify_witness(witness, header, chain_id="exchange-devnet-1")
```

When the read's payload supplies its own height/time, pass `expected_height`
and `expected_time_ms` to `decode_finalized_read_witness` to bind those values.
Parse `witness_json` with a parser that refuses duplicate keys: plain `json.loads`
silently keeps the last value, and only `block_header` applies this check itself.
`verify_witness` checks the pinned chain, H+1 height and app hash. It deliberately
does not compare H's witness time with H+1's header time. Success against a
header from the same gateway establishes consistency of that gateway's claims;
it does not authenticate the state, verify validator signatures or the block
hash, prove payload contents, or establish freshness or permission to trade.
`decode_block_evidence_header` accepts a complete, already-parsed JSON-RPC
envelope, not a bare `result` object. `get_block` keeps its raw response API.

The full block response is fetched, even though only the header is retained.
Responses over 1 MiB, over 4096 chunks, deeper than 32 JSON containers, duplicate
keys at any depth, invalid UTF-8, and compressed bodies are refused. Large blocks
therefore require a future header-only gateway route. No redirect, retry or
alternate endpoint is used. HTTP refusals retain the SDK's existing exception
types and their bodies are discarded.

`timeout` is in seconds: default 5, minimum 0.001, maximum 60. Python bounds each
network wait and checks elapsed time between body chunks; unlike the TS async
deadline, this cannot interrupt slowly arriving headers or a custom transport
that ignores timeouts. `GatewayReadError.kind` distinguishes `configuration`,
`malformed`, `binding`, `limit`, and `deadline`; `field` identifies the failed
check. Missing/pruned blocks remain errors, not empty evidence.
The H+1 block may not exist yet when a fresh witness is received; wait for it
to be committed before retrying the same height.

## Finalized raw account state

Owner arrays accept exact byte values (0–255) regardless of integer encoding width,
matching TypeScript. Six-field position records default the omitted remainder to zero;
that layout is not limited to historical records.

`client.finalized_account_state(owner, timeout=5)` reads
`/v1/account/{owner}/state?witness=1` and returns `FinalizedAccountState`.
The existing `account()` method and its valued `AccountState` remain unchanged.

```python
state = client.finalized_account_state(owner)
print(state.finalized_height, state.balance, state.positions)
# Optional separate comparison; the H+1 block must already exist.
header = client.block_header(state.finalized_height + 1, chain_id="exchange-devnet-1")
verify_witness(state.witness, header, chain_id="exchange-devnet-1")
```

The result contains `owner`, `finalized_height`, `balance`, `positions`, and
`witness`. Each `RawAccountPosition` contains `owner`, `market`, `side`,
`entry_price`, `size`, signed `last_funding_index`, and `entry_remainder`.
All numeric fields are exact Python integers. The remainder defaults to zero
for legacy six-field positions; position cost is `entry_price * size + entry_remainder`.
Owners are lowercase 40-character hex; inputs also accept 20-byte addresses,
uppercase hex and an optional `0x` prefix.

The canonical Rust wire decoder checks minimum account/position field counts (appended engine fields are ignored),
20-byte owners, request/position owner bindings, strictly increasing market IDs,
at most 2048 positions, integer ranges, and remainder bounds. The response must
contain exactly `data` and `witness`; the witness must have its five defined
fields and match the payload height. Canonical base64 is limited to 512 KiB of
decoded MessagePack. Malformed or mismatched data raises `GatewayReadError`;
missing witness support is an error with no legacy fallback.

This read uses the block-header reader's bounded HTTP and synchronous timeout
policy above. It makes one request and never fetches an H+1 header automatically.
These are settled ledger facts, without current marks, accrued funding, PnL,
equity, margin or withdrawal/trading authorization. The witness is a gateway
assertion; decoding it does not prove payload contents or consensus authenticity.

## Finalized market reads

```python
book = client.finalized_orderbook(3, depth=20)
snapshot = client.finalized_markets_snapshot(chain_id="exchange-devnet-1")
```

`finalized_orderbook()` returns `FinalizedOrderbook` with market, requested
depth, height, typed bids/asks (`price`, `total_qty`, `order_count`) and witness.
Depth is 1, 20 or 100 (default 20); the result does not assert a complete book.
The canonical Rust decoder validates exact two-side/three-field tuples,
integer ranges, per-side depth and strictly descending bids/ascending asks.
The gateway frame must match the requested market/depth and witness height.
The optional legacy `data` field must match `bookMsgpackB64` when present.
Its JSON numeric height must be a safe positive integer, as in TS;
MessagePack level values retain the full u64 range. Decoded books are capped
at 512 KiB. Extra frame/witness fields are tolerated.

`finalized_markets_snapshot()` extends the existing `MarketsSnapshot` with its
witness and reuses the canonical decoder. `chain_id` is mandatory on each call,
as a chain name or 32-byte binding. Wrong chains and uncommitted snapshots are
binding errors. Existing `markets_snapshot()`, `orderbook()` and WebSocket
`orderbook_snapshot()` remain unchanged. Standalone decoders are exported as
`decode_finalized_orderbook` and `decode_finalized_markets_snapshot`.

Both use the bounded HTTP and synchronous timeout policy described above:
1 MiB response, 4096 chunks, no redirect/retry/fallback. Defaults are 5 seconds
for the book and 10 for markets. Neither fetches an H+1 header automatically;
call `block_header` and `verify_witness` separately for that consistency check.
Witnesses remain gateway assertions, without validator signatures, payload
proofs, freshness guarantees or trading authorization.

## Transaction and block-result evidence

```python
# exact_signed_bytes must be the original envelope, not reconstructed fields.
tx = client.transaction_evidence(tx_hash, exact_signed_bytes, chain_id="exchange-devnet-1")
blocks = client.block_results_range(100, 102, chain_id="exchange-devnet-1")
window = client.block_results_window(from_ms, to_ms, through_height,
                                     chain_id="exchange-devnet-1")
```

These reads return typed `TransactionEvidence`, `BlockResultsRange`, and
`BlockResultsWindow` with `source="trusted-gateway"`. Transaction evidence binds
the requested hash and exact signed bytes to the returned block index and
Comet transaction Merkle root. Range/window evidence checks consecutive heights,
parent hashes, nondecreasing nanosecond timestamps, transaction roots, and each
post-state app hash against the next header. The retained H+1 `anchor` must exist.

A range includes both requested heights. A window includes a block strictly
before `from_ms` (or genesis) and the requested `through_height`, whose time must
reach `to_ms`. Boundary blocks are retained: callers apply `[from_ms, to_ms)`
themselves. No partial result is returned when coverage or a limit fails.

Every call requires an explicit chain pin and uses one shared timeout across
all requests, with the synchronous HTTP limitations described above. Each
response has the same 1 MiB/4096-chunk/depth-32 bounds as `block_header`.
Transaction inputs are limited to 785,664 bytes before HTTP, allowing for base64
expansion and a 1 KiB envelope reserve. This is only a payload upper bound, not
an assurance that either response fits. Transaction events, block headers,
validator commit signatures and other transactions share the 1 MiB response
budget; either the transaction or block response can exceed it.
Range/window defaults are 32 heights, 8 MiB decoded JSON, 10,000 transactions,
16,384 events and 65,536 attributes. `max_heights` may be raised to 128; other
limits may only be reduced. JSON byte accounting conservatively allows for
number formatting differences, so floating metadata may exhaust the byte
budget earlier than in TypeScript. Numeric evidence fields never accept floats.

Execution codes and raw event strings are gateway observations, not authenticated
receipts or interpreted financial values. Execution codes are not checked against
H+1 `last_results_hash`. These methods do not verify validator
signatures, recompute block hashes, prove events or state payloads, establish
freshness/finality, or prove that a transaction was never admitted. A returned
replay refusal cannot exclude an earlier successful occurrence. Missing/pruned
data remains an error. The raw `get_block`/`get_block_results` APIs are unchanged.

## Typed actions

Every action has a typed builder in `proof_trading_sdk.actions`;
`encode_action` turns it into the action byte and canonical payload through the
Rust core, ready for `sign_and_encode`. `RawAction` remains only for an action
newer than this package.

`SetUserMarketLeverage` has a typed builder, but ordinary-account submission is
unsupported. See [availability](../README.md#setusermarketleverage-availability).

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

### Finalized account reads

Positions and open orders preserve market ID zero; market IDs use the wire u32 domain.

```python
account = client.finalized_account(owner)
authorization = client.finalized_agent_authorization(owner, agent)
nonces = client.finalized_recent_nonces(owner)
orders = client.finalized_open_orders(owner, limit=101)
```

These opt-in reads return typed values and a `FinalizedReadWitness`. Existing
`account()` and `open_orders()` behavior is unchanged. Account values come from
canonical Rust `AccountInfo`/`PositionBrief`; Python integers preserve u64/i64
precision. `positions`, `binding_scenario`, and the fourteen order fields use
snake_case. Position owners are 20-byte `bytes` (matching the existing valued
position convention); result and order owners are canonical lowercase hex strings.
`cashout_equity` is the engine's display estimate, not guaranteed
execution proceeds. Funding, PnL and margin are returned without recomputation;
they do not establish trading authorization or solvency.

Each payload is limited to 512 KiB. The shared bounded transport caps the full
JSON body at 1 MiB, 4096 nonempty chunks and depth 32. The envelope has exactly
`data` and `witness`, and the witness exactly five fields. All methods default
to a 5-second timeout (0.001–60); synchronous network waits and between-chunk
elapsed checks do not guarantee a hard whole-call deadline for slow headers or
custom transports. No retry, fallback, redirect or automatic H+1 header fetch.

Valued positions and nonempty orders bind their owners. Empty accounts/orders,
bare authorization booleans and nonce lists bind identities and height only by
the request and gateway assertion. Call `verify_witness` with a separately
chain-pinned H+1 header if needed; this checks consistency, not validator
signatures, authenticity or freshness. Nonces are a prunable retained set, not
a lifetime floor or absence proof. Orders require the current 14-field tuple
and strictly increasing IDs; `complete` is false whenever the requested limit
(1–101) is reached, even if that number happens to be exact.
