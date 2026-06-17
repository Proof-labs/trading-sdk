# Cross-language conformance vectors

Golden test vectors that pin the **wire contract** of the Proof trading SDK
across every language binding. The Rust core is the source of truth; it
generates the vectors, and each binding (Rust, Python, TypeScript) must
reproduce every `expect` byte-for-byte. A divergence is a release blocker — it
means two SDKs would sign or encode the same logical action differently.

> **Status: codec + signing green in all 3 runners.** The generator emits 7 codec
> vectors, 3 signing vectors, and 4 nonce vectors. The Rust, Python, and TS
> runners all pass their active tests. The TS runner skips the nonce family
> (nonces are timestamp-derived; no standalone step function is needed) and
> `OracleUpdateComposite` (0x14, internal feeder action).

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
src/conformance.test.ts                     TS runner (codec + signing green)
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

# TypeScript (cross-language) — codec + signing green
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
- [ ] Every enum: `Outcome`, `PriceComparison`,
      `MarkSourceMode`.
- [ ] Nested shapes: `EventOracleSource` (3 variants), `FeeTier` lists.
- [ ] **`OracleUpdateComposite` (0x14).** This is an **internal feeder action**
      (composite CEX price submission) — no SDK user will ever submit it. The
      TS SDK intentionally omits it; the `toAction` adapter skips its vector
      gracefully. The Python and Rust runners include it because they generate
      all action types uniformly. Do not delete the vector; the TS runner
      skips unwired action types.

### 2. TypeScript runner (`src/conformance.test.ts`)

All three blockers resolved:

- [x] **Export a payload-only encoder.** `encodePayloadBytes(action): Uint8Array`
      exported from `src/codec.ts` (and barrel `src/index.ts`). Codec block passes.
- [x] **Finish the `toAction` adapter.** All 27 action types wired. `OracleUpdateComposite`
      (0x14) intentionally omitted — internal feeder action. Codec block passes.
- [x] **Add a sign-from-payload entry point.** `signEnvelopeFromPayload(chainId, actionType,
      seq, payloadBytes, privateKey)` in `src/codec.ts`. Signing block passes (1 sign + 2 owner
      vectors). Nonce is timestamp-derived — the TS SDK does not expose a standalone
      step function, matching the sibling SDKs' design.

**Known gaps:** No nonce vectors (not applicable), no `OracleUpdateComposite` (intentional).

### 3. CI wiring

- [ ] Add the regen drift check (above) and all three runners to CI.
- [ ] Gate releases on a green TS runner. The `OracleUpdateComposite` vector
      is skipped by the TS runner (internal feeder action, intentionally
      omitted) — the other 2 runners still verify it.

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
