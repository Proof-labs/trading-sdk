# Proof-labs working agreement (Claude Code)

This file is project-level guidance for Claude Code, synced from `Proof-labs/.github` (`templates/agent-config/CLAUDE.md`). Repo-specific instructions live below the `<!-- repo-specific -->` marker — don't edit anything above it.

<!-- ===== org-policy (synced — do not edit by hand) ===== -->

## Branching policy (hard-enforced)

**Before making any code edits**, you must:

1. Ask the user what this work is: a **ProofOfBrain board card** (`W##-NN`, e.g. `W20-04`), a **Linear ticket** (`BE-##`), or **ad-hoc**.
2. Create a branch with the correct prefix:
   - **ProofOfBrain card:** `git checkout -b W##-NN/<short-kebab-slug>` (e.g. `W20-04/known-limitations`)
   - **Linear ticket or ad-hoc:** `git checkout -b <type>/<slug>` where `<type>` is one of `chore`, `feat`, `fix`, `docs`, `hotfix`, `infra`, `refactor`. A Linear ticket rides a `<type>/` branch and is attached at PR time (see pull-request policy), not in the branch name.
3. **For a ProofOfBrain card**, read the board card before editing:
   `Proof-labs/ProofOfBrain` → `delivery/boards/YYYY-Www.md` → heading `### W##-NN — <title>`
4. Confirm scope with the user before editing files.

The `PreToolUse` hook at `.claude/hooks/pre-tool-use.sh` rejects `Edit` / `Write` / `NotebookEdit` calls until the current branch matches the convention. Don't try to bypass — fix the branch.

`main`, `dev`, `develop`, `master` (any case) are blocked for direct edits.

## Pull-request policy

When you open a pull request, set the **Task link** in the PR body — it's optional, but ask by default:

1. If the user already named a ticket for this work (a ProofOfBrain card `W##-NN` or a Linear ticket `BE-##`), use it — don't ask again.
2. Otherwise ask once, in chat: _"Is this part of a ProofOfBrain board card (`W##-NN`), a Linear ticket (`BE-##`), or free-styling for now?"_
3. Fill the matching line in the template's **Task link** section (or tick "No — free-styling"). Free text is fine.

The `Board item / validate` check is **advisory only — it never blocks a merge**. Use `dev` as the integration branch; `develop` and `master` are blocked org-wide via ruleset.

## Linked policy

- Definition of Done axes: `Proof-labs/ProofOfBrain` → `delivery/definition-of-done.md`
- Weekly boards: `Proof-labs/ProofOfBrain` → `delivery/boards/_index.md`
- Branching policy: `Proof-labs/ProofOfBrain` → meeting notes referenced from the PR template
- Org-level config (this file, hooks, rulesets, validator workflow): `Proof-labs/.github`

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

| Path             | Role                                                |
| ---------------- | --------------------------------------------------- |
| `src/codec.ts`   | MessagePack encode/decode; signed-envelope assembly |
| `src/crypto.ts`  | Ed25519 sign/verify; keypair + owner derivation     |
| `src/client.ts`  | `ExchangeClient`: submit, queries, nonce allocation |
| `src/errors.ts`  | Typed engine/gateway error surface                  |
| `src/types.ts`   | Action types + payload shapes — the wire contract   |
| `src/scenarios/` | End-to-end matching/liquidation scenario tests      |

## Wire format rules

- All messages are MessagePack **positional arrays**, never maps. Field order
  is the wire layout — never reorder.
- Envelope: `[version=2, action_type, seq, payload, pubkey(32B), signature(64B)]`.
  Signature covers
  `DOMAIN_PREFIX(16B) || chain_id(32B) || action_type(1B) || seq(8B BE) || payload`.
- **Two distinct version numbers — do not conflate them:**
  - The **envelope `version` byte** is `2` (first array element). Unchanged;
    `exchange-core` accepts only `[2]` (`SUPPORTED_ENVELOPE_VERSIONS`).
  - The **signing domain prefix** is `"ProofExchange-v3"` (16B) — the V3 signing
    layout above, which binds `chain_id` (audit B4). Earlier docs said the prefix
    "stays v2"; that is stale. It was bumped to v3 when chain_id binding landed,
    and `exchange-core` (`exchange-core/src/crypto.rs`) signs/verifies under v3.
  - Verified byte-identical against `exchange-core` golden vectors
    (`docs/spec/golden-vectors/*.hex` ≡ `crates/spec/golden-vectors/*.hex`) at
    exchange HEAD `e91d803`. Re-diff those files to re-confirm after any wire change.
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
