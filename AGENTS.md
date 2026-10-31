# Proof-labs working agreement (any AI agent)

Tool-agnostic agent instructions, synced from `Proof-labs/.github` (`templates/agent-config/AGENTS.md`). Read by Aider, Codex CLI, Continue, Cursor (newer), and any agent that follows the AGENTS.md convention. Claude Code reads `CLAUDE.md` separately but the policy is identical.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced where possible)

Before any code edit:

1. Ask the user what this work is: a **ProofOfBrain board card** (`W##-NN`, e.g. `W20-04`), a **Linear ticket** (`BE-##`), or **ad-hoc**.
2. Create a branch with the correct prefix. **If the work closes a GitHub issue, embed its number as the leading segment: `GH<issue>/…`** (e.g. `GH98/fix/oracle-source-vectors`), and put `Closes #<issue>` in the PR body.
   - **ProofOfBrain card:** `W##-NN/<short-kebab-slug>` (e.g. `W20-04/known-limitations`); with a GitHub issue, `GH<issue>/W##-NN/<short-kebab-slug>`.
   - **Linear ticket or ad-hoc:** `<type>/<slug>` where `<type>` ∈ `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`; with a GitHub issue, `GH<issue>/<type>/<slug>`. A Linear ticket rides a `<type>/` branch and is attached at PR time, not in the branch name.
3. For a ProofOfBrain card, read the board card before editing: `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → `### W##-NN — <title>`.
4. Confirm scope with the user before editing.

`main`, `dev`, `develop`, `master` are blocked for direct edits (org-wide ruleset).

## Pull-request policy

When you open a pull request, set the **Task link** in the PR body — optional, but ask by default:

1. If the user already named a ticket for this work (a ProofOfBrain card `W##-NN` or a Linear ticket `BE-##`), use it — don't ask again.
2. Otherwise ask once: *"Is this part of a ProofOfBrain board card (`W##-NN`), a Linear ticket (`BE-##`), or free-styling for now?"*
3. Fill the matching line in the template's **Task link** section (or mark "No — free-styling"). Free text is fine.

From the terminal you can use the helper `bash .github/open-pr.sh`, which asks the same question and then runs `gh pr create`. The `Board item / validate` workflow is **advisory only — it never blocks a merge**.

## Linked GitHub issues and labels

Work that closes a GitHub issue names it in both places: the branch leads with `GH<issue>/`
and the PR body carries `Closes #<issue>` (see the branching and pull-request policy above).

**A pull request inherits the labels of the issue it closes.** In particular, a PR that
closes a `critical` issue is itself `critical`: the label records the change's blast radius,
and the closing keyword in the PR body is the signal (`close[sd]` / `fix(es|ed)` /
`resolve[sd]`, optional colon, comma lists, same-repo refs; cross-repo refs are ignored).
Labels are additive and never removed; a GitHub API error fails the run rather than
mislabeling silently. The org ships this as a copyable GitHub Actions workflow —
`.github/workflows/label.yml` with `.github/scripts/label_rules.sh` and its self-test;
`.github/label-rules.json` is an optional per-repo list of path-based label categories.
`scripts/sync-agent-config.sh` in `Proof-labs/.github` distributes them.

## Pull-request queue discipline

- **Draft means the author is not requesting review yet.** Authors choose draft independently of pending decisions.
- **Pending decisions block merge, not review.** If merging requires a product, economic, organisational, or release decision, cite its `DEC-N` rows from `Proof-labs/ProofOfBrain` → `delivery/decision-register.md`. Review and discuss the proposal in the PR; the authorised decision owner records the outcome in the register. Do not merge until every cited row is Decided.
- **Re-scan at PR time.** Re-read the full branch diff and fill the **Decisions** section: no decision required, routine engineering decisions made (with a real list), or decisions needing authority (with register rows). The PR-creation hook validates this declaration, not decision status. If no row exists, use `.github/new-decision-row.py` or `open-pr.sh --new-decision` to create a stub and link it.
- **Merge check.** `Decision rows` fails for missing or undecided cited rows, an unreadable register, or a checked “Needs authority” declaration without rows. It does not change draft status. Require `decision-rows / validate` in branch protection for enforcement; after the register changes, re-run the check before merging.

## Scope: one logical change per PR

Each PR does exactly one logical change — one concern, one Conventional Commits type
(`feat` / `fix` / `refactor` / `style` / `chore` / `docs` / `test` / `perf`). Never bundle a
feature with a fix, or a behaviour change with a structural one (refactor, rename,
reformat, lint). If a request mixes concerns, make the change but split it into separate
PRs by type, and tell the user which split you made and why. Full rule: `Proof-labs/.github`
→ `CONTRIBUTING.md`.

## Binary artifacts and large files (never commit)

Never stage or commit any file **at or over 1 MiB** into a Proof repo — video, audio,
images, archives, design exports, model weights, datasets. Blobs that reach `dev` or
`main` are permanent: the org ruleset forbids force-pushing protected branches, so the
payload bloats every future clone forever.

- **Small assets referenced from docs (under 1 MiB) are fine** — the vault convention
  deliberately allows images and PDFs next to their notes.
- **Larger assets** go through **Git LFS** (`git lfs track '<pattern>'`, commit
  `.gitattributes`, then add the file — LFS pointers pass every check) or are hosted
  externally and referenced by URL.
- **Already staged?** `git rm --cached <file>` (amend if not yet pushed). Never push
  first and clean up later — removing a pushed blob needs a history rewrite.
- Enforcement: the Claude Code `pre-tool-use` hook blocks oversized `git add`; the
  `No large binaries` CI check (opt-in per repo) enforces the same threshold on PRs.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Org-level config (this file, validator workflow, rulesets): `Proof-labs/.github`

## Naming policy — one canonical vocabulary (DEC-149)

One name per function and entity, in every repository, screen, document and vault note (ProofOfBrain → `engine/canonical-vocabulary.md`; machine-readable in Proof-labs/exchange → `protocol-allocations.json`, section `vocabulary`).

- **The engine's PascalCase action name is the word** (`CreateMarket`, `CreateEvent`, `OracleUpdate`). Code identifiers use it unchanged. The gateway's JSON `type` is its lowerCamel form (`createMarket`) and nothing else; emitted events are the same words in snake-case past tense (`market_created`); prose and screen text write the same words with spaces ("Create market"). Never a synonym.
- **Product words:** **Event** (the question, its Yes/No prediction binaries, its resolution), **Conditional** (one perpetual attached to one event), **Perpetual**. The Yes/No books are **prediction binaries**.
- **The Proof liquidity provider is the PLP.** Spell it out once per document as "Proof liquidity provider (PLP)", then write PLP. It is the protocol's liquidity-provider account and the market maker that trades it, one entity under one name. Never `HLP`, never `Strawberry`, and never `the vault`, `LP vault` or `liquidity-provider vault` for it. Identifiers follow the same word (`PlpConfig`, `plp_absorbed`).
- **Retired words** — do not write them in new code comments, screen strings, docs or notes: `impact market`, `impact family`, `event family`, `conditional market`, `event market`, `event binary`, `unwind`, `HLP`, `Strawberry`, `LP vault`, `liquidity-provider vault`. Legacy identifiers (`CreateImpactMarket`, `impact_market_id`, `ImpactMarketInfo`) have left the wire and survive only in stored history; never add a new use, and gloss them as "the legacy event-plus-conditional record" where a reader needs it.
- **Names being renamed (hard cutover, no aliases):** the branch outcome events `conditional_settled` / `conditional_voided` become `condition_met` / `condition_not_met` ("Condition met" / "Condition not met"; "Void" stays the whole-event outcome); the gateway JSON types `order` / `cancel` / `cancelReplace` become `placeOrder` / `cancelOrder` / `cancelReplaceOrder`; the gateway WebSocket frame types `account_event`, `order_update`, `position_update`, `trigger_update`, `margin_update` become lowerCamel. Write only the new names in new code; a line that must keep an old name (decoding stored history) carries the comment `vocabulary-lint: allow`.
- **Naming something new:** name it after the entity it acts on, check the manifest for the name first, and add the derived forms in the same pull request. The `Vocabulary lint` check warns on retired words and on renamed names; it becomes blocking per repository once that repository is clean.

## Network policy — gateway only (client-facing code)

All client traffic — SDKs, frontends, bots, scripts — goes through the **API gateway**. The CometBFT RPC (`:26657`) and the node REST API (`:8080` / `:1317`) are internal upstreams the gateway fronts; they are **never** client targets and may be firewalled off in production.

- **Through the SDK, never hand-rolled HTTP.** The gateway is the *network* boundary; the Proof SDK (`@proof-labs/trading-sdk`, source of truth `Proof-labs/trading-sdk`) is the *client* boundary. Application code — frontends, bots, scripts, services — calls the SDK for every gateway interaction; it never hand-rolls `POST /exchange` bodies, signing, nonces / sequence numbers, or wire codecs against the gateway. If the SDK lacks a method for a gateway route, add the SDK method first, then consume it — same pattern as the gateway rule below. Exceptions: the SDK's own transport internals, and contract tests that deliberately pin the raw route / request shape (e.g. proof-integration scenarios).
- **Default to the gateway.** A direct-to-node path may exist only as an explicit, non-default opt-out (e.g. `useGateway: false`) for in-cluster tools (market-makers, PLP, oracle feeder, test harness) — never the public default, never documented for external callers.
- **Never hardcode or default to** node ports (`:26657`, `:8080`, `:1317`), raw CometBFT methods (`/status`, `/block`, `/tx?hash=`, `broadcast_tx_*`), or a node mode (`apiMode: 'node'`). Use the gateway surface: `POST /exchange`, `POST /info`, `GET /v1/*`, `/v1/tx/{hash}`, `/v1/status`, `/ws`.
- **If the gateway doesn't serve a read you need, add the gateway route first**, then consume it — do not reach past the gateway to the node.
- Scope: client-facing code only. Does **not** apply to the gateway itself or to node / infra repos, which legitimately talk to the node.

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->

# Proof Trading SDK — agent & contributor guide

Guide for AI agents (Claude, Cursor, Copilot, Codex CLI, etc.) and human
contributors using the `@proof-labs/trading-sdk`.

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

## Reads decode through the wasm core

A read whose response type is in proof-wire (`proof_wire::query`, `proof_wire::types`) decodes in Rust: a `ReadKind` arm in `crates/proof-trading-sdk-wasm` (`decode_read`), then a `*FromWasm` adapter in `src/codec-adapter.ts` that only renames fields. Never hand-decode such a type in TypeScript or Python. If the type is not in proof-wire yet, add it there first (exchange `exchange-wire/src/query.rs`), then add the arm. The remaining hand decoders are reads whose types still live in exchange-core; move the type, then delete the decoder.

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
} from "@proof-labs/trading-sdk";

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
import type { TraderAction } from "@proof-labs/trading-sdk";
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
`ResolveEvent`, `ClaimWithdrawalPayout`) are in `OperatorAction`; the Python SDK
exposes them via typed builders where present or `RawAction` otherwise. See
`src/types.ts` for every payload shape.

## Reading data

The SDK talks to the API gateway at `PROOF_GATEWAY_URL`. The gateway routes
read endpoints as follows:

| Endpoint                                                                                                                                                 | Gateway            | Notes                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------- |
| `/v1/markets`, `/v1/orderbook/*`, `/v1/candles/*`, `/v1/trades/*`, `/v1/funding/*`, `/v1/fee-tiers/*`, `/v1/events`, `/v1/event/*`, `/v1/health`, `/v1/oracle/health` | ✅ Proxied to node | Public, no auth                               |
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
} from "@proof-labs/trading-sdk";

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

The gateway serves a native multiplexed feed on `/ws`. Account events, trades
and the orderbook are channels on one shared connection. Each call returns an
unsubscribe function; `disconnect()` closes the feed.

```typescript
// Account events — a snapshot frame, then live event frames. Signed
// subscription auth is added automatically when a signer is connected
// (browsers can't set the X-Api-Key header). A reconnect restores the
// snapshot and backfills missed events from /v1/history/account-events
// (gateway 7.9.0+; `onRecovery` reports the outcome once per reconnect,
// `unverified` when the snapshot has no `height`; `recover: false` opts out).
const unsub = client.subscribeAccount((frame) => {
  if (frame.type === "fill") {
    /* ... */
  }
});

// Orderbook — a `snapshot` frame, then one `update` frame per changed level.
const unsubBook = client.subscribeOrderbook(1, (frame) => {
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

1. Branch off `dev`, named per the org policy at the top of this file
   (`<type>/<slug>` or `W##-NN/<slug>`, led by `GH<issue>/` when the work closes
   a GitHub issue, with `Closes #<issue>` in the PR body). PRs target `dev`.
2. Keep each PR to a single logical change. Add a test with every behaviour
   change.
3. Title each PR with a Conventional Commits prefix.

## Dependencies: public sources only

This SDK is public, so everything it builds from must be public too. Never add
a dependency on a private repo or crate (an `ssh://` git source, a private
registry), directly or through another crate: anyone outside Proof-labs could
no longer build or verify the SDK, and every downstream build would need the
key. When a type you need lives in a private crate, move the public part into
proof-wire first (the `bridge` feature is the precedent) and depend on that.

## Security

Never log private keys, seeds, or signatures. Report vulnerabilities privately
via the repository Security tab.
