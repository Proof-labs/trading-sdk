import { chainPin } from "./read-values.js";
import {
  asReadError,
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import {
  decodeBlockEvidenceHeader,
  type BlockEvidenceHeader,
} from "./block-header.js";
import { I64_MAX, rpcResult } from "./chain-evidence.js";
import { invalidRead as invalid, readObject as object } from "./read-values.js";
import {
  decodeMarketsSnapshot,
  MARKETS_SNAPSHOT_TIMEOUT_MS,
} from "./market-snapshot.js";
import { ready } from "./wasm-loader.js";
import { GatewayReadError } from "./errors.js";
import type { MarketsSnapshot } from "./types.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import {
  canonicalFinancialSelection,
  decodeFinancialStateData,
  type FinancialState,
  type FinancialStateSelection,
} from "./financial-state.js";

export interface FinalizedMarketsSnapshot extends MarketsSnapshot {
  /** See FinalizedReadWitness for binding and trust requirements. */
  witness: FinalizedReadWitness;
}

export type FinalizedFinancialState = FinancialState & {
  /** See FinalizedReadWitness for binding and trust requirements. */
  witness: FinalizedReadWitness;
};

/** Opt-in read: legacy financial responses stay byte-compatible and unwitnessed.
 * No fallback when the selected node has no finalized witness. */
export async function readFinalizedFinancialState(
  gatewayUrl: string,
  selection: FinancialStateSelection,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedFinancialState> {
  const expected = canonicalFinancialSelection(selection);
  const response = object(
    await boundedGatewayJson(
      `${gatewayUrl.replace(/\/+$/, "")}/v1/financial/state?markets=${expected.markets.join(",")}&owners=${expected.owners.join(",")}&witness=1`,
      transport,
      options,
      { purpose: "account" },
    ),
    "financial snapshot envelope",
  );
  if (
    Object.keys(response).length !== 2 ||
    !("data" in response) ||
    !("witness" in response)
  )
    invalid("financial snapshot envelope");
  const snapshot = asReadError("financial snapshot", () =>
    decodeFinancialStateData(response.data, expected),
  );
  // Same exact five-field witness as the other `?witness=1` routes.
  if (
    !response.witness ||
    typeof response.witness !== "object" ||
    Object.keys(response.witness).length !== 5
  )
    invalid("financial snapshot witness");
  const witness = decodeFinalizedReadWitness(
    response.witness,
    snapshot.finalizedHeight,
  );
  if (witness.finalizedBlockTimeMs !== snapshot.finalizedTimeMs)
    invalid("financial snapshot time mismatch", "binding");
  return { ...snapshot, witness };
}

export async function readBlockHeader(
  gatewayUrl: string,
  expectedChain: Uint8Array,
  height: bigint,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<BlockEvidenceHeader> {
  if (typeof height !== "bigint" || height < 1n || height > I64_MAX)
    invalid("requested block height");
  const chain = chainPin(expectedChain);
  const response = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/block?height=${height}`,
    transport,
    options,
  );
  return decodeBlockEvidenceHeader(rpcResult(response), height, chain);
}

/** Preserve the existing markets-snapshot witness instead of synthesizing one.
 * No unheighted fallback, direct-node read or default node identity. */
export async function readFinalizedMarketsSnapshot(
  gatewayUrl: string,
  expectedChain: Uint8Array,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedMarketsSnapshot> {
  const chain = chainPin(expectedChain);
  const response = object(
    await boundedGatewayJson(
      `${gatewayUrl.replace(/\/+$/, "")}/v1/markets-snapshot`,
      transport,
      {
        ...options,
        timeoutMs: options.timeoutMs ?? MARKETS_SNAPSHOT_TIMEOUT_MS,
      },
      { prepare: ready },
    ),
    "market snapshot envelope",
  );
  // The witness here follows the Rust snapshot decoder, which tolerates
  // extra witness fields, rather than the exact five-field `?witness=1` shape.
  let snapshot: MarketsSnapshot;
  try {
    snapshot = asReadError("market snapshot", () =>
      decodeMarketsSnapshot(
        new TextEncoder().encode(JSON.stringify(response)),
        chain,
      ),
    );
  } catch (error) {
    // A snapshot for another chain or an uncommitted height is well formed
    // data bound to the wrong state, like every other finalized-read mismatch.
    if (
      error instanceof GatewayReadError &&
      (error.message === "market snapshot: wrong chain" ||
        error.message === "market snapshot: uncommitted height")
    )
      throw new GatewayReadError("binding", "market snapshot", error.message, {
        cause: error,
      });
    throw error;
  }
  return {
    ...snapshot,
    witness: decodeFinalizedReadWitness(response.witness, snapshot.height),
  };
}
