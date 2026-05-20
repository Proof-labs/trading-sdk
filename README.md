# @exchange/sdk

TypeScript SDK for the Proof Exchange. Handles Ed25519 signing, MessagePack encoding, and CometBFT/API interaction for all 13 action types.

## Install

```bash
npm install
npm run build
```

## Quick Start

```typescript
import {
  ExchangeClient,
  Side,
  generateKeypair,
  pubkeyToOwner,
} from "@exchange/sdk";

// Generate a keypair
const { publicKey, privateKey } = generateKeypair();
const address = pubkeyToOwner(publicKey);

// Create client and set signing key
const client = new ExchangeClient({
  rpcUrl: "http://localhost:26657",
  apiUrl: "http://localhost:8080",
});
client.setPrivateKey(privateKey);

// Place a limit order
await client.submitTx({
  type: "PlaceOrder",
  data: {
    market: 1,
    owner: address,
    side: Side.Buy,
    price: 6675000n,     // $66,750.00 (prices in cents)
    quantity: 100n,       // 100 contracts
  },
});

// Query orderbook
const book = await client.queryOrderbook(1);
console.log(`${book.bids.length} bids, ${book.asks.length} asks`);

// Query account
const account = await client.queryAccount();
console.log(`Balance: ${Number(account.balance) / 1_000_000} USDC`);
```

## Unit Conventions

| Field | Unit | Example |
|-------|------|---------|
| Prices | Cents (2 dp) | `6675234` = $66,752.34 |
| Balances, amounts | MicroUSDC (6 dp) | `100_000_000_000` = $100,000 |
| Fees, margin rates | Basis points | `500` = 5% (20x leverage) |
| Funding intervals | Milliseconds | `3_600_000` = 1 hour |
| Addresses | 20-byte `Uint8Array` | `pubkeyToOwner(publicKey)` |

## Action Types

All 13 actions are supported via `client.submitTx({ type, data })`:

| Type | Description |
|------|-------------|
| `PlaceOrder` | Limit order (price-time FIFO) |
| `CancelOrder` | Cancel by order ID |
| `MarketOrder` | IOC market order (walks the book) |
| `OracleUpdate` | Set oracle price (oracle signer only) |
| `Deposit` | Credit funds to account |
| `Withdraw` | Debit funds from account |
| `CreateMarket` | Register a new market (relayer only) |
| `WithdrawRequest` | Request withdrawal to Solana address |
| `ConfirmDeposit` | Confirm Solana deposit (relayer only) |
| `ConfirmWithdrawal` | Mark withdrawal complete (relayer only) |
| `FailWithdrawal` | Mark withdrawal failed, refund (relayer only) |
| `ApproveAgent` | Delegate trading to an agent pubkey |
| `RevokeAgent` | Revoke agent delegation |

## Queries

```typescript
const book = await client.queryOrderbook(marketId);  // Orderbook snapshot
const acct = await client.queryAccount();             // Balance, equity, positions
const order = await client.queryOrder(orderId);       // Single order
const recent = await client.getRecentNonces(addressHex); // Diagnostic retained timestamp nonces
```

## Crypto Utilities

```typescript
import {
  generateKeypair,
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  hexToBytes,
  bytesToHex,
  sign,
  verify,
  signingMessage,
} from "@exchange/sdk";

// Keypair generation
const { publicKey, privateKey } = generateKeypair();

// Address derivation: keccak256(pubkey)[12..32]
const address = pubkeyToOwner(publicKey);
const hex = ownerToHex(address);  // "a1b2c3..."

// Low-level signing (normally handled by client.submitTx)
const msg = signingMessage(actionType, seq, payload);
const sig = await sign(privateKey, msg);
const valid = await verify(publicKey, sig, msg);
```

## Wire Format

Transactions use MessagePack V2 signed envelopes:

```
[2, action_type, seq, payload, pubkey(32B), signature(64B)]
```

The signature covers `DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B,BE) || payload`.

The 32-byte `chain_id` binding (audit B4) closes the cross-chain replay vector — the same wire bytes signed for chain X cannot be replayed on chain Y. `ExchangeClient` resolves it from CometBFT's `/status` endpoint on first submit and caches it; offline tooling that calls `signAndEncode` directly should pass `await fetchChainId(rpcUrl)` (or `chainIdFromString(name)` if pinning).

## Low-Level Codec

```typescript
import {
  encodeTx,
  signAndEncode,
  decodeTx,
  fetchChainId,
} from "@exchange/sdk";

// V1 unsigned (testing only)
const v1Bytes = encodeTx({ type: "PlaceOrder", data: { ... } }, seq);

// V2 signed — chainId required (use UNBOUND_CHAIN_ID only in unit tests)
const chainId = await fetchChainId("http://localhost:26657");
const v2Bytes = signAndEncode(chainId, { type: "PlaceOrder", data: { ... } }, seq, privateKey);

// Decode any version
const { version, actionType, seq, action } = decodeTx(bytes);
```

## Tests

```bash
npm test        # 36 codec round-trip tests (all 13 actions, V1 + V2)
```
