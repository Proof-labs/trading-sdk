import {
  I64_MAX,
  blockTime,
  hash,
  invalid,
  object,
  same,
  uint,
} from "./chain-evidence.js";
import type { Hash32Hex } from "./read-values.js";
import { chainIdFromString } from "./crypto.js";
export interface BlockEvidenceHeader {
  hash: Hash32Hex;
  chainId: string;
  height: bigint;
  parentHash: Hash32Hex | null;
  time: string;
  /** Header H contains the app hash after H-1, not after H. */
  appHash: Hash32Hex | null;
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
    invalid("block height mismatch", "binding");
  if (
    typeof header.chain_id !== "string" ||
    header.chain_id.length === 0 ||
    header.chain_id.length > 128 ||
    !same(chainIdFromString(header.chain_id), chain)
  )
    invalid("block chain mismatch", "binding");
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
        ? null
        : hash(header.app_hash, "block app hash"),
  };
}
