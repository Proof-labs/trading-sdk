import { sha256 } from "@noble/hashes/sha2.js";
import { boundedGatewayJson, type BoundedReadOptions } from "./bounded-read.js";
import {
  I64_MAX,
  blockTime,
  bytes,
  events,
  hash,
  invalid,
  object,
  rpcResult,
  same,
  uint,
  type TransactionEvidenceEvent,
} from "./chain-evidence.js";
import { bytesToHex, chainIdFromString } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

export interface BlockResultsWindowSelection {
  /** Fixed half-open wall-clock window, in exact epoch milliseconds. */
  fromMs: number;
  toMs: number;
  /** Explicit last height to inspect; its block time must reach toMs. */
  throughHeight: bigint;
  /** Maximum backward-scanned heights, 1..128. Default 32. No partial success. */
  maxHeights?: number;
}

export interface BlockEvidenceHeader {
  hash: string;
  chainId: string;
  height: bigint;
  parentHash: string | null;
  time: string;
  /** Header H contains the app hash after H-1, not after H. */
  appHash: string;
}

export interface BlockResultsEvidence {
  header: BlockEvidenceHeader;
  postAppHash: string;
  /** Every block transaction and its same-index result, including rejections. */
  transactions: {
    index: number;
    hash: string;
    signedBytes: Uint8Array;
    code: number;
    events: TransactionEvidenceEvent[];
  }[];
  /** All system events, including any trades outside user transactions. */
  finalizeBlockEvents: TransactionEvidenceEvent[];
}

/** Complete bounded responses from one configured trusted gateway, NOT a
 * validator-signature or cryptographic event proof. Comet's results hash does
 * not include event strings. Node trust remains essential. Height continuity,
 * chain, result counts, times and post-state/header bindings are checked.
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

const MAX_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTIONS = 10_000;
const MAX_EVENTS = 16_384;
const MAX_ATTRIBUTES = 65_536;

function timeNs(time: string): bigint {
  const seconds = Date.parse(`${time.slice(0, 19)}Z`);
  const fraction = time.slice(19, -1).replace(/^\./, "");
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

/** Internal common header decoder; does not verify validator signatures. */
export function decodeBlockEvidenceHeader(
  response: Record<string, unknown>,
  height: bigint,
  chain: Uint8Array,
): BlockEvidenceHeader {
  const block = object(response.block, "block");
  const header = object(block.header, "block header");
  if (uint(header.height, I64_MAX, "block height") !== height)
    invalid("block height mismatch");
  if (
    typeof header.chain_id !== "string" ||
    header.chain_id.length === 0 ||
    header.chain_id.length > 128 ||
    !same(chainIdFromString(header.chain_id), chain)
  )
    invalid("block chain mismatch");
  const previous = object(header.last_block_id, "previous block ID").hash;
  const parentHash =
    height === 1n && previous === ""
      ? null
      : hash(previous, "parent block hash");
  return {
    hash: hash(object(response.block_id, "block ID").hash, "block hash"),
    chainId: header.chain_id as string,
    height,
    parentHash,
    time: blockTime(header.time),
    appHash:
      height === 1n && header.app_hash === ""
        ? ""
        : hash(header.app_hash, "block app hash"),
  };
}

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
  const maxHeights = selection.maxHeights ?? 32;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = options.signal;
  if (
    !Number.isSafeInteger(fromMs) ||
    fromMs < 0 ||
    !Number.isSafeInteger(toMs) ||
    toMs <= fromMs ||
    toMs > 8_640_000_000_000_000
  )
    invalid("fixed window");
  if (
    typeof throughHeight !== "bigint" ||
    throughHeight < 1n ||
    throughHeight >= I64_MAX
  )
    invalid("through height");
  if (!Number.isSafeInteger(maxHeights) || maxHeights < 1 || maxHeights > 128)
    invalid("height budget");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    invalid("timeout");
  if (!(expectedChainId instanceof Uint8Array) || expectedChainId.length !== 32)
    invalid("pinned chain");
  const chain = Uint8Array.from(expectedChainId);
  const deadline = performance.now() + timeoutMs;
  const base = gatewayUrl.replace(/\/+$/, "");
  let decodedBytes = 0;
  let transactionCount = 0;
  let eventCount = 0;
  let attributeCount = 0;
  const check = () => {
    signal?.throwIfAborted();
    if (performance.now() >= deadline)
      throw new Error("Block-results window deadline exceeded");
  };
  const read = async (path: string): Promise<Record<string, unknown>> => {
    check();
    const budget = Math.floor(deadline - performance.now());
    if (budget < 1) throw new Error("Block-results window deadline exceeded");
    const raw = await boundedGatewayJson(`${base}${path}`, transport, {
      signal,
      timeoutMs: budget,
    });
    decodedBytes += new TextEncoder().encode(JSON.stringify(raw)).length;
    if (decodedBytes > MAX_DECODED_BYTES) invalid("window byte budget");
    check();
    return rpcResult(raw);
  };
  const decodeEvents = (value: unknown): TransactionEvidenceEvent[] => {
    const decoded = events(value);
    eventCount += decoded.length;
    attributeCount += decoded.reduce(
      (total, event) => total + (event.attributes?.length ?? 0),
      0,
    );
    if (eventCount > MAX_EVENTS || attributeCount > MAX_ATTRIBUTES)
      invalid("window event budget");
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
    if (timeNs(header.time) > timeNs(next.time))
      invalid("block time continuity");
    if (height === throughHeight && timeNs(header.time) < toNs)
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
    if (transactionCount > MAX_TRANSACTIONS)
      invalid("window transaction budget");
    const result = await read(`/v1/block_results?height=${height}`);
    if (uint(result.height, I64_MAX, "results height") !== height)
      invalid("results height mismatch");
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
    const postAppHash = bytesToHex(postState).toUpperCase();
    if (postAppHash !== next.appHash) invalid("post-state/header binding");
    const transactions = txs.map((value, index) => {
      const signedBytes = bytes(value, "block transaction bytes");
      const execution = object(txResults[index], "transaction result");
      return {
        index,
        hash: bytesToHex(sha256(signedBytes)).toUpperCase(),
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
    });
    blocks.push({
      header,
      postAppHash,
      transactions,
      finalizeBlockEvents: decodeEvents(result.finalize_block_events ?? []),
    });
    check();
    if (timeNs(header.time) < fromNs || height === 1n) {
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
  throw new Error(
    "Block-results window exceeds height budget; no complete window available",
  );
}
