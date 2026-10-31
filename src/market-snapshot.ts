import { boundedGatewayJson } from "./bounded-read.js";
import { GatewayHttpError, GatewayReadError } from "./errors.js";
import type { MarketsSnapshot } from "./types.js";
import { marketsSnapshotFromWasm } from "./codec-adapter.js";
import { getWasm, ready } from "./wasm-loader.js";
import {
  defaultExchangeHttpTransport,
  type ExchangeHttpTransport,
} from "./http-transport.js";

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function invalid(): never {
  throw new Error("market snapshot: malformed complete response");
}

/** Strict whole-snapshot decode of the complete HTTP body, in the Rust core;
 * future trailing tuple fields are ignored. */
export function decodeMarketsSnapshot(
  body: Uint8Array,
  expectedChain: Uint8Array,
): MarketsSnapshot {
  return marketsSnapshotFromWasm(
    getWasm().decode_markets_snapshot(body, expectedChain),
  );
}

/** Gateway-only, bounded one-shot read. No retry, node fallback or health inference. */
export async function readMarketsSnapshot(
  gatewayUrl: string,
  expectedChain: Uint8Array,
  httpTransport: ExchangeHttpTransport = defaultExchangeHttpTransport,
): Promise<MarketsSnapshot> {
  try {
    const envelope = await boundedGatewayJson(
      `${gatewayUrl.replace(/\/$/, "")}/v1/markets-snapshot`,
      httpTransport,
      { timeoutMs: 10_000 },
      { prepare: ready },
    );
    // Transport validates JSON/duplicate keys; Rust still decodes the envelope's
    // base64 wire payload and every market/event field.
    return decodeMarketsSnapshot(
      new TextEncoder().encode(JSON.stringify(envelope)),
      expectedChain,
    );
  } catch (error) {
    if (error instanceof GatewayHttpError)
      throw new Error(`market snapshot returned HTTP ${error.status}`);
    if (
      error instanceof GatewayReadError &&
      (error.kind === "limit" || error.kind === "malformed")
    )
      invalid();
    if (error instanceof Error && error.message.startsWith("market snapshot"))
      throw error;
    throw new Error("market snapshot: transport or response unavailable");
  }
}
