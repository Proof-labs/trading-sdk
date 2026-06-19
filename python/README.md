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

```python
import proof_trading_sdk as pts

# Load or generate a keypair
kp = pts.generate_keypair()
secret_key = kp["secret_key"]
public_key = kp["public_key"]

# Derive the 20-byte owner address
owner = pts.pubkey_to_owner(public_key)

# Create a client
client = pts.ExchangeClient(
    gateway_url="https://api.dev.proof.trade",
    api_key="...",
    secret_key=secret_key,
)

# Check account state
state = client.account(owner)

# Place an order
from proof_trading_sdk import Side, TimeInForce
result = client.submit_action({
    "action_type": 1,  # PlaceOrder
    "market": 1,
    "owner": bytes(owner),
    "side": Side.Buy,
    "price": 50_000_00,  # $50,000.00
    "quantity": 1,
})
```

See the full API at `help(proof_trading_sdk)`.

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

Pure in-memory — no persistence, no I/O. On restart the allocator resets and
the first `allocate()` returns `now_ms`, which is always ahead of any pre-crash
nonce. The one edge case (restart within the same millisecond) produces a
duplicate nonce; the engine rejects it with code 21 (not burned), the caller
retries, and the second call returns `now_ms + 1`.

### Multi-process safety

Multiple processes sharing the same account each use their own allocator with
independent wall clocks. Nonces are naturally unique per process (different
`now_ms` values). The engine's sorted-vec handles interleaving.

### Key properties

- No sequential ordering required — nonces can arrive out of order
- No sync call needed before the first transaction
- Thread-safe, lock-free allocation in the common case
- Wide engine window (+1 day / −2 days) tolerates NTP skew
