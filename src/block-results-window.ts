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

interface BlockResultsBudgets {
  /** Maximum backward-scanned heights, 1..128. Default 32. No partial success. */
  maxHeights?: number;
  /** Caller may reduce these aggregate ceilings, never exceed them. */
  maxDecodedBytes?: number;
  maxTransactions?: number;
  maxEvents?: number;
  maxAttributes?: number;
}

export interface BlockResultsWindowSelection extends BlockResultsBudgets {
  /** Fixed half-open wall-clock window, in exact epoch milliseconds. */
  fromMs: number;
  toMs: number;
  /** Explicit last height to inspect; its block time must reach toMs. */
  throughHeight: bigint;
}

export interface BlockResultsRangeSelection extends BlockResultsBudgets {
  /** Exact inclusive bounds. No timestamp-based selection or extra boundary block. */
  fromHeight: bigint;
  throughHeight: bigint;
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
 * Range bounds are inclusive; equal and sub-millisecond block times are retained. */
export interface BlockResultsRange {
  source: "trusted-gateway";
  fromHeight: bigint;
  throughHeight: bigint;
  /** H+1 header binding the final scanned block's post-state hash. */
  anchor: BlockEvidenceHeader;
  /** Ascending heights; no missing or skipped blocks within this range. */
  blocks: BlockResultsEvidence[];
}

/** Blocks include the lower-boundary block (before fromMs, or genesis) and may
 * include end-boundary blocks. Consumers must apply [fromMs,toMs) themselves. */
export interface BlockResultsWindow extends BlockResultsRange {
  fromMs: number;
  toMs: number;
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
  const { fromMs, toMs } = selection;
  const range = await readBlockResults(
    gatewayUrl,
    expectedChainId,
    selection,
    { kind: "window", fromMs, toMs },
    options,
    transport,
  );
  return {
    source: range.source,
    fromMs,
    toMs,
    fromHeight: range.fromHeight,
    throughHeight: range.throughHeight,
    anchor: range.anchor,
    blocks: range.blocks,
  };
}

/** The same bounded decoder as the window read, selected by inclusive heights. */
export async function readBlockResultsRange(
  gatewayUrl: string,
  expectedChainId: Uint8Array,
  selection: BlockResultsRangeSelection,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<BlockResultsRange> {
  return readBlockResults(
    gatewayUrl,
    expectedChainId,
    selection,
    { kind: "range", fromHeight: selection.fromHeight },
    options,
    transport,
  );
}

async function readBlockResults(
  gatewayUrl: string,
  expectedChainId: Uint8Array,
  selection: BlockResultsBudgets & { throughHeight: bigint },
  boundary:
    | { kind: "window"; fromMs: number; toMs: number }
    | { kind: "range"; fromHeight: bigint },
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<BlockResultsRange> {
  const { throughHeight } = selection;
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
    `${boundary.kind} heights`,
  );
  const maxBytes = budget(
    selection.maxDecodedBytes,
    WINDOW_MAX_DECODED_BYTES,
    `${boundary.kind} bytes`,
  );
  const maxTransactions = budget(
    selection.maxTransactions,
    WINDOW_MAX_TRANSACTIONS,
    `${boundary.kind} transactions`,
  );
  const maxEvents = budget(
    selection.maxEvents,
    WINDOW_MAX_EVENTS,
    `${boundary.kind} events`,
  );
  const maxAttributes = budget(
    selection.maxAttributes,
    WINDOW_MAX_ATTRIBUTES,
    `${boundary.kind} attributes`,
  );
  if (
    boundary.kind === "window" &&
    (!Number.isSafeInteger(boundary.fromMs) ||
      boundary.fromMs < 0 ||
      !Number.isSafeInteger(boundary.toMs) ||
      boundary.toMs <= boundary.fromMs ||
      boundary.toMs > MAX_DATE_MS)
  )
    invalid("fixed window", "configuration");
  if (
    typeof throughHeight !== "bigint" ||
    throughHeight < 1n ||
    throughHeight >= I64_MAX
  )
    invalid("through height", "configuration");
  if (boundary.kind === "range") {
    if (
      typeof boundary.fromHeight !== "bigint" ||
      boundary.fromHeight < 1n ||
      boundary.fromHeight > throughHeight
    )
      invalid("from height", "configuration");
    if (throughHeight - boundary.fromHeight + 1n > BigInt(maxHeights))
      invalid("height budget", "limit");
  }
  if (!(expectedChainId instanceof Uint8Array) || expectedChainId.length !== 32)
    invalid("pinned chain", "configuration");
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
    if (decodedBytes > maxBytes)
      invalid(`${boundary.kind} byte budget`, "limit");
    deadline.remaining();
    return rpcResult(raw);
  };
  const decodeEvents = (value: unknown): TransactionEvidenceEvent[] => {
    // Enforce the remaining aggregate budget before allocating decoded lists.
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
  const fromNs =
    boundary.kind === "window" ? BigInt(boundary.fromMs) * 1_000_000n : null;
  const toNs =
    boundary.kind === "window" ? BigInt(boundary.toMs) * 1_000_000n : null;
  const blocks: BlockResultsEvidence[] = [];
  let next = anchor;
  for (
    let height = throughHeight;
    blocks.length < maxHeights && height >= 1n;
    height--
  ) {
    const response = await read(`/v1/block?height=${height}`);
    const header = decodeBlockEvidenceHeader(response, height, chain);
    if (next.parentHash !== header.hash)
      invalid("parent hash continuity", "binding");
    if (rfc3339(header.time).nanos > rfc3339(next.time).nanos)
      invalid("block time continuity", "binding");
    if (
      height === throughHeight &&
      toNs !== null &&
      rfc3339(header.time).nanos < toNs
    )
      invalid("source has not reached window end", "malformed");
    const rawTransactions = object(
      object(response.block, "block").data,
      "block data",
    ).txs;
    // Go's non-omitempty slices encode a genuine empty list as null or [].
    if (rawTransactions !== null && !Array.isArray(rawTransactions))
      invalid("block transactions", "malformed");
    const txs = (rawTransactions ?? []) as unknown[];
    transactionCount += txs.length;
    if (transactionCount > maxTransactions)
      invalid(`${boundary.kind} transaction budget`, "limit");
    const blockTransactions = txs.map((value) =>
      bytes(value, "block transaction bytes"),
    );
    bindBlockTransactions(response, blockTransactions);
    const result = await read(`/v1/block_results?height=${height}`);
    if (uint(result.height, I64_MAX, "results height") !== height)
      invalid("results height mismatch", "binding");
    if (result.txs_results !== null && !Array.isArray(result.txs_results))
      invalid("transaction results", "malformed");
    const txResults = (result.txs_results ?? []) as unknown[];
    if (txResults.length !== txs.length)
      invalid("transaction result count", "binding");
    if (
      result.finalize_block_events !== null &&
      !Array.isArray(result.finalize_block_events)
    )
      invalid("finalize block events", "malformed");
    const postState = bytes(result.app_hash, "results app hash");
    if (postState.length !== 32)
      invalid("results app hash length", "malformed");
    const postAppHash = hash32(bytesToHex(postState), "results app hash");
    if (next.appHash === null || postAppHash !== next.appHash)
      invalid("post-state/header binding", "binding");
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
    const complete =
      boundary.kind === "range"
        ? height === boundary.fromHeight
        : (fromNs !== null && rfc3339(header.time).nanos < fromNs) ||
          height === 1n;
    if (complete) {
      return {
        source: "trusted-gateway",
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
    `Block-results ${boundary.kind} exceeds height budget; no complete ${boundary.kind} available`,
  );
}
