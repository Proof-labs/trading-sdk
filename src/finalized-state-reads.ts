/** Bounded read evidence, not validator-signature verification or trade permission. */
import {
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import {
  decodeBlockEvidenceHeader,
  type BlockEvidenceHeader,
} from "./block-results-window.js";
import { I64_MAX, invalid, object, rpcResult } from "./chain-evidence.js";
import { decodeMarketsSnapshot } from "./market-snapshot.js";
import type { MarketsSnapshot } from "./types.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import {
  canonicalFinancialSelection,
  decodeFinancialStateData,
  type FinancialState,
  type FinancialStateSelection,
} from "./financial-state.js";

export interface FinalizedMarketsSnapshot extends MarketsSnapshot {
  /** Same node view; bind appHash to the pinned chain's H+1 header separately. */
  witness: FinalizedReadWitness;
}

export interface FinalizedFinancialState extends FinancialState {
  /** Same node view only. Bind to a chain-qualified view and H+1 separately. */
  witness: FinalizedReadWitness;
}

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
      `${gatewayUrl.replace(/\/$/, "")}/v1/financial/state?markets=${expected.markets.join(",")}&owners=${expected.owners.join(",")}&witness=1`,
      transport,
      options,
    ),
    "financial snapshot envelope",
  );
  if (
    Object.keys(response).length !== 2 ||
    !("data" in response) ||
    !("witness" in response)
  )
    invalid("financial snapshot envelope");
  const snapshot = decodeFinancialStateData(response.data, expected);
  const witness = decodeFinalizedReadWitness(
    response.witness,
    snapshot.finalizedHeight,
  );
  if (witness.finalizedBlockTimeMs !== snapshot.finalizedTimeMs)
    invalid("financial snapshot time mismatch");
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
  const chain = Uint8Array.from(expectedChain);
  const response = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/$/, "")}/v1/block?height=${height}`,
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
  const chain = Uint8Array.from(expectedChain);
  const response = object(
    await boundedGatewayJson(
      `${gatewayUrl.replace(/\/$/, "")}/v1/markets-snapshot`,
      transport,
      options,
    ),
    "market snapshot envelope",
  );
  const snapshot = decodeMarketsSnapshot(response, chain);
  return {
    ...snapshot,
    witness: decodeFinalizedReadWitness(response.witness, snapshot.height),
  };
}
