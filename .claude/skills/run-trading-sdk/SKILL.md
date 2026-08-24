---
name: run-trading-sdk
description: Build, run, test, and drive the @proof/trading-sdk TypeScript SDK. Use when asked to build the SDK, run its tests, verify signing/encoding works, or exercise the WASM codec end to end.
---

`@proof/trading-sdk` is a TypeScript SDK whose value-bearing codec + Ed25519
signing runs through a WASM build of the Rust core (see ADR 0001). There is no
GUI or server to "run" — the way an agent drives it is the smoke driver
**`.claude/skills/run-trading-sdk/driver.mjs`**, which exercises the offline
path end to end (WASM init → key generation → owner derivation → sign+encode a
signed envelope → decode → round-trip assertions). All paths below are relative
to the repo root.

The one thing to know before anything else: **the codec/signing is
async-initialized** — you must `await ready()` once before any encode/sign/decode
call. The driver and `ExchangeClient` do this for you.

## Prerequisites

Node ≥ 20, a Rust toolchain with the `wasm32-unknown-unknown` target, and the
`wasm-bindgen` CLI. Verify (these are the versions this skill was built against):

```bash
node --version         # v22.23.1
cargo --version        # cargo 1.96.0-nightly
rustc --version        # rustc 1.96.0
wasm-bindgen --version # wasm-bindgen 0.2.126
```

Add the wasm target (idempotent):

```bash
rustup target add wasm32-unknown-unknown
```

The `wasm-bindgen` **CLI version must match the `wasm-bindgen` crate** that
`Cargo.lock` resolves, or `npm run build:wasm` fails with a schema-mismatch
error. Install the matching CLI with `cargo install wasm-bindgen-cli --version 0.2.126`
(match whatever `Cargo.lock` pins). Check they agree:

```bash
test "$(wasm-bindgen --version | awk '{print $2}')" = "$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep -oP '(?<=version = ")[^"]+')" && echo "wasm-bindgen CLI matches crate ✓"
```

## Setup

```bash
npm install
```

## Build

Builds the Rust core to WASM, runs `tsc`, and copies the `.wasm` into `dist/`
(the published package ships the artifact, so this must happen before the
package is usable):

```bash
npm run build
```

## Run (agent path)

The driver builds nothing on its own — **run `npm run build` first** — then:

```bash
node .claude/skills/run-trading-sdk/driver.mjs
```

Expected tail (19 assertions, exit 0):

```
✓ WASM core ready()
✓ keypair + owner: 0x…
✓ encodePayloadBytes: 52 bytes
✓ signAndEncode: 166-byte signed envelope
✓ decodeTx round-trip: action, seq, pubkey, signature all match
✓ deterministic re-encode

ALL 19 CHECKS PASSED — offline sign/encode/decode path is live.
```

The driver imports the built `dist/index.js` and covers exactly the surface most
PRs here touch: `ready`, `generateKeypair`/`pubkeyToOwner`/`ownerToHex`,
`encodePayloadBytes`, `signAndEncode`, `peekActionType`, `decodeTx`. To smoke a
change, edit an action in the driver and re-run.

### Direct invocation (call one function, no full app)

For a PR that touches a single internal, import from the built `dist/` with
plain Node ESM (top-level `await` works; no `tsx` needed):

```bash
node --input-type=module -e '
import { ready, signAndEncode, decodeTx, chainIdFromString, generateKeypair, pubkeyToOwner } from "./dist/index.js";
await ready();
const { privateKey, publicKey } = generateKeypair();
const owner = pubkeyToOwner(publicKey);
const wire = signAndEncode(chainIdFromString("exchange-devnet-1"),
  { type: "CancelAllOrders", data: { owner, market: 1 } }, 42n, privateKey);
console.log("signed:", wire.length, "bytes; decoded type:", decodeTx(wire).action.type);
'
```

## Test

`pretest` rebuilds the WASM, then vitest runs (a setup file calls `ready()`):

```bash
npm test
```

The RPC-gated live tests need a running gateway and stay skipped offline; that
is normal. Treat the command's exit status as authoritative rather than copying
a historical test count into review evidence.

### Validate the published browser artifact

For release, codec, loader, dependency, or packaging changes, the offline
driver is necessary but not sufficient. Exercise exactly what a registry
consumer receives:

```bash
npm pack --dry-run
npm run smoke:browser:prepare
npm run smoke:browser
```

The prepare step packs the SDK, installs that tarball in a clean Vite consumer,
calls `ready()`, compares the encoded `PlaceOrder` bytes with the canonical
vector, and fails unless Vite emits exactly one `.wasm` asset. The browser step
then loads that asset in Chromium and requires one successful WASM response.

## Run (human path)

The devnet example needs network (and a faucet token for the full flow), so it
is not part of the offline smoke path:

```bash
npm run example   # → npx tsx examples/connect-and-trade.ts; hits the public devnet
```

## Gotchas

- **`await ready()` is mandatory before any codec/sign/decode call.** The WASM
  compiles asynchronously (browsers forbid sync compile > 4 KB on the main
  thread). A raw `signAndEncode`/`decodeTx` without it throws "not ready."
  `ExchangeClient` and the driver handle it; standalone callers must not forget.
- **`build:wasm` must run before `npm test`.** `npm test` depends on `dist`-less
  `src/wasm`; `pretest` builds it. If you run `vitest` directly (bypassing the
  npm script), build the WASM first or every codec test fails at import.
- **`wasm-bindgen` CLI vs crate version skew.** They must match `Cargo.lock`. A
  minor skew emits a harmless `using deprecated parameters for the initialization
function` warning on load (safe to ignore); a larger mismatch fails the build.
- **`npx tsx -e '…'` can't do top-level `await`** (it emits CJS) — the direct
  `import … await ready()` snippet fails with _"Top-level await is currently not
  supported with the cjs output format."_ Use `node --input-type=module -e` against
  the built `dist/` (as above), or put the snippet in a `.ts`/`.mjs` file.
- **`ExchangeClient` needs a network** (devnet gateway) and is out of scope for
  the offline driver. The driver deliberately exercises only the pure
  sign/encode/decode core, which is what you can verify headless.

## Troubleshooting

- **`Error: … not ready` / `getWasm()` throws**: you called a codec function
  before `await ready()`. Add the await once at startup.
- **`node driver.mjs` → `ERR_MODULE_NOT_FOUND` for `../../../dist/index.js`**:
  you haven't built. Run `npm run build`, then re-run the driver.
- **`build:wasm` fails with a bindgen schema/version error**: the `wasm-bindgen`
  CLI doesn't match the crate. Reinstall with the version `Cargo.lock` pins
  (see Prerequisites).
