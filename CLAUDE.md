# Proof-labs working agreement (Claude Code)

This file is project-level guidance for Claude Code. The org-policy section is
synced from `Proof-labs/.github`; the repo-specific section below it covers this
SDK.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced)

Before making any code edits:

1. Ask the user for a board ticket ID `W##-NN` (e.g. `W20-04`) **or**
   `n/a — <reason>` for non-ticket work.
2. Branch with the correct prefix:
   - Ticket work: `git checkout -b W##-NN/<short-kebab-slug>`
   - Non-ticket: `git checkout -b <type>/<slug>`, `<type>` ∈
     `chore|feat|fix|docs|hotfix|infra|refactor`.
3. For ticket work, read the board card first:
   `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → `### W##-NN — <title>`.
4. Confirm scope with the user before editing.

`main`, `dev`, `develop`, `master` (any case) are blocked for direct edits. Use
`dev` as the integration branch; every PR fills the `**Board item:**` field with
`W##-NN` or `n/a — <reason>`.

<!-- ===== /org-policy ===== -->

<!-- repo-specific -->

# Proof Trading SDK

TypeScript SDK for the Proof Exchange — Ed25519 signing, MessagePack codec,
timestamp-nonce allocation, and gateway/CometBFT submission helpers. Extracted
from the `exchange/` monorepo's `sdk/` subtree with history preserved.

## Commands

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest run (codec, crypto, client, scenarios)
npx prettier --check .
```

## Layout

| Path | Role |
|------|------|
| `src/codec.ts` | MessagePack encode/decode; signed-envelope assembly |
| `src/crypto.ts` | Ed25519 sign/verify; keypair + owner derivation |
| `src/client.ts` | `ExchangeClient`: submit, queries, nonce allocation |
| `src/errors.ts` | Typed engine/gateway error surface |
| `src/types.ts` | Action types + payload shapes — the wire contract |
| `src/scenarios/` | End-to-end matching/liquidation scenario tests |

## Wire format rules

- All messages are MessagePack **positional arrays**, never maps. Field order
  is the wire layout — never reorder.
- Envelope: `[version=2, action_type, seq, payload, pubkey(32B), signature(64B)]`.
  Signature covers
  `DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B BE) || payload`.
  The signing-prefix string stays `"ProofExchange-v2"` for compatibility with
  already-issued signatures.
- The 32-byte `chain_id` binding closes cross-chain replay. Resolved from
  CometBFT `/status` and cached; offline callers of `signAndEncode` must pass it.
- `seq` is a wall-clock-ms timestamp nonce; the engine validates it against a
  sliding window (no strict sequential ordering).
- All prices and quantities are `u64` (cents / microUSDC). **No floats.**
- New fields go at the **end** as optional so absent fields encode as `nil`
  (backward compatible). Adding an action means: define its type/payload in
  `types.ts`, assign its `action_type` byte and encode/decode arms in `codec.ts`.

## Unit conventions

| Field | Scale | Example |
|-------|-------|---------|
| Prices | Integer cents (2 dp) | `6675000` = $66,750 |
| Balances | MicroUSDC (6 dp) | `100_000_000_000` = $100k |
| Fees/Rates | Basis points | `500` = 5% |
| Addresses | 20 bytes — keccak256(pubkey)[12..32] | `pubkeyToOwner()` |

## Spec / contract sync

The SDK's accepted wire shapes must not drift from the gateway. The gateway
(`Proof-labs/api-gateway`) owns `openapi.yaml` and pins `exchange-core` by git
rev. When a wire-format change affects the SDK:

1. Update `types.ts` / `codec.ts` and the partner gateway spec in the same
   review window. The spec is the contract — do not let it drift behind a wire
   change.
2. Add or update at least one test that exercises the new shape (a happy-path
   encode/decode round-trip plus one malformed/negative case).
3. Call out the change in the PR under a "Spec/SDK changes" heading; if nothing
   changed, say so explicitly.

`src/types.ts` and `src/codec.ts` are the source of truth for the action set —
do not hardcode action counts elsewhere; they change as the engine grows.

## Security notes

This SDK signs and encodes value-bearing transactions. Treat signing and codec
paths as security-critical:

- Never log private keys, seeds, or signatures. Keep key material out of error
  messages and debug output.
- Codec round-trips must be exact (`encode → decode` structural equality) for
  every action — the scenario and codec tests are the regression guard.
- Prefer typed errors (`src/errors.ts`) over string matching for engine/gateway
  rejection handling.
