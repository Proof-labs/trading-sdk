# ADR 0001 — WASM core vs. parallel TypeScript types

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** SDK maintainers
- **Applies to:** `src/codec.ts`, `src/crypto.ts`, `src/types.ts`, and any future
  binding over the Rust core.

## TL;DR

The TypeScript SDK will move its **value-bearing codec + signing core to a WASM
build of the Rust `proof-trading-sdk` crate** (full encode **and** decode
through WASM), replacing the hand-written parallel MessagePack codec in
`src/codec.ts`. This ADR records _why_, so the tradeoff does not have to be
re-argued.

## Context

This repository is a **polyglot monorepo over one Rust core**
(`crates/proof-trading-sdk/`), not a pure-TypeScript package:

- **Rust** is the authoritative implementation of the wire format
  (`impl_action_encoding!` registry in
  `crates/proof-trading-sdk/src/codec.rs`, serde field order, `rmp-serde`
  encoding) and of signing (`signing_message`, `sign`, `pubkey_to_owner`,
  `chain_id_from_string` in `crypto.rs`).
- **Python** binds that core natively via PyO3
  (`crates/proof-trading-sdk-pyo3/`, using `pythonize`).
- **TypeScript** does **not** bind the core. Instead `src/types.ts` plus roughly
  770 lines of hand-written positional encode/decode arms in `src/codec.ts` are a
  _parallel reimplementation_ of the Rust registry and its serde field order.

The two implementations are kept in agreement only by **sampled conformance
vectors** (`conformance/*.ndjson`, checked by `src/conformance.test.ts`) and a
handful of golden vectors (`crates/spec/golden-vectors/*.hex`).

The Rust core already ships the bridge that was originally built _for_ a JS/WASM
binding but never wired up: `encode_payload_dyn` / `decode_payload_dyn`
(`codec.rs`) take a generic serde `Deserializer` / `Serializer`. `pythonize`
plugs into it for PyO3; `serde_wasm_bindgen` plugs into the exact same seam for
a WASM binding. Finishing that binding is the subject of this ADR.

## Options considered

### A. Codegen from Rust (pure-JS, no WASM)

Generate the TS action table (bytes + field order) from the Rust registry and
drive `encode`/`decode` from that data instead of hand-written switch arms.

- **Removes** schema duplication (field order, action bytes).
- **Does not remove** the _serializer_ duplication: the TS side still runs
  `@msgpack/msgpack` + the hand-written `minimizeBigInts` u32/u64 minimisation,
  which must produce bytes **identical to `rmp-serde`** across the whole input
  space. Two independent MessagePack encoders that must agree byte-for-byte is
  exactly the subtle-drift risk we are trying to eliminate, and it stays unsolved.

### B. Hybrid — WASM encode + sign, TypeScript decode

Put only the value-bearing path (encode + sign) in WASM; keep decode in TS so a
read-only consumer could avoid the WASM blob.

**Rejected — dominated.** WASM's costs are almost entirely **fixed** and incurred
the instant _any_ WASM ships:

- Rust toolchain in the build/CI,
- a `.wasm` artifact in the published package,
- bundler configuration for consumers loading `.wasm`,
- asynchronous initialization (`await ready()`),
- the JS↔Rust marshalling seam (`serde_wasm_bindgen`),
- reduced debuggability across the boundary.

Once encode is in WASM, **decode is nearly free to add** — the serde
infrastructure and every struct's (de)serialization glue is already compiled into
the blob. So the hybrid pays ~100% of the fixed cost, saves only a sliver of
marginal cost, and in exchange **re-introduces the drift risk on the decode path**
(TS decode remains a hand-maintained parallel impl) while **splitting the codec
across two languages** — a worse mental model than either pure option. The only
thing that would justify the hybrid is a hard requirement for a **WASM-free
read-only build**; we do not have that requirement.

### C. Full WASM core (chosen)

Run the Rust `encode_payload_dyn` / `decode_payload_dyn` and signing through a
`wasm-bindgen` build. Both directions go through the authoritative Rust code.

## Decision

**Adopt Option C — full WASM core.**

The deciding argument is **guarantee strength on the security-critical signing
path** (see CLAUDE.md "Security notes"):

- Conformance vectors **sample** the input space. They cannot _prove_ the TS
  serializer is byte-identical to `rmp-serde` across the whole `u64` range,
  nil/optional trailing-field combinations, and array/bin framing. A divergence
  at an untested value means either a signature over a **different logical
  payload than intended** or a silently rejected transaction.
- WASM **runs `rmp-serde` itself**, so the bytes are identical to the engine
  **by construction over the entire input space**, not merely on sampled points.
  Residual risk collapses to `wasm-bindgen` interop (JS↔Rust marshalling), a
  narrow and well-documented surface that the existing conformance vectors still
  exercise.

We take the full-WASM variant (encode **and** decode) rather than the hybrid
because, per the fixed-cost analysis above, decode is nearly free once encode is
in WASM, and keeping decode in Rust too eliminates the last hand-maintained
parallel codec and keeps the whole codec in one language.

## Consequences

### Accepted cost: asynchronous initialization

Browsers disallow **synchronous** `WebAssembly.Module` compilation of modules
larger than 4 KB on the main thread. The codec module exceeds that, so the
currently-synchronous public entry points — `signAndEncode`, `encodeSignedTx`,
`decodeTx`, `peekActionType`, `encodePayloadBytes`, `signEnvelopeFromPayload` —
must become initialization-gated. This is handled with a single module-level
`await ready()` (and `ExchangeClient.ready()`). It is a **breaking API change**
and warrants a minor-major version bump.

### Other consequences

- Building the SDK now requires a Rust + `wasm-pack` toolchain (CI and release
  only; pure-JS consumers install a prebuilt `.wasm` shipped in the package).
- `src/types.ts` **remains** the typed TS surface (the WASM boundary takes
  serde-shaped JS objects); only the codec _logic_ moves out of TS.
- `crates/proof-trading-sdk/src/codec.rs` and `types.rs` become the **single**
  source of truth for the action set. TS no longer carries a second copy to keep
  in sync — adding an action is a one-line change in the Rust registry.
- The migration lands in two steps so it stays bisectable: first the WASM crate
  alongside the existing TS codec with a differential test proving they agree,
  then deletion of the TS codec.

## References

- Rust bridge: `crates/proof-trading-sdk/src/codec.rs` —
  `encode_payload_dyn` / `decode_payload_dyn`.
- PyO3 precedent: `crates/proof-trading-sdk-pyo3/`.
- Current parallel codec being replaced: `src/codec.ts`.
- Drift guard that remains in place: `conformance/README.md`,
  `src/conformance.test.ts`, `crates/spec/golden-vectors/`.
