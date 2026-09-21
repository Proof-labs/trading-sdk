# F23 compatibility snapshot

The temporary `5.1.0-f23.0` archive is based on the released `npm-v5.0.0` source,
with only the F23 market-statistics reads and their tests, documentation and
version metadata added. Its branch is `W39-12/f23-market-statistics-compat`.
The original F23 implementation remains on the normal `dev` review branch.

The current SDK `dev` includes the separate trigger expansion to proof-wire
2.1.0. That expansion appends two nil fields to order encodings even without
triggers, so consuming its complete artifact would change Web-UI's incumbent
trading bytes as a side effect of adding statistics. This snapshot keeps
proof-wire 2.0.0 and all incumbent codec/signing fixtures unchanged. F23 does not
require a trading-wire migration.

CI runs on pushes to this exact compatibility branch, with the existing gates,
codec/conformance suite and packed browser smoke intact. It is a source reference
for an immutable local archive, not an npm publication or a release to `main`.
Review the full difference from `npm-v5.0.0`; there are no Rust, Python, codec,
action-type or conformance-vector changes.

Build from the exact commit recorded in the consumer's provenance file:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run lint
npx prettier --check .
npm pack --ignore-scripts --json --pack-destination /path/to/artifact-directory
```

The WASM build requires the `wasm32-unknown-unknown` Rust target and the exact
wasm-bindgen CLI version pinned in `crates/proof-trading-sdk-wasm/Cargo.toml`.
The consumer records source commit, artifact SHA-256, npm integrity, tool versions
and build commands. Replace its file dependency only with an approved published
SDK whose trading compatibility has been reviewed; a matching read API or version
number alone is not evidence of unchanged codec behavior.
