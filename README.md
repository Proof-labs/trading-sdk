# Proof Trading SDK

### Atomic financial evidence (TypeScript 4.2)

`client.queryFinancialState({ markets: [1], owners: [ownerHex] })` reads one
finalized-store snapshot through the gateway only. Select 1–8 markets and 1–8
owners; inputs are copied, sorted and canonicalized, with duplicates rejected.
The response includes exact selected market fee/funding settings, raw account
balances and positions, the fee pool, selected markets' insurance pools, and
optional PLP configuration. The PLP account is automatically included once.
All integers retain precision and absent stored values remain `null`; at most
2048 positions total and a one-MiB HTTP response are accepted, within five seconds.
A framing-only preflight also bounds nesting and aggregate value slots before
the maintained MessagePack decoder allocates containers; values are not decoded
by a second codec.

This is not equity, accrued-funding valuation, solvency or trading/withdrawal
authorization. `feesAccrued` is a lifetime fee/rebate counter, not cash.
`plp.bootstrapBalance` is a historical baseline, not additional PLP funds;
actual PLP cash is only its account balance. Do not double-count either field.
Other endpoints must be bracketed at the same `finalizedHeight` for cross-read
comparisons; the method does not claim a historical-height query parameter.

`queryAccountState(ownerHex?)` reads exact finalized settled balance and raw
positions through the gateway, without oracle valuation. Its bigint values are
not equity, accrued funding, available collateral or authorization. When
`queryAccount` fails closed during unsafe oracle conditions, show valuation as
unavailable; do not substitute this raw cash balance as healthy equity. Match
`finalizedHeight` across bracketed reads for a coherent economic snapshot.

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
npm install @proof-labs/trading-sdk
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
import {
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
} from "@proof-labs/trading-sdk";

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

> **Paper-trading competition participant?** Do not use the flow above — it
> needs a privileged faucet token you will not have. You receive a
> pre-funded private key by redeeming an access code. See
> [PAPER-TRADING.md](PAPER-TRADING.md).

## Quick Start

```typescript
import {
  ExchangeClient,
  Side,
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
} from "@proof-labs/trading-sdk";

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
    price: 500_000_000_000n, // $500,000.00 in micro-USDC (6 dp)
    quantity: 1n,
  },
});

console.log(result); // { code: 0, hash: "…" } on success
```

## Unit Conventions

| Field               | Unit                 | Example                       |
| ------------------- | -------------------- | ----------------------------- |
| Prices              | micro-USDC (6 dp)    | `66_752_340_000` = $66,752.34 |
| Balances / amounts  | MicroUSDC (6 dp)     | `100_000_000_000` = $100,000  |
| Fees / margin rates | Basis points         | `500` = 5%                    |
| Addresses           | 20-byte `Uint8Array` | `pubkeyToOwner(publicKey)`    |

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
  // ^ Against a gateway that answers synchronously (api-gateway#90), both
  //   submit paths return the chain's own result — `code`, `height`, `events` —
  //   in ONE round-trip. `submitTxCommit` no longer polls `/tx?hash=` for it,
  //   and `submitTx` spawns no background verifier. See "Transaction results".

  // External signers — no key loaded in the client. Build the envelope with
  // signingMessage() → sign anywhere (hardware key, CLI signer) →
  // encodeSignedTx(), then submit the bytes byte-exact (never re-encoded).
  // Semantics mirror the pair above: submitSignedTx is fire-and-forget with
  // background reconciliation; submitSignedTxCommit waits for the final
  // chain verdict (scoped to the call — use it when the caller must know
  // definitively whether the tx landed, e.g. operator/multisig actions).
  submitSignedTx(txBytes: Uint8Array): Promise<TxResult>;
  submitSignedTxCommit(txBytes: Uint8Array): Promise<TxResult>;

  // Reads
  queryOrderbook(market: number): Promise<Orderbook>;
  queryOpenOrders(addressHex?: string): Promise<OpenOrder[]>;
  queryMarkets(): Promise<MarketConfig[]>;
  queryAccount(addressHex?: string): Promise<AccountInfo | null>;
  queryHealth(): Promise<{ status: string; height: number }>;
  queryOraclePermissions(market: number): Promise<OraclePermissions>;
  queryWithdrawal(id: bigint): Promise<WithdrawalRecord | null>;
  queryPositionTriggers(addressHex?: string): Promise<PositionTriggerInfo[]>;
  queryTriggerMarketConfigs(): Promise<TriggerMarketConfigInfo[]>;
  queryTriggerStatus(): Promise<TriggerStatus>;
  queryPositionTriggerHistory(addressHex?: string, filters?: PositionTriggerHistoryFilters): Promise<PositionTriggerHistoryPage>;
  queryTriggerMarketHistory(market: number, filters?: TriggerMarketHistoryFilters): Promise<TriggerMarketHistoryPage>;

  // Owner defaults to signer; version-active agents pass delegated owner.
  setPositionTriggers(params: Omit<SetPositionTriggers, "owner"> & { owner?: Uint8Array }): Promise<TxResult>;
  cancelPositionTriggers(market: number, expectedPositionEpoch: bigint, owner?: Uint8Array): Promise<TxResult>;

  // History
  queryHistoryDeposits(...): Promise<HistoryCashFlow[]>;
  queryHistoryWithdrawals(...): Promise<HistoryCashFlow[]>;
  queryHistoryResolutions(...): Promise<HistoryResolution[]>;
  queryHistoryPositions(...): Promise<HistoryPositionSnapshot[]>;

  // Blocks
  getBlock(height?: number): Promise<Record<string, unknown>>;
  getBlockResults(height: number): Promise<Record<string, unknown>>;

  // Streams (gateway-native; mirror the Python SDK)
  subscribeAccountEvents(owner: Uint8Array | string, onEvent: (e: Record<string, unknown>) => void, opts?: WsStreamOptions): () => void;
  subscribeOrderbookDeltas(market: number, onMessage: (m: Record<string, unknown>) => void, opts?: WsStreamOptions): () => void;
  orderbookSnapshot(market: number): Promise<Record<string, unknown>>;
  disconnect(): void;
}
```

`queryOraclePermissions(market)` reads one underlying perp's committed oracle
policy, calendar epoch and verdict at an exact finalized height. It preserves
u64 values as `bigint`, and returns `Legacy` with no permission claim while the
new policy is inactive. `Satisfied` covers only this oracle dependency, not all
portfolio dependencies or other trading checks. It never reads provider/observer
health, and is separate from the prohibited operational-health API in ADR 0002.

### Optional native Rust gateway transport

Rust `proof-trading-sdk` 3.2.0 exposes `gateway::GatewayClient` with the optional
`gateway` feature. Default codec/WASM builds do not acquire an HTTP transport.
The four explicit operations are `chain_identity`, `oracle_permissions`,
`submit_signed_bytes` and `committed_receipt`; they use only the existing gateway
routes, with no direct-node fallback, signing, nonce allocation or hidden retry.

Configure an HTTPS origin (HTTP requires a URL-normalized loopback IP, not a DNS
name; numeric IPv4 aliases that normalize to loopback are allowed), a
1ms–60s total request deadline and a response cap no larger than 1MiB. Defaults
are 10 seconds and 256KiB. Redirects, environment proxies and automatic retries
are disabled. An optional API key is sent only in `X-Api-Key` and is redacted
from diagnostics. Signed input is limited to 4096 bytes, fitting the gateway's
default JSON body cap after base64 encoding. These are client resource bounds,
not production admission policy.

`SubmissionOutcome` distinguishes committed execution, CheckTx rejection,
pending execution and explicit pre-admission rejection. A transport/error body
or hash mismatch retains `GatewayError.reconcile_hash`: the transaction may
have landed, so retain its exact bytes and reconcile rather than re-sign.
`committed_receipt` requires the requested hash and a positive committed height;
not-found/not-indexed errors never clear pending state. A code-zero receipt is
execution success, **not** an oracle permission certificate. Retry-After remains
an exact delay, an absolute HTTP date, or explicitly `Invalid`; callers must not
discard an invalid header and retry immediately.

For a deliberately read-only local contract probe, with no signing/key inputs:

```sh
cargo run -p proof-trading-sdk --features gateway --example gateway_oracle_probe -- \
  http://127.0.0.1:9080 EXPECTED_CHAIN 1
```

It checks chain identity before the permission read and reports both heights;
sequential reads are not a single atomic snapshot. Neither a successful probe
nor a committed market permission authorizes a portfolio action or release.

Position triggers are exact-position-generation brackets. For an existing
bracket, `queryPositionTriggers()` returns its epoch; first attach must use the
epoch on the canonical account position read and must never guess `1`. Submit
action `0x25` (`SetPositionTriggers`) or `0x26`
(`CancelPositionTriggers`). A set replaces the whole bracket atomically,
requires at least one limb, and each limb carries an explicit `1..=9999` bps
IOC collar. Owner defaults to the loaded signer; a version-active trading agent
passes the delegated owner explicitly and the engine verifies the grant.

Before setting a bracket, read `queryTriggerMarketConfigs()`. The current
policy is the only valid source for `enabled` and the maximum IOC slippage;
absence means disabled. The optional pending policy is shown with its accepted
and next-block effective heights. The SDK rejects malformed, empty, unsorted,
or version-skipping policy state rather than inventing a default.

`queryTriggerStatus()` reports the fail-closed next-height activation
predicate. `queryPositionTriggerHistory()` returns immutable owner-bearing
lifecycle events; `queryTriggerMarketHistory()` returns the shared market
deferred/resumed stream. Both history methods always use the gateway, return an
opaque filter-bound cursor, and preserve every coordinate/id as a decimal
string—pass those strings and the cursor through unchanged.

### Actions

The `Action` type is a discriminated union. Every action is:

```typescript
type Action = TraderAction | OperatorAction;

type TraderAction =
  | { type: "PlaceOrder"; data: PlaceOrder }
  | { type: "CancelOrder"; data: CancelOrder }
  | { type: "CancelAllOrders"; data: CancelAllOrders }
  | { type: "CancelReplaceOrder"; data: CancelReplaceOrder }
  | { type: "MarketOrder"; data: MarketOrder }
  | { type: "ClosePosition"; data: ClosePosition };
// … more trader actions — see src/types.ts
```

Trading integrations use `TraderAction` and can type their calls against it to
keep operator actions out of autocomplete. `submitTx` still accepts the full
`Action` union.

#### Operator actions (privileged)

`OperatorAction` covers oracle-relay / composite-CEX-feeder / relayer-admin
actions — e.g. `OracleUpdate`, `OracleUpdateComposite`, `UpdateMarketFees`,
`CreateMarket`. **A trading integration never needs these.** Each is gated by a
dedicated engine allowlist, so codec availability grants nothing without an
operator-provisioned key. See [AGENTS.md](AGENTS.md) → "Operator actions" for
usage (e.g. driving the BE-31 multi-source mark via `OracleUpdateComposite` +
`UpdateMarketFees` `markSourceMode`).

### Options

```typescript
interface ExchangeClientOptions {
  gatewayUrl?: string; // default: https://api.dev.proof.trade — the single endpoint
  chainId?: string; // default: "exchange-devnet-1"
  useGateway?: boolean; // default: true — route ALL traffic through the gateway
  apiKey?: string; // gateway API key (optional)

  // Internal direct-node overrides — only consulted when useGateway: false
  // (in-cluster tools, scenario harness). Derived from gatewayUrl when
  // omitted (local gateway 9080 → 26657 / 8080).
  rpcUrl?: string;
  apiUrl?: string;
  wsUrl?: string;
}
```

`gatewayUrl` is the single source of truth: under the default
`useGateway: true` everything — submission, reads, transaction-status polling,
chain status/blocks (`/v1/status`, `/v1/block`, `/v1/block_results`), chain-id
resolution, and the WebSocket feed — goes through it. External clients should
set only this.

When `chainId` is omitted, the SDK auto-resolves it on first submit from the
gateway's `/v1/status` (or `${rpcUrl}/status` on the direct-node path). Pinning
`chainId` explicitly is still recommended for production — it keeps signatures
deterministic across SDK rebuilds.

For a local development stack, point the client at your local gateway; the
node URLs are derived from it (override `rpcUrl` / `apiUrl` if your ports
differ from the 26657 / 8080 convention):

```typescript
const client = new ExchangeClient({
  gatewayUrl: "http://localhost:9080",
  chainId: "proof-dev",
});
```

## Transaction results

`POST /exchange` on the gateway is **synchronous on the on-chain result**
([api-gateway#90](https://github.com/Proof-labs/api-gateway/pull/90)): it parks the
response on the CometBFT tx hash and answers with the chain's own `code`, `log`,
`height` and per-tx `events`. So a submit costs **one round-trip**, not a submit plus
a poll loop — the original complaint (`exchange-issues-2026-06-08` H14) measured that
loop at 9 s+ under load.

The SDK reads that shape and stops working for it:

| Gateway answers      | `TxResult`                                | Does the SDK poll?                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code` + `height`    | `ok` / `engine`, with `height` + `events` | **No** — the tx executed; there is nothing to wait for                                                                                                                                                                     |
| `code`, no `height`  | `engine`                                  | **No** — a CheckTx reject never enters a block, so no DeliverTx will run                                                                                                                                                   |
| `txHash`, no `code`  | `timeout`                                 | **Yes** — the gateway broadcast it but couldn't report the outcome in time (park deadline, duplicate in flight, unreadable result). The tx may still commit, so it is reconciled by hash — **not** reported as a rejection |
| `{status:"ok"}` only | `ok`, no `height`                         | **Yes** — a pre-#90 gateway acks CheckTx only, so inclusion is still unknown                                                                                                                                               |

That last row is why upgrading the SDK is safe against a gateway that has not been
upgraded yet: absence of `code`/`height` still means "execution unknown", and the old
polling paths run exactly as before.

**Read `code` from the field, not from the message.** The gateway still sends the
long-standing `"<code>: <message>"` format in `error` (so older clients that parse the
code back out of it keep working), and `log` carries the chain's message verbatim. New
code should read the structured `code` field: it is authoritative and needs no parsing.

## WebSocket streams

The SDK exposes the gateway's native multiplexed feed — the same two streams
as the Python SDK. Each subscription opens its own connection, auto-reconnects
with exponential backoff (500ms → 30s, ±25% jitter), and returns an
unsubscribe function. `disconnect()` tears down every open stream.

The WS base URL defaults to `gatewayUrl` with its scheme swapped to `ws`/`wss`.
If your local stack serves WebSockets on a separate port, set `wsUrl`
explicitly (e.g. `ws://localhost:9091`).

```typescript
// Account events: snapshot frame, then incremental events. The SDK tracks
// the highest event_id and replays via after_id on reconnect (no gaps).
const unsub = client.subscribeAccountEvents(address, (event) => {
  console.log(event.event_type, event);
});

// L2 orderbook: first frame is a full `l2Book` snapshot, then deltas.
const unsubBook = client.subscribeOrderbookDeltas(1, (msg) => {
  console.log(msg);
});

// One-shot snapshot (opens, reads the first l2Book frame, closes):
const book = await client.orderbookSnapshot(1);

// later:
unsub();
unsubBook();
client.disconnect(); // closes everything
```

`WsStreamOptions` (third arg) takes `onError?: (err) => void` and
`reconnectBackoffMaxMs?: number`.

**Auth.** Account streams require auth only when the gateway runs with
`--api-key`. Because a browser `WebSocket` cannot send the `X-Api-Key` header,
the SDK uses the gateway's signed-query auth: with a private key loaded
(`setPrivateKey`) it signs the stream-auth message and appends `public_key` /
`signature` / `timestamp_ms` to the URL automatically. Against an
unauthenticated gateway (e.g. devnet) the owner alone suffices.

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
