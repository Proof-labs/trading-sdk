import {
  MAX_SIGNED_TX_BYTES,
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
  bindBlockTransactions,
  type TransactionEvidenceEvent,
} from "./chain-evidence.js";
import {
  decodeBlockEvidenceHeader,
  type BlockEvidenceHeader,
} from "./block-header.js";
import { readDeadline, type Hash32Hex } from "./read-values.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { boundedGatewayJson, type BoundedReadOptions } from "./bounded-read.js";
import { bytesToHex } from "./crypto.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

export interface TransactionEvidenceSelection {
  /** SHA-256 of the exact signed wire envelope; 64 hexadecimal characters. */
  hash: string;
  /** Previously prepared canonical bytes. This read never re-encodes or submits them. */
  signedBytes: Uint8Array;
}

export type { TransactionEvidenceEvent } from "./chain-evidence.js";

/** Matching /tx and /block responses from the configured trusted gateway.
 * The block's full transaction list must match its header `data_hash`, but the
 * block hash is not recomputed from the header, and this is NOT
 * validator-signature or cryptographic finality verification. A caller must
 * trust the gateway's result code/events and chain view. This proves only the returned occurrence: identical bytes may occur
 * again. A later replay rejection cannot exclude an earlier successful fill.
 * An unavailable/malformed response throws and proves no non-admission. */
export interface TransactionEvidence {
  source: "trusted-gateway";
  hash: Hash32Hex;
  signedBytes: Uint8Array;
  height: bigint;
  index: number;
  /** Protobuf JSON omits a zero code; that documented default is normalized. */
  code: number;
  /** An omitted protobuf events field is the empty list, not a missing receipt. */
  events: TransactionEvidenceEvent[];
  block: BlockEvidenceHeader;
}

/** Internal bounded, non-polling read. Both requests share one deadline. */
export async function readTransactionEvidence(
  gatewayUrl: string,
  expectedChainId: Uint8Array,
  selection: TransactionEvidenceSelection,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<TransactionEvidence> {
  const { remaining } = readDeadline(options);
  if (!(expectedChainId instanceof Uint8Array) || expectedChainId.length !== 32)
    invalid("pinned chain", "configuration");
  if (
    !(selection.signedBytes instanceof Uint8Array) ||
    selection.signedBytes.length === 0
  )
    invalid("signed bytes", "configuration");
  if (selection.signedBytes.length > MAX_SIGNED_TX_BYTES)
    invalid("signed bytes", "limit");
  // Copy caller-owned mutable data before the first await.
  const signedBytes = Uint8Array.from(selection.signedBytes);
  const chain = Uint8Array.from(expectedChainId);
  let requestedHash: Hash32Hex;
  try {
    requestedHash = hash(selection.hash, "requested hash");
  } catch {
    invalid("requested hash", "configuration");
  }
  if (bytesToHex(sha256(signedBytes)).toUpperCase() !== requestedHash)
    invalid("requested hash/bytes mismatch", "configuration");
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
    invalid("returned transaction binding", "binding");
  const height = uint(tx.height, I64_MAX, "transaction height");
  if (height === 0n) invalid("transaction height", "malformed");
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
  const header = decodeBlockEvidenceHeader(response, height, chain);
  const transactions = object(block.data, "block data").txs;
  if (
    !Array.isArray(transactions) ||
    transactions.length > MAX_BLOCK_TXS ||
    index >= transactions.length
  )
    invalid("block transaction index", "malformed");
  const blockTransactions = transactions.map((value) =>
    bytes(value, "block transaction bytes"),
  );
  if (!same(blockTransactions[index], signedBytes))
    invalid("block transaction binding", "binding");
  bindBlockTransactions(response, blockTransactions);
  remaining();
  return {
    source: "trusted-gateway",
    hash: requestedHash,
    signedBytes,
    height,
    index,
    code,
    events: preservedEvents,
    block: header,
  };
}
