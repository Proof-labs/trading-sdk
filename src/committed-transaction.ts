import { sha256 } from "@noble/hashes/sha2.js";
import { boundedGatewayJson, type BoundedReadOptions } from "./bounded-read.js";
import { bytesToHex, chainIdFromString } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

export interface TransactionEvidenceSelection {
  /** SHA-256 of the exact signed wire envelope; 64 hexadecimal characters. */
  hash: string;
  /** Previously prepared canonical bytes. This read never re-encodes or submits them. */
  signedBytes: Uint8Array;
}

import {
  MAX_TX_BYTES,
  MAX_BLOCK_TXS,
  I64_MAX,
  invalid,
  object,
  hash,
  uint,
  bytes,
  same,
  rpcResult,
  events,
  blockTime,
  type TransactionEvidenceEvent,
} from "./chain-evidence.js";
export type { TransactionEvidenceEvent } from "./chain-evidence.js";

/** Matching /tx and /block responses from the configured trusted gateway.
 * This is NOT validator-signature, Merkle-proof or cryptographic finality
 * verification. A caller must trust the gateway's result code/events and chain
 * view. This proves only the returned occurrence: identical bytes may occur
 * again. A later replay rejection cannot exclude an earlier successful fill.
 * An unavailable/malformed response throws and proves no non-admission. */
export interface TransactionEvidence {
  source: "trusted-gateway";
  hash: string;
  signedBytes: Uint8Array;
  height: bigint;
  index: number;
  /** Protobuf JSON omits a zero code; that documented default is normalized. */
  code: number;
  /** An omitted protobuf events field is the empty list, not a missing receipt. */
  events: TransactionEvidenceEvent[];
  block: {
    hash: string;
    chainId: string;
    height: bigint;
    /** Original UTC RFC3339 timestamp, including all nanosecond digits. */
    time: string;
    /** Header H's previous-state app hash; NOT the state after this transaction. */
    appHash: string;
  };
}

/** Internal bounded, non-polling read. Both requests share one deadline. */
export async function readTransactionEvidence(
  gatewayUrl: string,
  expectedChainId: Uint8Array,
  selection: TransactionEvidenceSelection,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<TransactionEvidence> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    invalid("timeout");
  const deadline = performance.now() + timeoutMs;
  options.signal?.throwIfAborted();
  if (!(expectedChainId instanceof Uint8Array) || expectedChainId.length !== 32)
    invalid("pinned chain");
  if (
    !(selection.signedBytes instanceof Uint8Array) ||
    selection.signedBytes.length === 0 ||
    selection.signedBytes.length > MAX_TX_BYTES
  )
    invalid("signed bytes");
  // Copy caller-owned mutable data before the first await.
  const signedBytes = Uint8Array.from(selection.signedBytes);
  const chain = Uint8Array.from(expectedChainId);
  const requestedHash = hash(selection.hash, "requested hash");
  if (bytesToHex(sha256(signedBytes)).toUpperCase() !== requestedHash)
    invalid("requested hash/bytes mismatch");
  const remaining = (): BoundedReadOptions => {
    options.signal?.throwIfAborted();
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs < 1)
      throw new Error("Transaction evidence deadline exceeded");
    return { signal: options.signal, timeoutMs };
  };
  const base = gatewayUrl.replace(/\/+$/, "");
  const tx = rpcResult(
    await boundedGatewayJson(
      `${base}/v1/tx/${requestedHash}`,
      transport,
      remaining(),
    ),
  );
  if (
    hash(tx.hash, "transaction hash") !== requestedHash ||
    !same(bytes(tx.tx, "transaction bytes"), signedBytes)
  )
    invalid("returned transaction binding");
  const height = uint(tx.height, I64_MAX, "transaction height");
  if (height === 0n) invalid("transaction height");
  const index = Number(uint(tx.index, 0xffff_ffffn, "transaction index"));
  const result = object(tx.tx_result, "execution result");
  const code = Number(
    uint(
      result.code === undefined ? 0 : result.code,
      0xffff_ffffn,
      "execution code",
    ),
  );
  const preservedEvents = events(result.events);
  const response = rpcResult(
    await boundedGatewayJson(
      `${base}/v1/block?height=${height}`,
      transport,
      remaining(),
    ),
  );
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
  const transactions = object(block.data, "block data").txs;
  if (
    !Array.isArray(transactions) ||
    transactions.length > MAX_BLOCK_TXS ||
    index >= transactions.length
  )
    invalid("block transaction index");
  if (!same(bytes(transactions[index], "block transaction bytes"), signedBytes))
    invalid("block transaction binding");
  const blockHash = hash(
    object(response.block_id, "block ID").hash,
    "block hash",
  );
  const appHash = hash(header.app_hash, "block app hash");
  const time = blockTime(header.time);
  remaining();
  return {
    source: "trusted-gateway",
    hash: requestedHash,
    signedBytes,
    height,
    index,
    code,
    events: preservedEvents,
    block: {
      hash: blockHash,
      chainId: header.chain_id as string,
      height,
      time,
      appHash,
    },
  };
}
