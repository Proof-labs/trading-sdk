# Proof-labs working agreement (any AI agent)

Tool-agnostic agent instructions, synced from `Proof-labs/.github` (`templates/agent-config/AGENTS.md`). Read by Aider, Codex CLI, Continue, Cursor (newer), and any agent that follows the AGENTS.md convention. Claude Code reads `CLAUDE.md` separately but the policy is identical.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced where possible)

Before any code edit:

1. Ask the user what this work is: a **ProofOfBrain board card** (`W##-NN`, e.g. `W20-04`), a **Linear ticket** (`BE-##`), or **ad-hoc**.
2. Create a branch with the correct prefix:
   - **ProofOfBrain card:** `W##-NN/<short-kebab-slug>` (e.g. `W20-04/known-limitations`)
   - **Linear ticket or ad-hoc:** `<type>/<slug>` where `<type>` ∈ `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`. A Linear ticket rides a `<type>/` branch and is attached at PR time, not in the branch name.
3. For a ProofOfBrain card, read the board card before editing: `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → `### W##-NN — <title>`.
4. Confirm scope with the user before editing.

`main`, `dev`, `develop`, `master` are blocked for direct edits (org-wide ruleset).

## Pull-request policy

When you open a pull request, set the **Task link** in the PR body — optional, but ask by default:

1. If the user already named a ticket for this work (a ProofOfBrain card `W##-NN` or a Linear ticket `BE-##`), use it — don't ask again.
2. Otherwise ask once: *"Is this part of a ProofOfBrain board card (`W##-NN`), a Linear ticket (`BE-##`), or free-styling for now?"*
3. Fill the matching line in the template's **Task link** section (or mark "No — free-styling"). Free text is fine.

From the terminal you can use the helper `bash .github/open-pr.sh`, which asks the same question and then runs `gh pr create`. The `Board item / validate` workflow is **advisory only — it never blocks a merge**.

## Pull-request queue discipline

- **Decision-bearing pull requests stay draft.** If merging the PR requires a product, economic, or organisational decision (a new policy, a parameter set, an ownership assignment, release authority), reference its `DEC-N` rows from `Proof-labs/ProofOfBrain` → `delivery/decision-register.md` in the PR body and keep the PR **draft** until every linked row is Decided. **Re-scan at PR time** — decisions usually only become visible at the end of the work: before `gh pr create`, re-read the full branch diff and fill the template's **Decisions** section as an inventory: decisions **made** during the work (routine engineering calls — list them, they are reviewed in this PR) and decisions **needing authority** (→ register rows + draft). A `PreToolUse` hook enforces this structurally on every ready-for-review `gh pr create`: the body's Decisions section needs a **checked** lane (`- [x]`) — "No decision required", a made-list with at least one real bullet, or "Needs authority" with rows the hook verifies are **Decided** in the live register (still-Open rows require `--draft`) — and the org-wide 5-ready work-in-progress cap is counted at creation. Verification failures fail closed. `--draft` always passes. **If no row exists yet, create the stub first**: answer `open-pr.sh`'s decision prompt with a one-line description (it allocates the next `DEC-N` and opens the register pull request for you, via `.github/new-decision-row.py`), or append the row yourself via a small ProofOfBrain pull request into `dev` on branch `add/dec-N-<slug>` — then link both pull requests. Decisions are made in the weekly decision moment, not argued in review threads.
- **Work-in-progress cap.** Each author keeps at most **5 pull requests in ready-for-review across the whole organisation**. Further output opens as **draft** (or as an issue) until a slot frees.

## Scope: one logical change per PR

Each PR does exactly one logical change — one concern, one Conventional Commits type
(`feat` / `fix` / `refactor` / `style` / `chore` / `docs` / `test` / `perf`). Never bundle a
feature with a fix, or a behaviour change with a structural one (refactor, rename,
reformat, lint). If a request mixes concerns, make the change but split it into separate
PRs by type, and tell the user which split you made and why. Full rule: `Proof-labs/.github`
→ `CONTRIBUTING.md`.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Org-level config (this file, validator workflow, rulesets): `Proof-labs/.github`

## Network policy — gateway only (client-facing code)

All client traffic — SDKs, frontends, bots, scripts — goes through the **API gateway**. The CometBFT RPC (`:26657`) and the node REST API (`:8080` / `:1317`) are internal upstreams the gateway fronts; they are **never** client targets and may be firewalled off in production.

- **Through the SDK, never hand-rolled HTTP.** The gateway is the *network* boundary; the Proof SDK (`@proof/trading-sdk`, source of truth `exchange/sdk`) is the *client* boundary. Application code — frontends, bots, scripts, services — calls the SDK for every gateway interaction; it never hand-rolls `POST /exchange` bodies, signing, nonces / sequence numbers, or wire codecs against the gateway. If the SDK lacks a method for a gateway route, add the SDK method first, then consume it — same pattern as the gateway rule below. Exceptions: the SDK's own transport internals, and contract tests that deliberately pin the raw route / request shape (e.g. proof-integration scenarios).
- **Default to the gateway.** A direct-to-node path may exist only as an explicit, non-default opt-out (e.g. `useGateway: false`) for in-cluster tools (market-makers, HLP, oracle feeder, test harness) — never the public default, never documented for external callers.
- **Never hardcode or default to** node ports (`:26657`, `:8080`, `:1317`), raw CometBFT methods (`/status`, `/block`, `/tx?hash=`, `broadcast_tx_*`), or a node mode (`apiMode: 'node'`). Use the gateway surface: `POST /exchange`, `POST /info`, `GET /v1/*`, `/v1/tx/{hash}`, `/v1/status`, `/ws`.
- **If the gateway doesn't serve a read you need, add the gateway route first**, then consume it — do not reach past the gateway to the node.
- Scope: client-facing code only. Does **not** apply to the gateway itself or to node / infra repos, which legitimately talk to the node.

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->

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
