import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { chainIdFromString, pubkeyToOwner } from "./crypto.js";
import {
  decodeInsuranceExitPrefix,
  type InsuranceExitPrefixSelection,
} from "./insurance-exit-prefix.js";
import { ExchangeClient } from "./client.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const chain = chainIdFromString("insurance-prefix-test-1");
const agent = new Uint8Array(32).fill(7);
const selection: InsuranceExitPrefixSelection = {
  pool: 0,
  agentPubkey: "07".repeat(32),
  market: 1,
  side: "Sell",
  quantity: 4n,
  limitPrice: 951n,
  maxTakerFeeTenthBps: 10,
  protectedCash: 20n,
  minMmBuffer: 0n,
};
const owner = "f87da77f118cfaead95a77acb4b79ae9b765e425"
  .match(/../g)!
  .map((x) => parseInt(x, 16));
function raw(): unknown[] {
  return [
    2,
    Array.from(chain),
    50n,
    1000n,
    0,
    owner,
    Array.from(agent),
    Array.from(pubkeyToOwner(agent)),
    1,
    "Sell",
    4n,
    951n,
    10,
    20n,
    0n,
    1000n,
    1n,
    2n,
    3n,
    4n,
    5n,
    965n,
    "100",
    "90",
    true,
    [
      [
        1,
        1000n,
        999n,
        "OracleOnly",
        [1, 50n, null, false, "Legacy", null, null, null, null],
      ],
    ],
  ];
}
function envelope(value = raw()) {
  return {
    data: Buffer.from(encode(value, { useBigInt64: true })).toString("base64"),
    witness: {
      version: 1,
      nodeId: "ab".repeat(20),
      height: "50",
      finalizedBlockTimeMs: "1000",
      appHash: "cd".repeat(32),
    },
  };
}
describe("insurance exit prefix", () => {
  it("decodes the canonical native current-dev query vector", () => {
    // Regenerate with rmp_serde::to_vec(&empty) in exchange's
    // current_maker_funding_is_reserved_once_and_cannot_disappear_from_the_bound.
    // Source: exchange #1250, 6cb243eebb6c7da7c7beaa9de9ce46fd256ae2e5.
    const wire =
      "dc001a02dc0020cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca7cca705cf0000019dc95fec0000dc0014ccf87dcca77f11cc8cccfacceaccd95a77ccacccb4ccb7cc9acce9ccb765cce425dc0020ccc853ccad0f0cccd2ccb619ccaecca92ccceeccc4ccfd56cca24d64cc99ccd5cc84ccce79257e45cccfccd813cc9b60cca7dc0014cccbccb76bccc54e05ccfa0ecc9acc91656eccdd1dccc97bcc86ccae611201a453656c6c04cd03b7cd13881400cd27100700002b00cd26caa439393130a439383530c3919501cd03e801aa4f7261636c654f6e6c79990105c0c2a64c6567616379c0c0c0c0";
    const result = decodeInsuranceExitPrefix(
      {
        data: Buffer.from(wire, "hex").toString("base64"),
        witness: {
          version: 1,
          nodeId: "ab".repeat(20),
          height: "5",
          finalizedBlockTimeMs: "1777200000000",
          appHash: "cd".repeat(32),
        },
      },
      new Uint8Array(32).fill(0xa7),
      {
        ...selection,
        agentPubkey:
          "c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7",
        maxTakerFeeTenthBps: 5000,
      },
    );
    expect(result.syntheticCash).toBe(9930n);
    expect(result.syntheticMmBuffer).toBe(9910n);
    expect(result.marks[0].markSourceMode).toBe("OracleOnly");
  });
  it("decodes exact selectors, arithmetic, oracle references and witness", () => {
    const result = decodeInsuranceExitPrefix(envelope(), chain, selection);
    expect(result.syntheticCash).toBe(965n);
    expect(result.makerFundingHaircut).toBe(3n);
    expect(result.marks[0].oraclePermissions.finalizedHeight).toBe(50n);
    expect(result.meetsBound).toBe(true);
  });
  it("does not turn a failed bound into an exception or success", () => {
    const value = raw();
    value[22] = "-1";
    value[24] = false;
    expect(
      decodeInsuranceExitPrefix(envelope(value), chain, selection).meetsBound,
    ).toBe(false);
  });
  it("rejects changed selectors, corrupt accounting and incomplete reference evidence", () => {
    for (const [index, replacement] of [
      [0, 1],
      [2, 0],
      [4, 1],
      [8, 2],
      [9, "Buy"],
      [10, 3],
      [11, 952],
      [12, 11],
      [13, 21],
      [14, 1],
      [18, 4],
      [21, 966],
      [22, "-0"],
      [24, false],
      [25, []],
    ] as [number, unknown][]) {
      const value = raw();
      value[index] = replacement;
      expect(() =>
        decodeInsuranceExitPrefix(envelope(value), chain, selection),
      ).toThrow();
    }
    const value = raw();
    (value[25] as unknown[][])[0][2] = 1001n;
    expect(() =>
      decodeInsuranceExitPrefix(envelope(value), chain, selection),
    ).toThrow();
    expect(() =>
      decodeInsuranceExitPrefix(
        { ...envelope(), witness: { ...envelope().witness, height: "51" } },
        chain,
        selection,
      ),
    ).toThrow();
  });
  it("uses only the bounded gateway read and a pinned chain", async () => {
    const urls: string[] = [];
    const transport: ExchangeHttpTransport = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(envelope()));
    };
    const client = new ExchangeClient({
      chainId: "insurance-prefix-test-1",
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    expect((await client.queryInsuranceExitPrefix(selection)).meetsBound).toBe(
      true,
    );
    expect(urls).toEqual([
      "https://gateway.example/v1/insurance/exit-prefix?pool=0&agent=" +
        selection.agentPubkey +
        "&market=1&side=sell&quantity=4&limit=951&fee=10&protected=20&buffer=0",
    ]);
    await expect(
      client.queryInsuranceExitPrefix({ ...selection, quantity: 0n }),
    ).rejects.toThrow();
    expect(urls).toHaveLength(1);
  });
});
