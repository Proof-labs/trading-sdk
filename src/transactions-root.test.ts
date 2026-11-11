import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transactionsRoot } from "./chain-evidence.js";

const decode = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

// Captured exchange-devnet-1 blocks, shared with the Python suite. Provenance
// and regeneration: conformance/README.md, "Captured CometBFT vectors".
const DEVNET_BLOCKS = JSON.parse(
  readFileSync(
    new URL("../conformance/comet-transaction-roots.json", import.meta.url),
    "utf8",
  ),
) as { height: string; dataHash: string; txs: string[] }[];

describe("CometBFT transactions root", () => {
  it.each(DEVNET_BLOCKS.map((block) => [block.txs.length, block] as const))(
    "matches the devnet header data_hash for %i transactions",
    (_count, block) => {
      expect(transactionsRoot(block.txs.map(decode))).toBe(block.dataHash);
    },
  );
  it("depends on transaction order", () => {
    const txs = DEVNET_BLOCKS.find((block) => block.txs.length === 3)!.txs;
    expect(transactionsRoot([...txs].reverse().map(decode))).not.toBe(
      transactionsRoot(txs.map(decode)),
    );
  });
});
