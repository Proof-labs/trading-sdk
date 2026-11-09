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
configuration are unchanged; set the correct chain ID explicitly.

Connecting snapshots the public key and callable and drops the client's
references to its previous secret key or opaque handle. It cannot erase copies
held by the caller. Connecting another signer while a callback is running
discards the old result with `SigningError`, including reentrant replacement.
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
refusals during the WebSocket upgrade separately raise `AuthenticationError`.

`client.account_auth(owner, after_id=0)` returns signed subscription parameters.
The optional cursor must be a Python integer in `0..2**53 - 1`, matching the TS
SDK's JSON-safe domain. Zero is signed but omitted from the returned parameters.
Direct helper failures raise `SigningError`. The default account stream signs
cursor zero; its history-based reconnect recovery does not change this cursor.

## Public trade stream

```python
with client.trade_stream(7) as stream:
    for frame in stream:
        if frame["type"] == "error":
            print(frame["error"])
        else:
            print(frame["fillId"], frame["price"], frame["quantity"])
```

`PublicTradeStream(ws_url, market, api_key="")` is also exported. `trade_stream`
uses the client's gateway URL and optional API key; `ws_url=` overrides the
WebSocket base URL. No account signer is called. Each stream owns one socket;
`close()` or its context manager releases it, independently of `client.close()`.

The first public data is a live `trade`, not a snapshot. Frames retain the
TypeScript feed's gateway keys: `channel`, `type`, `market`, `fillId`,
`makerSide`, `price`, `quantity`, and `payload`. Numeric strings remain strings;
`price` is integer micro-USDC and `quantity` is the raw integer size. Divide
quantity by `10**sz_decimals` from the market configuration for base units;
the stream performs no conversion. Only the requested
channel/market and matching subscription errors are delivered. Control ACKs
are consumed internally. Subscription refusals are yielded without retrying on
the same socket, matching TypeScript's public trade subscription.

Disconnects resubscribe automatically with 0.5-second exponential backoff,
capped at 10 seconds by default (`reconnect_backoff_max` overrides the cap).
Only one iterator may consume a stream, and reconnect work proceeds as it is
consumed. There is no replay, deduplication or HTTP backfill: disconnected or
slow consumers can miss fills, including gateway queue drops that have no
client-visible gap notification.

Python now requires `websockets>=15` for synchronous keepalive; installations
pinned to version 14 must upgrade. The stream explicitly sends protocol-level
Ping frames every 15 seconds and closes an unresponsive socket after a
10-second Pong timeout. TypeScript uses JSON ping/pong frames with those
intervals instead. Both detect half-open connections, but Python's keepalive
runs in the library thread while reconnection waits for iterator consumption.
Closing cancels receive and backoff waits; a connection handshake already in
progress completes or reaches the library's connection timeout before cleanup.

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
