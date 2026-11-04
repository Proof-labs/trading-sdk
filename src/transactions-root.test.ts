import { describe, expect, it } from "vitest";
import { transactionsRoot } from "./chain-evidence.js";

const decode = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

// Real exchange-devnet-1 blocks (CometBFT 0.39), copied verbatim from
// GET https://api.dev.proof.trade/v1/block?height=<height>: block.data.txs and
// block.header.data_hash. Regenerate by fetching blocks with 0, 1, 3 and 5
// transactions. 3 and 5 exercise the uneven power-of-two split.
const DEVNET_BLOCKS: { height: string; dataHash: string; txs: string[] }[] = [
  {
    height: "9263486",
    dataHash:
      "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
    txs: [],
  },
  {
    height: "9263483",
    dataHash:
      "5BDEA86F3010B286719926CF5F612EEFF4C96E61580096784B9F4EC0321EB9A9",
    txs: [
      "lgIEzwAAAaGg18oexCiXZ9wAFE8ZzLY6IGfMoBZMZcyIWMy5zIExKsztzLAMd6NCdXkBwMDAxCBGgOTB7H7tGDpVK+4MfW3ik0EpnZb4TZm3RndTJimS7sRAQYFkzIBVHMMFA4gPeTnGC+y6LbcZfR8MzZ9zdYqAG/s1tkg2L61EzQPMxo+I34MjYk0vZwbBkTBL5b8ENm+6Aw==",
    ],
  },
  {
    height: "9263465",
    dataHash:
      "D4FD9EEF3736CBC293BD7F6692AC3D37B78D115806888CFBF5D17CF293C7FA91",
    txs: [
      "lgIDzwAAAaGg17HwxC2UA84FgE9Y3AAUZgHM6DLMlT0wMcyLfR82OGokG1nMt8zSzNfPAAABoaDXsenEIINl6OG3+lKXMpDzgAzYU+pOmGOZT8Gn0iaGMmhGiHgFxEAMGGkFkUZAmnXRxChdVUawhSm9aZfvkQqiLg2CFvNUwDE388N63MHNU2kS3TKtTWGOTfVAn407PsxDxTYr6eoL",
      "lgIazwAAAaGg17GjxEKd3AAUaXbMwsyRRcy8zPdzfFnMj1HMt8zTCTAaGBjM1cDODuayg80JxKNCdXnOAAiBA80Kvs4O5rKDw8KjR3RjwMDEIPz93Fyu137m7uTfK298jy6uuV6pxBWbknT263s3PvRAxEAPm2fGGBQztCsA1lfQpoaBzg9XIHEhO8U3vuumI5phjgUMoLZZWZfASKbhlGu0l2/e341PtJM1hq5i4rVmmF4C",
      "lgIBzwAAAaGg17HpxDebzQnH3AAUEczcGDQxQX8CzPtjc8yGzK7MhjfMo8y2McyGU6RTZWxszgVTNxgBwMPCo0d0Y8DAxCCAECpPtw2y2BKFTmk42xJ6nwJvDTS6G2WpAqiBxY1R8sRArUerF9cncXnZ/sWELSTpMJrInmN9ctNDa0KeAH7CYj1zXHhnL0SXxZpEx1cQg7LQBNpRWEX407gGeANCIE/1BA==",
    ],
  },
  {
    height: "9263457",
    dataHash:
      "2E5846D4BBE8BCEDF28511B5775DD0157FE320F6B7FA84177C9B0983DE5544C8",
    txs: [
      "lgIDzwAAAaGg16Y1xDGUAc8AAAAR63pNaNwAFGYBzOgyzJU9MDHMi30fNjhqJBtZzLfM0szXzwAAAaGg16YyxCCDZejht/pSlzKQ84AM2FPqTphjmU/Bp9ImhjJoRoh4BcRADq3MTe2ud4xIr8MeeohTL5/QGRTX+yOH28hLY2H4qEEQpLcN9YpNRkEXe7ln8zBnqpQgQVOkL1Ift6dlyFr4Cg==",
      "lgIDzwAAAaGg16Y2xC2UA84FgE9Y3AAUZgHM6DLMlT0wMcyLfR82OGokG1nMt8zSzNfPAAABoaDXpjLEIINl6OG3+lKXMpDzgAzYU+pOmGOZT8Gn0iaGMmhGiHgFxEAtqX9qQZs535eXwKgqn4EmmTbAqgjUlf/lVOrExAKgWy/Rb3VFSXIQxZbrPG0Sxuw4g5hyF42nfToNimoMG2wI",
      "lgIazwAAAaGg16Z1xESd3AAUR8zVzKVMT18RzMPMxsywzJ/MqszjFQfM28z/CGcbwM4AnSpjZ6NCdXnPAAAAEbRQaGgSzgCdKmPDwqNHdGPAwMQg8HT73YLSQebGAKL1bi3ufmlfPqFuyOj3QyBkgecZAl3EQMAEiwiaNr0tRflIUyXDuL083PMlLiQOqEWaYPNuQwt1gFY+JgQoLTy1JR1AEmg9HuzfmwOB8AQxfuuFH1nZxgs=",
      "lgIazwAAAaGg16Z9xEOd3AAUaXbMwsyRRcy8zPdzfFnMj1HMt8zTCTAaGBjM1cDODua2a80JxKRTZWxszgAJ13nNCr7ODua2a8PCo0d0Y8DAxCD8/dxcrtd+5u7k3ytvfI8urrleqcQVm5J09ut7Nz70QMRAiQVK4l5joyRYmUiUNrNEpB+mzzSzgA4UrCA09+VGTlg/KSNth+mUn7YWgUXxWI7MxzUIwR5lVG/EMqFwNVUKAA==",
      "lgIBzwAAAaGg16akxDebzQnG3AAUEczcGDQxQX8CzPtjc8yGzK7MhjfMo8y2McyGU6RTZWxszgWdwTEBwMPCo0d0Y8DAxCCAECpPtw2y2BKFTmk42xJ6nwJvDTS6G2WpAqiBxY1R8sRAySF+UBJ5mN0/yT0hd3H9WUF1E7SemJNbnMWo12Xd2YI2N+K4UwAxYmBh1KXpnAcS8rSMt3gA1lazlqo+MTXODQ==",
    ],
  },
];

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
