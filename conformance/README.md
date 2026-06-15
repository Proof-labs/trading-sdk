# Cross-language conformance vectors

Golden test vectors that pin the **wire contract** of the Proof trading SDK
across every language binding. The Rust core is the source of truth; it
generates the vectors, and each binding (Rust, Python, TypeScript) must
reproduce every `expect` byte-for-byte. A divergence is a release blocker — it
means two SDKs would sign or encode the same logical action differently.

> **Status: SEED + scaffold.** The generator emits a small representative set
> (7 codec, 3 signing, 4 nonce). The Rust and Python runners are green; the TS
> runner is scaffolded but skipped. Finishing this to full coverage is the
> handoff — see [Handoff checklist](#handoff-checklist).

---

## Layout

```
conformance/
  README.md         ← this file
  codec.ndjson      ← action fields → exact MessagePack payload bytes
  signing.ndjson    ← (payload, key) → wire envelope; pubkey → owner address
  nonce.ndjson      ← (last, now_ms…) → allocated nonce sequence

crates/spec/        ← the vector machinery (Rust)
  src/lib.rs            schemas + reference impls (the single source of truth)
  src/bin/gen_vectors.rs  generator: writes the three NDJSON files
  tests/runner.rs       Rust runner (regression guard)

python/tests/test_conformance_vectors.py   Python runner
src/conformance.test.ts                     TS runner (scaffold, skipped)
```

### Authority model

```
        gen-vectors (Rust core)
                │  writes
                ▼
        conformance/*.ndjson  ◄── checked into git
          │         │        │
          ▼         ▼        ▼
       Rust      Python     TS        each asserts it reproduces every `expect`
      runner     runner    runner
   (regression) (x-lang)  (x-lang)
```

The Rust runner re-derives the `expect` from the same core that generated it,
so it is a **regression guard** (catches accidental core changes). The
cross-language guarantee comes from the **Python and TS runners** asserting
against the identical checked-in bytes.

---

## Format

**NDJSON** — one self-describing JSON case per line. Chosen deliberately:

- It is the indexer's archive format (`indexer/pkg/envelope`, `<height>.ndjson`),
  so the same streaming reader can replay **real historical signed txs**
  through the SDK (see [Replay corpus](#replay-corpus-planned)).
- Line-addressable: a failure points at `codec.ndjson:12`.
- Diffs cleanly in review; append-only growth doesn't reflow the file.

### Byte representation

| Where | Encoding | Why |
|-------|----------|-----|
| Byte **inputs** (`owner`, `signer`, `pubkey`, `secret_key`, `chain_id`) | JSON **array of u8** — `[1,1,…]` | The one form every consumer decodes with no special-casing: `serde_json`/`pythonize` route it into the `wire` newtypes' `visit_seq`; TS does `Uint8Array.from(arr)`. |
| Opaque **outputs** (`payload_hex`, `expect_envelope_hex`, `expect_owner_hex`) | lowercase hex string | Compact, obviously opaque, trivial to eyeball-diff. |
| Integers (`price`, `quantity`, `seq`, nonce fields) | plain JSON number | Fits u64; bindings coerce to their native int (Python int, TS `bigint`). |

### Line schemas

**`codec.ndjson`** — `CodecCase`:
```json
{"case":"place_order/min","action_type":1,"input":{ …snake_case fields… },"expect":{"payload_hex":"…"}}
```
`input` is the action's snake_case field dict; byte fields are u8 arrays.

**`signing.ndjson`** — `SigningCase`, tagged by `kind`:
```json
{"kind":"sign","case":"…","chain_id":[…32],"action_type":1,"seq":1,"payload_hex":"…","secret_key":[…32],"expect_envelope_hex":"…"}
{"kind":"owner","case":"…","pubkey":[…32],"expect_owner_hex":"…"}
```

**`nonce.ndjson`** — `NonceCase`:
```json
{"case":"clock_ticks","last":0,"now_ms":[1000,1001,1002],"expect":[1000,1001,1002]}
```
Pins the pure step `nonce(last, now_ms) = max(now_ms, last+1)`, run as a
sequence (each output feeds the next `last`). Each binding must expose this
step *separately from the wall clock* so it is vectorable — see
`NonceAllocator.step` (Python) and `nonce_step` (Rust).

---

## Regenerating

```bash
cargo run -p proof-trading-sdk-conformance --bin gen-vectors
```

Writes the three files from the Rust core. **CI must run this and fail if the
tree is dirty:**

```bash
cargo run -p proof-trading-sdk-conformance --bin gen-vectors
git diff --exit-code conformance/      # nonzero ⇒ vectors drifted from core
```

This makes the vectors a tracked artifact of the core — they cannot silently
fall out of sync.

## Running the runners

```bash
# Rust (regression guard) — green
cargo test -p proof-trading-sdk-conformance

# Python (cross-language) — green
#   requires the native ext built: maturin develop in python/ first
(cd python && VIRTUAL_ENV=../.venv PATH=../.venv/bin:$PATH python -m pytest tests/test_conformance_vectors.py)

# TypeScript (cross-language) — SCAFFOLD, describe.skip (see below)
npx vitest run src/conformance.test.ts
```

---

## Handoff checklist

Ordered by value. Items 1–2 complete the cross-language guarantee; 3+ widen it.

### 1. Full codec coverage (generator)

`crates/spec/src/bin/gen_vectors.rs` emits a seed of 6 action types. Extend to
**all 27** plus edge cases. Concretely:

- [ ] One case per `ActionType` (PlaceOrder…AmendOrder, 0x01–0x1b).
- [ ] Integer edges: `0`, `u64::MAX` for every price/quantity/id field.
- [ ] Optional/`None` vs `Some`: `client_order_id`, market-scoped cancels,
      `OracleUpdate.publish_time_ms`, serde-default tails (`CreateMarket.pool_id`).
- [ ] Every flag combo that changes layout: `post_only`/`reduce_only`, each
      `TimeInForce` (Gtc/Ioc/Fok), each `Side`.
- [ ] Every enum: `Outcome`, `FailDepositReason`, `PriceComparison`,
      `MarkSourceMode`.
- [ ] Nested shapes: `EventOracleSource` (3 variants), `FeeTier` lists.
- [ ] **`OracleUpdateComposite` (0x14).** The TS SDK does not implement this —
      its vector will fail the TS runner. **That is the point**: the vector is
      the spec, the missing action is the bug. Do not delete the vector; add the
      action to `src/types.ts` + `src/codec.ts`.

### 2. TypeScript runner (`src/conformance.test.ts`)

Scaffolded and `describe.skip`. Three blockers, in order:

- [ ] **Export a payload-only encoder.** `encodePayload` in `src/codec.ts` is
      module-private and the codec family needs payload bytes, not a signed
      envelope. Export `encodePayloadBytes(action): Uint8Array` (or export
      `encodePayload` + `encode`). Wire it into the codec `it` block.
- [ ] **Finish the `toAction` adapter.** It maps the core's snake_case `input`
      (JSON-number ints, u8-array bytes) onto this SDK's camelCase `Action`
      union (`bigint` ints, `Uint8Array` bytes). Only the 4 seed types are
      wired; do the rest, or generate the map.
- [ ] **Add a sign-from-payload entry point** for the signing family (today
      `signAndEncode` only takes a typed `Action`, not raw payload bytes), and
      extract `nonceStep(last, nowMs)` from the TS client so the nonce family
      can pin it. The `owner` and `nonce` sub-cases already work — flip the
      relevant `it` blocks on as you unblock them, then drop the `.skip`.

### 3. CI wiring

- [ ] Add the regen drift check (above) and all three runners to CI.
- [ ] Gate releases on a green TS runner (the OracleUpdateComposite gap is a
      real shippable bug today).

### 4. Replay corpus (see below)

---

## Replay corpus (planned)

The richest vectors are **real signed transactions** from the indexer archive.
`crates/spec/src/lib.rs` has the schema (`ArchiveEnvelope`, mirroring
`indexer/pkg/envelope`) and a `replay_check` **stub**.

Plan: stream `<height>.ndjson`, base64-decode each `kind=="tx"` `raw.tx`,
`decode_tx` it through the core, re-encode, assert **byte-identical round-trip**
and that the signature **verifies**. This catches any encode/decode asymmetry
against production traffic, for free.

- [ ] Confirm the archived `tx` framing. **Caveat:** it may be wrapped by
      CometBFT (the tx bytes could be the CometBFT tx envelope, not the bare
      Proof envelope). Confirm before implementing `replay_check`, or the
      round-trip will fail on framing, not on a real codec bug.
- [ ] Implement `replay_check`; add a `replay/` runner pointed at a small
      checked-in archive slice (scrub anything sensitive first).

---

## Caveats / gotchas

- **Signing prefix.** The signing-domain string is pinned for
  signature compatibility; do not "fix" it. Any change invalidates every
  already-issued signature and breaks the signing vectors by design.
- **rmp-serde minimal-int encoding.** The core emits integers in minimal width.
  The TS SDK reproduces this via `minimizeBigInts` in `codec.ts`; if a TS codec
  vector mismatches by a leading byte, suspect int-width, not field order.
- **Unit enums serialize as name-strings** (`"Buy"`, `"Gtc"`), not indices —
  the vectors encode them as strings in `input` accordingly.
- **Wire newtypes accept bytes or seq.** The Rust `wire` newtypes deserialize
  from either a byte string or a u8 seq; vectors use seq so JSON has one form.
- **Vectors reflect the core at generation time.** They are only as correct as
  the core. They guard *cross-language agreement*, not spec-correctness — a
  shared bug across all three bindings would pass. Pair with the spec review.
