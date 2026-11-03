import {
  decodeBlockEvidenceHeader,
  type BlockEvidenceHeader,
} from "./block-header.js";
import {
  hash32,
  readDeadline,
  rfc3339,
  MAX_DATE_MS,
  type Hash32Hex,
} from "./read-values.js";
import { GatewayReadError } from "./errors.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { boundedGatewayJson, type BoundedReadOptions } from "./bounded-read.js";
import {
  I64_MAX,
  bindBlockTransactions,
  bytes,
  events,
  invalid,
  object,
  rpcResult,
  uint,
  type TransactionEvidenceEvent,
} from "./chain-evidence.js";
import { bytesToHex } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

export interface BlockResultsWindowSelection {
  /** Fixed half-open wall-clock window, in exact epoch milliseconds. */
  fromMs: number;
  toMs: number;
  /** Explicit last height to inspect; its block time must reach toMs. */
  throughHeight: bigint;
  /** Maximum backward-scanned heights, 1..128. Default 32. No partial success. */
  maxHeights?: number;
  /** Caller may reduce these per-window ceilings, never exceed them. */
  maxDecodedBytes?: number;
  maxTransactions?: number;
  maxEvents?: number;
  maxAttributes?: number;
}

/** One block transaction and its same-index execution result. */
export interface BlockTransactionEvidence {
  index: number;
  hash: Hash32Hex;
  signedBytes: Uint8Array;
  code: number;
  events: TransactionEvidenceEvent[];
}

export interface BlockResultsEvidence {
  header: BlockEvidenceHeader;
  postAppHash: Hash32Hex;
  /** Every block transaction and its same-index result, including rejections. */
  transactions: BlockTransactionEvidence[];
  /** All system events, including any trades outside user transactions. */
  finalizeBlockEvents: TransactionEvidenceEvent[];
}

/** Complete bounded responses from one configured trusted gateway, NOT a
 * validator-signature or cryptographic event proof. Comet's results hash does
 * not include event strings. Node trust remains essential. Height continuity,
 * chain, result counts, times, each block's transaction list against its
 * header `data_hash`, and post-state/header bindings are checked. Block hashes
 * are not recomputed from headers, so a coherently lying gateway is not caught.
 * Blocks include the lower-boundary block (before fromMs, or genesis) and may
 * include end-boundary blocks. Consumers must apply [fromMs,toMs) themselves. */
export interface BlockResultsWindow {
  source: "trusted-gateway";
  fromMs: number;
  toMs: number;
  fromHeight: bigint;
  throughHeight: bigint;
  /** H+1 header binding the final scanned block's post-state hash. */
  anchor: BlockEvidenceHeader;
  /** Ascending heights; no missing or skipped blocks within this range. */
  blocks: BlockResultsEvidence[];
}

const WINDOW_DEFAULT_HEIGHTS = 32;
const WINDOW_MAX_HEIGHTS = 128;
const WINDOW_MAX_DECODED_BYTES = 8 * 1024 * 1024;
const WINDOW_MAX_TRANSACTIONS = 10_000;
const WINDOW_MAX_EVENTS = 16_384;
const WINDOW_MAX_ATTRIBUTES = 65_536;

/** Internal bounded scan. At most 2*maxHeights+1 GETs; each response <=1 MiB,
 * retained decoded JSON <=8 MiB, and all reads share one deadline. */
export async function readBlockResultsWindow(
  gatewayUrl: string,
  expectedChainId: Uint8Array,
  selection: BlockResultsWindowSelection,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<BlockResultsWindow> {
  const { fromMs, toMs, throughHeight } = selection;
  const deadline = readDeadline(options);
  const budget = (
    value: number | undefined,
    ceiling: number,
    field: string,
  ) => {
    const n = value ?? ceiling;
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling)
      throw new GatewayReadError("configuration", field);
    return n;
  };
  const maxHeights = budget(
    selection.maxHeights ?? WINDOW_DEFAULT_HEIGHTS,
    WINDOW_MAX_HEIGHTS,
    "window heights",
  );
  const maxBytes = budget(
    selection.maxDecodedBytes,
    WINDOW_MAX_DECODED_BYTES,
    "window bytes",
  );
  const maxTransactions = budget(
    selection.maxTransactions,
    WINDOW_MAX_TRANSACTIONS,
    "window transactions",
  );
  const maxEvents = budget(
    selection.maxEvents,
    WINDOW_MAX_EVENTS,
    "window events",
  );
  const maxAttributes = budget(
    selection.maxAttributes,
    WINDOW_MAX_ATTRIBUTES,
    "window attributes",
  );
  if (
    !Number.isSafeInteger(fromMs) ||
    fromMs < 0 ||
    !Number.isSafeInteger(toMs) ||
    toMs <= fromMs ||
    toMs > MAX_DATE_MS
  )
    invalid("fixed window");
  if (
    typeof throughHeight !== "bigint" ||
    throughHeight < 1n ||
    throughHeight >= I64_MAX
  )
    invalid("through height");
  if (!(expectedChainId instanceof Uint8Array) || expectedChainId.length !== 32)
    invalid("pinned chain");
  const chain = Uint8Array.from(expectedChainId);
  const base = gatewayUrl.replace(/\/+$/, "");
  let decodedBytes = 0;
  let transactionCount = 0;
  let eventCount = 0;
  let attributeCount = 0;
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const raw = await boundedGatewayJson(
      `${base}${path}`,
      transport,
      deadline.remaining(),
    );
    decodedBytes += new TextEncoder().encode(JSON.stringify(raw)).length;
    if (decodedBytes > maxBytes) invalid("window byte budget", "limit");
    deadline.remaining();
    return rpcResult(raw);
  };
  const decodeEvents = (value: unknown): TransactionEvidenceEvent[] => {
    // Enforce the remaining window budget before allocating decoded lists.
    // A busy block must not inherit the single-transaction evidence limits.
    const decoded = events(value, {
      maxEvents: maxEvents - eventCount,
      maxAttributes: maxAttributes - attributeCount,
    });
    eventCount += decoded.length;
    attributeCount += decoded.reduce(
      (total, event) => total + (event.attributes?.length ?? 0),
      0,
    );
    return decoded;
  };
  const anchor = decodeBlockEvidenceHeader(
    await read(`/v1/block?height=${throughHeight + 1n}`),
    throughHeight + 1n,
    chain,
  );
  const fromNs = BigInt(fromMs) * 1_000_000n;
  const toNs = BigInt(toMs) * 1_000_000n;
  const blocks: BlockResultsEvidence[] = [];
  let next = anchor;
  for (
    let height = throughHeight;
    blocks.length < maxHeights && height >= 1n;
    height--
  ) {
    const response = await read(`/v1/block?height=${height}`);
    const header = decodeBlockEvidenceHeader(response, height, chain);
    if (next.parentHash !== header.hash) invalid("parent hash continuity");
    if (rfc3339(header.time).nanos > rfc3339(next.time).nanos)
      invalid("block time continuity");
    if (height === throughHeight && rfc3339(header.time).nanos < toNs)
      invalid("source has not reached window end");
    const rawTransactions = object(
      object(response.block, "block").data,
      "block data",
    ).txs;
    // Go's non-omitempty slices encode a genuine empty list as null or [].
    if (rawTransactions !== null && !Array.isArray(rawTransactions))
      invalid("block transactions");
    const txs = (rawTransactions ?? []) as unknown[];
    transactionCount += txs.length;
    if (transactionCount > maxTransactions)
      invalid("window transaction budget", "limit");
    const blockTransactions = txs.map((value) =>
      bytes(value, "block transaction bytes"),
    );
    bindBlockTransactions(response, blockTransactions);
    const result = await read(`/v1/block_results?height=${height}`);
    if (uint(result.height, I64_MAX, "results height") !== height)
      invalid("results height mismatch", "binding");
    if (result.txs_results !== null && !Array.isArray(result.txs_results))
      invalid("transaction results");
    const txResults = (result.txs_results ?? []) as unknown[];
    if (txResults.length !== txs.length) invalid("transaction result count");
    if (
      result.finalize_block_events !== null &&
      !Array.isArray(result.finalize_block_events)
    )
      invalid("finalize block events");
    const postState = bytes(result.app_hash, "results app hash");
    if (postState.length !== 32) invalid("results app hash length");
    const postAppHash = hash32(bytesToHex(postState), "results app hash");
    if (next.appHash === null || postAppHash !== next.appHash)
      invalid("post-state/header binding");
    const transactions = blockTransactions.map(
      (signedBytes, index): BlockTransactionEvidence => {
        const execution = object(txResults[index], "transaction result");
        return {
          index,
          hash: hash32(bytesToHex(sha256(signedBytes))),
          signedBytes,
          code: Number(
            uint(
              execution.code === undefined ? 0 : execution.code,
              0xffff_ffffn,
              "execution code",
            ),
          ),
          events: decodeEvents(execution.events),
        };
      },
    );
    blocks.push({
      header,
      postAppHash,
      transactions,
      finalizeBlockEvents: decodeEvents(result.finalize_block_events ?? []),
    });
    deadline.remaining();
    if (rfc3339(header.time).nanos < fromNs || height === 1n) {
      return {
        source: "trusted-gateway",
        fromMs,
        toMs,
        fromHeight: height,
        throughHeight,
        anchor,
        blocks: blocks.reverse(),
      };
    }
    next = header;
  }
  throw new GatewayReadError(
    "limit",
    "height budget",
    "Block-results window exceeds height budget; no complete window available",
  );
}
