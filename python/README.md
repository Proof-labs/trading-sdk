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
    gateway_url="https://api.dev.proof.exchange",
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
