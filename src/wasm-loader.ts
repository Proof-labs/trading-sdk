/**
 * Lazy loader for the WASM core (`crates/proof-trading-sdk-wasm`, built into
 * `src/wasm/` by `npm run build:wasm`).
 *
 * WASM instantiation is asynchronous — browsers disallow synchronous compile of
 * a module this size on the main thread (see ADR 0001). Call `await ready()`
 * once before any codec/signing call that routes through WASM; after it
 * resolves, `getWasm()` returns the initialized exports synchronously.
 *
 * The generated module and binary use literal relative references on purpose:
 * package consumers such as Vite must be able to discover, copy, and rewrite
 * both assets into their own build. `npm run build:wasm` runs before TypeScript,
 * so those generated files exist whenever this source is compiled.
 */

/** The subset of the generated WASM bindings the SDK uses. */
export interface WasmCore {
  /** wasm-bindgen init — accepts the `.wasm` bytes (Node) or fetches by URL
   *  (browser), passed as `{ module_or_path }` (the single-object form current
   *  wasm-bindgen requires; the bare positional argument is deprecated). */
  default: (options?: {
    module_or_path?: BufferSource | URL;
  }) => Promise<unknown>;
  encode_payload(actionType: number, fields: unknown): Uint8Array;
  decode_payload(actionType: number, payload: Uint8Array): unknown;
  signing_message(
    chainId: Uint8Array,
    actionType: number,
    seq: bigint,
    payload: Uint8Array,
  ): Uint8Array;
  encode_signed_tx(
    actionType: number,
    payload: Uint8Array,
    seq: bigint,
    pubkey: Uint8Array,
    signature: Uint8Array,
  ): Uint8Array;
  sign_and_encode(
    chainId: Uint8Array,
    actionType: number,
    payload: Uint8Array,
    seq: bigint,
    secretKey: Uint8Array,
  ): Uint8Array;
  pubkey_to_owner(pubkey: Uint8Array): Uint8Array;
  chain_id_from_string(chainId: string): Uint8Array;
}

let cached: WasmCore | null = null;
let initPromise: Promise<WasmCore> | null = null;

function isNode(): boolean {
  // Read `process` off globalThis so this compiles without `@types/node`
  // (the SDK is browser-first and does not depend on Node typings).
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return typeof g.process?.versions?.node === "string";
}

/**
 * Initialize the WASM core (idempotent). Resolves once the module is ready;
 * concurrent callers share a single instantiation.
 */
export async function ready(): Promise<void> {
  if (cached) return;
  if (!initPromise) {
    initPromise = (async () => {
      // Keep this import literal: Vite/Rollup must see the generated module in
      // a consuming application's dependency graph.
      const mod =
        (await import("./wasm/proof_trading_sdk_wasm.js")) as unknown as WasmCore;
      // Likewise, a literal URL lets the consumer's bundler emit the binary as
      // a hashed asset rather than leaving a broken node_modules-relative URL.
      const wasmUrl = new URL(
        "./wasm/proof_trading_sdk_wasm_bg.wasm",
        import.meta.url,
      );
      if (isNode()) {
        // Computed specifiers + loose casts keep `tsc` from needing Node types.
        const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as {
          readFileSync: (p: string) => BufferSource;
        };
        const url = (await import(/* @vite-ignore */ "node:url" as string)) as {
          fileURLToPath: (u: URL) => string;
        };
        const path = url.fileURLToPath(wasmUrl);
        await mod.default({ module_or_path: fs.readFileSync(path) });
      } else {
        await mod.default({ module_or_path: wasmUrl });
      }
      cached = mod;
      return mod;
    })();
  }
  await initPromise;
}

/**
 * The initialized WASM exports. Throws if `ready()` has not completed — this
 * keeps the codec entry points synchronous while making the async init explicit.
 */
export function getWasm(): WasmCore {
  if (!cached) {
    throw new Error(
      "WASM core not initialized — call `await ready()` before encoding/signing",
    );
  }
  return cached;
}
