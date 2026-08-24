// Vitest setup: initialize the WASM codec/signing core once per test file, so
// the (now synchronous, WASM-backed) encode/decode/sign functions are ready.
// Idempotent — see `wasm-loader.ts`.
import { ready } from "./wasm-loader.js";

await ready();
