# Proof Trading SDK

TypeScript SDK for the [Proof Exchange](https://proof.trade): Ed25519 signing,
MessagePack codec, timestamp-nonce allocation, and gateway/CometBFT submission
for every exchange action.

**Quickest way to try it:**

```bash
npx tsx examples/connect-and-trade.ts
```

The example connects to the public devnet, queries markets, and optionally funds
an account via the dev faucet. Set `PROOF_FAUCET_TOKEN` to run the full
generate-key → fund → place-order → cancel flow.

## Install

```bash
npm install @proof/trading-sdk
```

## Connect to the devnet

The SDK ships configured for the Proof devnet out of the box:

| Parameter   | Default                          |
| ----------- | -------------------------------- |
| Gateway URL | `https://api.dev.proof.trade`    |
| Chain ID    | `exchange-devnet-1`              |
| Faucet URL  | `https://faucet.dev.proof.trade` |

**Key generation (no server needed):**

```typescript
import { generateKeypair, pubkeyToOwner, ownerToHex } from "@proof/trading-sdk";

const { publicKey, privateKey } = generateKeypair();
const address = pubkeyToOwner(publicKey);
console.log(`0x${ownerToHex(address)}`); // your new address
```

**Fund your address** via the devnet faucet:

```bash
curl -X POST https://faucet.dev.proof.trade/drip \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"address": "0x<your-hex-address>"}'
```

Each address receives ~10,000 USDC (10,000,000,000 µUSDC) with a 24 h cooldown.

## Quick Start

```typescript
import {
  ExchangeClient,
  Side,
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
} from "@proof/trading-sdk";

const { publicKey, privateKey } = generateKeypair();
const address = pubkeyToOwner(publicKey);
const addressHex = ownerToHex(address);

const client = new ExchangeClient({
  chainId: "exchange-devnet-1",
});
client.setPrivateKey(privateKey);

// Query
const book = await client.queryOrderbook(1);
const account = await client.queryAccount(addressHex);

// Trade
const result = await client.submitTx({
  type: "PlaceOrder",
  data: {
    market: 1,
    owner: address,
    side: Side.Buy,
    price: 50000000n, // $500,000.00 in cents
    quantity: 1n,
  },
});

console.log(result); // { code: 0, hash: "…" } on success
```

## Unit Conventions

| Field               | Unit                 | Example                      |
| ------------------- | -------------------- | ---------------------------- |
| Prices              | Cents (2 dp)         | `6675234` = $66,752.34       |
| Balances / amounts  | MicroUSDC (6 dp)     | `100_000_000_000` = $100,000 |
| Fees / margin rates | Basis points         | `500` = 5%                   |
| Addresses           | 20-byte `Uint8Array` | `pubkeyToOwner(publicKey)`   |

All prices and quantities are `u64` (BigInt) — never floats.

## API

### Client

```typescript
class ExchangeClient {
  constructor(opts: ExchangeClientOptions);

  // Keys
  setPrivateKey(key: Uint8Array): void;
  getAddress(): Uint8Array | null;
  getAddressHex(): string | null;

  // Chain
  ready(): Promise<void>;
  status(): Promise<{ latestHeight: number; latestAppHash: string }>;

  // Trading
  submitTx(action: Action): Promise<TxResult>;
  submitTxCommit(action: Action): Promise<TxResult>;
  awaitPendingVerifies(): Promise<TxResult[]>;

  // Reads
  queryOrderbook(market: number): Promise<Orderbook>;
  queryOpenOrders(addressHex?: string): Promise<OpenOrder[]>;
  queryMarkets(): Promise<MarketConfig[]>;
  queryAccount(addressHex?: string): Promise<AccountInfo | null>;
  queryTicker(market: number): Promise<Ticker | null>;
  queryHealth(): Promise<{ status: string; height: number }>;
  queryAdlQueue(market: number): Promise<AdlQueueEntry[]>;
  queryWithdrawal(id: bigint): Promise<WithdrawalRecord | null>;

  // History
  queryHistoryDeposits(...): Promise<HistoryCashFlow[]>;
  queryHistoryWithdrawals(...): Promise<HistoryCashFlow[]>;
  queryHistoryResolutions(...): Promise<HistoryResolution[]>;
  queryHistoryPositions(...): Promise<HistoryPositionSnapshot[]>;

  // Blocks
  getBlock(height?: number): Promise<Record<string, unknown>>;
  getBlockResults(height: number): Promise<Record<string, unknown>>;

  // Events
  subscribeBlocks(onEvent: (event: Record<string, unknown>) => void): () => void;
  disconnect(): void;
}
```

### Actions

The `Action` type is a discriminated union. Every action is:

```typescript
type Action =
  | { type: "PlaceOrder"; data: PlaceOrder }
  | { type: "CancelOrder"; data: CancelOrder }
  | { type: "CancelAllOrders"; data: CancelAllOrders }
  | { type: "CancelReplaceOrder"; data: CancelReplaceOrder }
  | { type: "MarketOrder"; data: MarketOrder }
  | { type: "ClosePosition"; data: ClosePosition };
// … 20+ more — see src/types.ts
```

### Options

```typescript
interface ExchangeClientOptions {
  rpcUrl?: string; // default: https://api.dev.proof.trade
  apiUrl?: string; // default: https://api.dev.proof.trade
  gatewayUrl?: string; // default: https://api.dev.proof.trade
  chainId?: string; // default: "exchange-devnet-1"
  useGateway?: boolean; // default: true
  apiKey?: string; // gateway API key (optional)
}
```

When `chainId` is omitted, the SDK auto-resolves it from the CometBFT `/status`
endpoint. Pin it explicitly for deterministic cross-build signatures.

For a local development stack, point the client at your local services:

```typescript
const client = new ExchangeClient({
  rpcUrl: "http://localhost:26657",
  apiUrl: "http://localhost:8080",
  gatewayUrl: "http://localhost:9080",
  chainId: "proof-dev",
});
```

## Wire Format

Transactions are MessagePack positional arrays:

```
[2, action_type, seq, payload, pubkey(32B), signature(64B)]
```

The signature covers
`DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B BE) || payload`.
The 32-byte `chain_id` binding closes the cross-chain replay vector.

`seq` is a timestamp nonce — a millisecond Unix timestamp chosen by the client.
The SDK allocates via `max(now_ms, last_nonce + 1)`. The engine validates
against a sliding window and rejects replays with code 21.

The full action set and payload layouts are defined in `src/types.ts` and
`src/codec.ts` — these are the wire contract.

## Layout

| Path                            | Contents                                             |
| ------------------------------- | ---------------------------------------------------- |
| `src/client.ts`                 | `ExchangeClient` — submit, queries, nonce allocation |
| `src/codec.ts`                  | MessagePack encode/decode, signed-envelope assembly  |
| `src/crypto.ts`                 | Ed25519 sign/verify, keypair + owner derivation      |
| `src/types.ts`                  | Action types and payload shapes (wire contract)      |
| `src/errors.ts`                 | Typed engine/gateway error surface                   |
| `examples/connect-and-trade.ts` | End-to-end example                                   |
| `src/scenarios/`                | Matching/liquidation scenario tests                  |

## Test

```bash
npm test        # vitest: codec round-trips, signing, client, scenarios
npm run build   # tsc -> dist/
```

## Agent / Claude integration

See [AGENTS.md](AGENTS.md) for guidance on using this SDK with AI agents
(Claude, Cursor, Copilot, etc.).

## License

Apache-2.0.
