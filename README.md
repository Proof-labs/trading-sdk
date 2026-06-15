# Proof Trading SDK

TypeScript SDK for the Proof Exchange: Ed25519 signing, MessagePack codec, and
CometBFT/gateway interaction for every exchange action.

This package was extracted from the `exchange/` monorepo (the `sdk/` subtree,
history preserved) so it can be versioned and published on its own. It is the
reference client today; a shared Rust core with native bindings is planned —
see `trading-sdks.md` in ProofOfBrain.

## Install

```bash
npm install
npm run build   # tsc -> dist/
```

## Quick Start

```typescript
import {
  ExchangeClient,
  Side,
  generateKeypair,
  pubkeyToOwner,
} from "@proof/trading-sdk";

const { publicKey, privateKey } = generateKeypair();
const address = pubkeyToOwner(publicKey); // keccak256(pubkey)[12..32]

const client = new ExchangeClient({
  rpcUrl: "http://localhost:26657",
  apiUrl: "http://localhost:8080",
});
client.setPrivateKey(privateKey);

await client.submitTx({
  type: "PlaceOrder",
  data: {
    market: 1,
    owner: address,
    side: Side.Buy,
    price: 6675000n,
    quantity: 100n,
  },
});

const book = await client.queryOrderbook(1);
const account = await client.queryAccount();
```

## Unit Conventions

| Field               | Unit                 | Example                      |
| ------------------- | -------------------- | ---------------------------- |
| Prices              | Cents (2 dp)         | `6675234` = $66,752.34       |
| Balances / amounts  | MicroUSDC (6 dp)     | `100_000_000_000` = $100,000 |
| Fees / margin rates | Basis points         | `500` = 5%                   |
| Addresses           | 20-byte `Uint8Array` | `pubkeyToOwner(publicKey)`   |

All prices and quantities are `u64` — never floats.

## Wire Format

Transactions are MessagePack **positional arrays** (never maps):

```
[2, action_type, seq, payload, pubkey(32B), signature(64B)]
```

The signature covers
`DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B BE) || payload`.
The 32-byte `chain_id` binding closes the cross-chain replay vector;
`ExchangeClient` resolves it from CometBFT's `/status` on first submit and
caches it. Offline tooling calling `signAndEncode` directly must pass a
`chainId` (`fetchChainId(rpcUrl)` or `chainIdFromString(name)`).

`seq` is a **timestamp nonce** — a millisecond Unix timestamp chosen by the
client. The SDK allocates via `max(now_ms, last_nonce + 1)`. The engine
validates against a sliding window (`[block_time - 2 days, block_time + 1 day]`)
and rejects replays with code 21 `InvalidNonce`. Nonces are burned on success;
only invalid signatures skip the burn. See `nonce.py` / `nextTimestampNonce()`
for the allocator.

The full action set, payload layouts, and codec are defined in
`src/types.ts` and `src/codec.ts` — these are the contract.

## Layout

| Path             | Contents                                             |
| ---------------- | ---------------------------------------------------- |
| `src/codec.ts`   | MessagePack encode/decode, signed-envelope assembly  |
| `src/crypto.ts`  | Ed25519 sign/verify, keypair + owner derivation      |
| `src/client.ts`  | `ExchangeClient` — submit, queries, nonce allocation |
| `src/errors.ts`  | Typed engine/gateway error surface                   |
| `src/types.ts`   | Action types and payload shapes (wire contract)      |
| `src/scenarios/` | End-to-end matching/liquidation scenario tests       |

## Test

```bash
npm test        # vitest: codec round-trips, signing, client, scenarios
```

## License

Apache-2.0.
