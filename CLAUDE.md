# Proof Trading SDK — Claude Code guide

## Trading with the SDK

If a user asks you to connect to Proof Exchange and trade, here is the pattern:

1. **Generate keys** — `generateKeypair()` handles Ed25519 key creation.
   Derive the address with `pubkeyToOwner(publicKey)` (keccak256[12..32]).
2. **Create a client** — `new ExchangeClient({ chainId: "exchange-devnet-1" })`
   for the public devnet.
3. **Fund** — The user must have tokens. Call the faucet via
   `POST https://faucet.dev.proof.trade/drip` with an auth token.
4. **Trade** — `submitTx({ type: "PlaceOrder", data: { ... } })`.
   Prices are integer cents, quantities are integer contracts.
5. **Check results** — `code === 0` means CheckTx passed. Non-zero codes
   are error codes (12 = insufficient margin, 21 = nonce collision, etc.).

Run the example:

```bash
npx tsx examples/connect-and-trade.ts
```

See [AGENTS.md](AGENTS.md) for the complete agent reference.

## Branching & pull requests

**Before making any code edits:**

1. Branch off `main` using `<type>/<slug>`, where `<type>` is one of `chore`,
   `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`. Never edit on `main`
   directly.
2. Keep each PR to a single logical change, and add a test with every
   behaviour change.
3. Title each PR with one Conventional Commits prefix.

The `PreToolUse` hook at `.claude/hooks/pre-tool-use.sh` rejects `Edit` /
`Write` / `NotebookEdit` calls until the branch matches `<type>/<slug>`. Fix
the branch rather than bypassing it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities (privately, never in a
public issue or PR).

# Proof Trading SDK

TypeScript SDK for the Proof Exchange — Ed25519 signing, MessagePack codec,
timestamp-nonce allocation, and gateway/CometBFT submission helpers.

## Commands

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest run (codec, crypto, client, scenarios)
npx prettier --check .
```

## Layout

| Path                            | Role                                                |
| ------------------------------- | --------------------------------------------------- |
| `src/codec.ts`                  | MessagePack encode/decode; signed-envelope assembly |
| `src/crypto.ts`                 | Ed25519 sign/verify; keypair + owner derivation     |
| `src/client.ts`                 | `ExchangeClient`: submit, queries, nonce allocation |
| `src/errors.ts`                 | Typed engine/gateway error surface                  |
| `src/types.ts`                  | Action types + payload shapes — the wire contract   |
| `src/scenarios/`                | End-to-end matching/liquidation scenario tests      |
| `examples/connect-and-trade.ts` | End-to-end example for the devnet                   |

## Wire format rules

- All messages are MessagePack **positional arrays**, never maps. Field order
  is the wire layout — never reorder.
- Envelope: `[version=2, action_type, seq, payload, pubkey(32B), signature(64B)]`.
  Signature covers
  `DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B BE) || payload`.
- **Two distinct version numbers — do not conflate them:**
  - The **envelope `version` byte** is `2` (first array element). The exchange
    engine accepts only `[2]`.
  - The **signing domain prefix** is `"ProofExchange-v3"` (16B) — the V3 signing
    layout above, which binds `chain_id`. It was bumped to v3 when chain_id
    binding landed, and the exchange engine signs/verifies under v3.
  - Verified byte-identical against the golden vectors in
    `crates/spec/golden-vectors/*.hex`. Re-diff those after any wire change.
- The 32-byte `chain_id` binding closes cross-chain replay. Resolved from
  CometBFT `/status` and cached; offline callers of `signAndEncode` must pass it.
- `seq` is a wall-clock-ms timestamp nonce; the engine validates it against a
  sliding window (no strict sequential ordering).
- All prices and quantities are `u64` (cents / microUSDC). **No floats.**
- New fields go at the **end** as optional so absent fields encode as `nil`
  (backward compatible). Adding an action means: define its type/payload in
  `types.ts`, assign its `action_type` byte and encode/decode arms in `codec.ts`.

## Unit conventions

| Field      | Scale                                | Example                   |
| ---------- | ------------------------------------ | ------------------------- |
| Prices     | Integer cents (2 dp)                 | `6675000` = $66,750       |
| Balances   | MicroUSDC (6 dp)                     | `100_000_000_000` = $100k |
| Fees/Rates | Basis points                         | `500` = 5%                |
| Addresses  | 20 bytes — keccak256(pubkey)[12..32] | `pubkeyToOwner()`         |

## Spec / contract sync

The SDK's accepted wire shapes must not drift from the gateway. The gateway
owns its `openapi.yaml` spec and pins the exchange engine by version. When a
wire-format change affects the SDK:

1. Update `types.ts` / `codec.ts` and the partner gateway spec in the same
   review window. The spec is the contract — do not let it drift behind a wire
   change.
2. Add or update at least one test that exercises the new shape (a happy-path
   encode/decode round-trip plus one malformed/negative case).
3. Call out the change in the PR under a "Spec/SDK changes" heading; if nothing
   changed, say so explicitly.

`src/types.ts` and `src/codec.ts` are the source of truth for the action set —
do not hardcode action counts elsewhere; they change as the engine grows.

## Network policy — gateway only

**All SDK traffic goes through the API gateway. No exceptions for external
callers.** This holds for every SDK (TypeScript, Python) — the gateway is the
single public surface; treat direct node access as internal-only.

"All traffic" means submission **and** every read: order submission, account /
orderbook / market / history queries, transaction-status polling, chain
status/blocks (`/v1/status`, `/v1/block`, `/v1/block_results`), the chain-id
bootstrap, and the live WebSocket feed. External clients must **not** assume the
CometBFT RPC or the Go API server are reachable — those sit behind the gateway
and may be firewalled off in a public deployment.

- **One endpoint.** Public callers configure only the gateway URL. Prod default
  is `https://api.dev.proof.trade` (port 443). Local stack: the gateway is
  **port 9080** — that is the port external clients use. `8080` (Go API) and
  `26657` (CometBFT RPC) are upstreams the gateway fronts, not client targets.
- **Single source of truth.** `ExchangeClient` takes one `gatewayUrl`; the
  internal `rpcUrl` / `apiUrl` are derived from it (local gateway `9080` →
  `26657` / `8080`) and consulted only on the `useGateway: false` path.
- **`useGateway` is the master switch.** Under the default `useGateway: true`,
  `ExchangeClient` routes **all** traffic through `gatewayUrl`: reads
  (`readBaseUrl`), tx-status polling (`txStatusUrl` → `/v1/tx/{hash}`), chain
  status/blocks and the chain-id bootstrap (`chainBase` → `/v1/status`,
  `/v1/block`, `/v1/block_results`), the WebSocket feed, and submission.
  `useGateway: false` is the internal-only direct-node path for in-cluster
  tools (MMs, HLP, oracle feeder) and the scenario harness. Never document or
  default it for the public SDK, and never add a fresh hard-coded `rpcUrl` /
  `apiUrl` call that bypasses the base getters.

## Security notes

This SDK signs and encodes value-bearing transactions. Treat signing and codec
paths as security-critical:

- Never log private keys, seeds, or signatures. Keep key material out of error
  messages and debug output.
- Codec round-trips must be exact (`encode → decode` structural equality) for
  every action — the scenario and codec tests are the regression guard.
- Prefer typed errors (`src/errors.ts`) over string matching for engine/gateway
  rejection handling.
