# Proof Trading SDK — agent & contributor guide

Guide for AI agents (Claude, Cursor, Copilot, Codex CLI, etc.) and human
contributors using the `@proof/trading-sdk`.

## In a nutshell

The SDK lets agents generate Ed25519 keys, sign and submit trading actions to
the Proof Exchange, and query market data. Everything happens over HTTP — no
blockchain node required.

```
Agent → sign + encode → POST /exchange (gateway) → CometBFT → exchange engine
```

The `sign + encode` core is migrating from a hand-written TypeScript codec to a
WASM build of the authoritative Rust core (single source of truth, byte-identical
to the engine by construction). See
[docs/adr/0001-wasm-core-vs-parallel-types.md](docs/adr/0001-wasm-core-vs-parallel-types.md)
for the decision and its consequences (notably: codec/signing entry points become
`await`-initialized).

## Quick start for agents

```typescript
import {
  ExchangeClient,
  Side,
  Action,
  TxResult,
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
} from "@proof/trading-sdk";

// 1. Key
const { publicKey, privateKey } = generateKeypair();
const address = pubkeyToOwner(publicKey);

// 2. Client
const client = new ExchangeClient({ chainId: "exchange-devnet-1" });
client.setPrivateKey(privateKey);

// 3. Query
const book = await client.queryOrderbook(1);
const acct = await client.queryAccount();

// 4. Trade
const r: TxResult = await client.submitTx({
  type: "PlaceOrder",
  data: {
    market: 1,
    owner: address,
    side: Side.Buy,
    price: 500_000_000_000n, // $500,000.00 in micro-USDC (6 dp)
    quantity: 1n,
  },
});
```

## Connecting

### Devnet (default)

| Env var             | Default                          |
| ------------------- | -------------------------------- |
| `PROOF_GATEWAY_URL` | `https://api.dev.proof.trade`    |
| `PROOF_CHAIN_ID`    | `exchange-devnet-1`              |
| `PROOF_FAUCET_URL`  | `https://faucet.dev.proof.trade` |

```typescript
const client = new ExchangeClient({ chainId: "exchange-devnet-1" });
```

### Local stack

Point the client at your local gateway — `rpcUrl` / `apiUrl` are derived
from it (gateway port 9080 → 26657 / 8080), so you only set one URL:

```typescript
const client = new ExchangeClient({
  gatewayUrl: "http://localhost:9080",
  chainId: "proof-dev",
});
```

## Key management

```typescript
// Generate
const kp = generateKeypair(); // { publicKey: Uint8Array, privateKey: Uint8Array }

// Derive address (keccak256(pubkey)[12..32])
const addr = pubkeyToOwner(kp.publicKey); // Uint8Array (20 bytes)
const hex = ownerToHex(addr); // hex string

// Load into client
client.setPrivateKey(kp.privateKey);
```

## Trading actions

Every action is `{ type: string, data: object }`:

| Action         | Type string            | What it does                              |
| -------------- | ---------------------- | ----------------------------------------- |
| Limit order    | `"PlaceOrder"`         | Place a resting limit order               |
| Market order   | `"MarketOrder"`        | Cross the book immediately                |
| Cancel         | `"CancelOrder"`        | Cancel by engine order ID                 |
| Cancel all     | `"CancelAllOrders"`    | Cancel all orders (optionally per-market) |
| Replace        | `"CancelReplaceOrder"` | Atomically cancel + replace               |
| Amend          | `"AmendOrder"`         | Change price/quantity on a resting order  |
| Close position | `"ClosePosition"`      | IOC order at oracle±spread                |
| Basket         | `"AtomicBasketOrder"`  | Multi-leg fill-or-kill                    |

See `src/types.ts` for every action's payload shape.

```typescript
// Place a limit order
await client.submitTx({
  type: "PlaceOrder",
  data: {
    market: 1,
    owner: address, // 20-byte Uint8Array
    side: Side.Buy, // or Side.Sell
    price: 500_000_000_000n, // $500,000.00 in micro-USDC (6 dp)
    quantity: 1n,
    postOnly: true, // optional: reject if would cross
    reduceOnly: false, // optional: only reduce position
    timeInForce: TimeInForce.Gtc, // Gtc | Ioc | Fok
  },
});

// Cancel all orders on market 1
await client.submitTx({
  type: "CancelAllOrders",
  data: { owner: address, market: 1 },
});
```

### Order fields

| Field           | Type                     | Notes                                           |
| --------------- | ------------------------ | ----------------------------------------------- |
| `market`        | `number`                 | Market ID (1 = BTC, 2 = ETH, etc.)              |
| `owner`         | `Uint8Array` (20B)       | `pubkeyToOwner(pubkey)`                         |
| `side`          | `Side.Buy` / `Side.Sell` |                                                 |
| `price`         | `bigint`                 | micro-USDC (6 dp). $50,000 → `50_000_000_000n`. |
| `quantity`      | `bigint`                 | Integer contracts                               |
| `clientOrderId` | `bigint?`                | Client-scoped dedup ref                         |
| `postOnly`      | `boolean?`               | `true` = reject if taker                        |
| `reduceOnly`    | `boolean?`               | `true` = only reduce position                   |
| `timeInForce`   | `TimeInForce?`           | `Gtc` (default), `Ioc`, `Fok`                   |

## Operator actions (privileged — not for trading integrations)

**If you are building a trading integration, stop here — you never need this
section.** The actions below are operator infrastructure (oracle relay,
composite-CEX feeder, relayer/admin). Each is gated by a dedicated engine
allowlist; a trader's signer is rejected, so they grant nothing without an
operator-provisioned key. They live in the public SDK so operator tooling needs
no second SDK.

The action union reflects this split: `Action = TraderAction | OperatorAction`.
A trading integration can type its calls as `TraderAction` to keep operator
actions out of autocomplete entirely:

```typescript
import type { TraderAction } from "@proof/trading-sdk";
const order: TraderAction = { type: "PlaceOrder", data: {/* … */} };
await client.submitTx(order); // submitTx still accepts the full Action union
```

`OracleUpdateComposite` (0x14) — submit a composite-CEX price for the
multi-source mark-price median (BE-31 Phase B). Requires a signer on the
engine's **CEX-composite feeder allowlist** (a separate trust domain from the
oracle relay). A market only consults the composite once an operator flips it to
`Median` via `UpdateMarketFees` (`markSourceMode: 1`).

```typescript
await client.submitTx({
  type: "OracleUpdateComposite",
  data: {
    market: 1,
    price: 66_750_000_000n, // composite price in micro-USDC ($66,750)
    nSources: 4, // # of CEX feeds (observability only)
    signer: feederAddress, // on the composite-feeder allowlist
    publishTimeMs: BigInt(Date.now()), // strictly monotonic per market
  },
});
```

Python (typed builder):

```python
from proof_trading_sdk import OracleUpdateComposite
client.submit_tx(OracleUpdateComposite(
    market=1, price=66_750_000_000, signer=feeder_addr, n_sources=4,  # micro-USDC ($66,750)
    publish_time_ms=now_ms,
))
```

Other operator actions (`OracleUpdate`, `CreateMarket`, `UpdateMarketFees`,
`ConfirmDeposit`/`ConfirmWithdrawal`/`FailWithdrawal`, `Deposit`/`Withdraw`,
`CreateImpactMarket`, `ResolveEvent`) are in `OperatorAction`; the Python SDK
exposes them via typed builders where present or `RawAction` otherwise. See
`src/types.ts` for every payload shape.

## Reading data

The SDK talks to the API gateway at `PROOF_GATEWAY_URL`. The gateway routes
read endpoints as follows:

| Endpoint                                                                                                                                                 | Gateway            | Notes                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------- |
| `/v1/markets`, `/v1/orderbook/*`, `/v1/candles/*`, `/v1/trades/*`, `/v1/funding/*`, `/v1/fee-tiers/*`, `/v1/impact_*`, `/v1/health`, `/v1/oracle/health` | ✅ Proxied to node | Public, no auth                               |
| `POST /info`                                                                                                                                             | ✅ Routed          | Structured queries (clearinghouseState, etc.) |
| `/v1/account/{hex}`                                                                                                                                      | ❌ **Not routed**  | 404s on gateway                               |
| `/v1/account/{hex}/recent-nonces`, `/v1/nonce/{hex}`                                                                                                     | ✅ Routed          | Diagnostic                                    |
| `/v1/history/*`                                                                                                                                          | ✅ Proxied         | Historical data only (not live state)         |
| `POST /exchange`                                                                                                                                         | ✅ Routed          | Transaction submission (API key required)     |

**Key caveat**: `GET /v1/account/{hex}` (live balance + positions + margin)
is **not** routed on the gateway. The SDK's `queryAccount()` handles this:
it falls back to `POST /info` with `clearinghouseState`, which IS routed.
History endpoints (`/v1/history/equity/{addr}`, `/v1/history/positions/{addr}`)
serve **historical snapshots**, not current live state.

```typescript
// Orderbook depth
const book = await client.queryOrderbook(1);
// { bids: [{ price: bigint, totalQty: bigint, orderCount: number }], asks: [...] }

// Open orders for an address (empty array if none or endpoint unreachable)
const orders = await client.queryOpenOrders(hex); // or omit for own address
// [{ id: bigint, market: number, owner: Uint8Array, side: "Buy"|"Sell", price: bigint, quantity: bigint }]

// Account (balance, positions, margin) — uses POST /info fallback internally
const acct = await client.queryAccount(hex); // or omit for own address
// { balance: bigint, equity: bigint, totalMm: bigint, totalIm: bigint, positions: [...] }

// Chain status — routed through the gateway's /v1/status by default
// (getBlock() / getBlockResults() use /v1/block[_results] likewise).
const status = await client.status();
// { latestHeight: number, latestAppHash: string }
const health = await client.queryHealth();
// { status: string, height: number }
```

## Submission modes

```typescript
// Fire-and-forget (returns after CheckTx, background polls DeliverTx)
const r1 = await client.submitTx(action);

// Synchronous (polls /tx?hash up to 9s)
const r2 = await client.submitTxCommit(action);

// TxResult shape:
// { code: number, hash: string, log: string, height?: number, events?: unknown[] }
// code === 0 → CheckTx passed

// Collect background DeliverTx results:
const results: TxResult[] = await client.awaitPendingVerifies();
// results includes both successes (code=0) and failures (code != 0).
// Callers should check for non-zero codes — they mean the tx passed
// CheckTx but failed at block inclusion.
```

Common error codes:

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 0    | Success                                             |
| 12   | Insufficient margin                                 |
| 17   | Invalid signature                                   |
| 21   | Invalid / duplicate nonce (retry with a fresh call) |
| 34   | Post-only would cross                               |
| 401  | Missing/invalid API key                             |
| 429  | Rate limited                                        |

## Error handling pattern

```typescript
const r = await client.submitTx({ type: "PlaceOrder", data: {...} });
if (r.code !== 0) {
  if (r.code === 21) {
    // Timestamp nonce collision — just retry (SDK auto-advances)
    return await client.submitTx({ type: "PlaceOrder", data: {...} });
  }
  if (r.code === 12) {
    console.log("Insufficient margin — check account balance");
  }
  throw new Error(`Order failed: code=${r.code} log=${r.log}`);
}
```

## Funding an account

```bash
curl -X POST https://faucet.dev.proof.trade/drip \
  -H "Authorization: Bearer $PROOF_FAUCET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address": "0x<hex-address>"}'
```

## Unit conventions

| Field      | Scale             | Example                        |
| ---------- | ----------------- | ------------------------------ |
| Prices     | micro-USDC (6 dp) | `50_000_000_000n` = $50,000.00 |
| Balances   | MicroUSDC (6 dp)  | `10_000_000_000n` = $10,000    |
| Quantities | Integer contracts | `1n` = 1 lot                   |
| Fees/Rates | Basis points      | `500` = 5%                     |
| Addresses  | 20 bytes hex      | `pubkeyToOwner()`              |

## Offline / raw signing

For agents that want to build and inspect the wire envelope directly:

The codec + signing run through a WASM build of the Rust core, so **`await
ready()` once** before any `signAndEncode` / `encodeSignedTx` / `decodeTx`
call (the `ExchangeClient` does this for you; only raw callers need it):

```typescript
import {
  ready,
  signAndEncode,
  decodeTx,
  fetchChainId,
  chainIdFromString,
} from "@proof/trading-sdk";

await ready(); // initialize the WASM codec/signing core once

const chainId = await fetchChainId("https://api.dev.proof.trade");
const txBytes = signAndEncode(chainId, action, seq, privateKey);
// txBytes is ready to POST to gateway or broadcast_tx_sync

const decoded = decodeTx(txBytes);
// { version, actionType, seq, payload, pubkey, signature }
```

## Example

Run the end-to-end example:

```bash
npx tsx examples/connect-and-trade.ts
```

## WebSocket streams

The gateway serves a native multiplexed feed (mirrored by both the TS and
Python SDKs). Each subscription opens its own auto-reconnecting connection and
returns an unsubscribe function; `disconnect()` closes them all.

```typescript
// Account events — snapshot then incremental frames, with after_id gap
// recovery on reconnect. Signed-query auth is added automatically when a
// private key is loaded (browsers can't set the X-Api-Key header).
const unsub = client.subscribeAccountEvents(address, (event) => {
  if (event.event_type === "fill") {
    /* ... */
  }
});

// L2 orderbook — first frame is a full `l2Book` snapshot, then deltas.
const unsubBook = client.subscribeOrderbookDeltas(1, (msg) => {
  /* ... */
});

// One-shot snapshot:
const book = await client.orderbookSnapshot(1);

// later: unsub(); unsubBook(); or client.disconnect();
```

The WS base URL defaults to `gatewayUrl` with the scheme swapped to `ws`/`wss`
(e.g. `wss://api.dev.proof.trade`). Set `wsUrl` for local stacks whose
WebSocket listener is on a separate port.

## Branches & PRs

1. Branch off `main` using `<type>/<slug>` (`feat/`, `fix/`, `docs/`, `chore/`,
   `refactor/`, `infra/`, `hotfix/`).
2. Keep each PR to a single logical change. Add a test with every behaviour
   change.
3. Title each PR with a Conventional Commits prefix.

## Security

Never log private keys, seeds, or signatures. Report vulnerabilities privately
via the repository Security tab.
