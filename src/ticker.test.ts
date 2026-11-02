import { describe, expect, it } from "vitest";
import {
  ExchangeClient,
  InvalidTickerError,
  MAX_TICKER_LEN,
  adminProposalContentHash,
  checkTicker,
  decodeTx,
  encodePayloadBytes,
  encodeSignedTx,
  signAndEncode,
  tickerRefusalMessage,
  validateTicker,
  UNBOUND_CHAIN_ID,
  type Action,
  type AdminAction,
  type CreateMarket,
  type TickerRefusal,
} from "./index.js";

describe("validateTicker: the engine's ticker rule", () => {
  it.each([
    "A",
    "BTC",
    "TEST2",
    "BTC-1-CPY",
    "EVT-1-EBY",
    "OI-GW-PROBE",
    "X".repeat(24),
  ])("accepts %j", (ticker) => {
    expect(checkTicker(ticker)).toBeNull();
    expect(() => validateTicker(ticker)).not.toThrow();
  });

  const refused: [string, TickerRefusal, string][] = [
    ["", { kind: "Empty" }, "ticker is empty"],
    [
      "X".repeat(25),
      { kind: "TooLong", len: 25 },
      "ticker is 25 bytes, over the 24-byte limit",
    ],
    [
      "test3",
      { kind: "BadStart", char: "t" },
      "ticker must start with a capital letter A-Z, not 't'",
    ],
    [
      "1BTC",
      { kind: "BadStart", char: "1" },
      "ticker must start with a capital letter A-Z, not '1'",
    ],
    [
      "-BTC",
      { kind: "BadStart", char: "-" },
      "ticker must start with a capital letter A-Z, not '-'",
    ],
    [
      "TEST3.",
      { kind: "BadChar", char: ".", index: 5 },
      "ticker may hold only A-Z, 0-9 and '-', found '.' at character 5",
    ],
    [
      "TEST 3",
      { kind: "BadChar", char: " ", index: 4 },
      "ticker may hold only A-Z, 0-9 and '-', found ' ' at character 4",
    ],
    [
      "Btc",
      { kind: "BadChar", char: "t", index: 1 },
      "ticker may hold only A-Z, 0-9 and '-', found 't' at character 1",
    ],
    [
      "BTCÉ",
      { kind: "BadChar", char: "É", index: 3 },
      "ticker may hold only A-Z, 0-9 and '-', found 'É' at character 3",
    ],
  ];

  it.each(refused)("refuses %j", (ticker, reason, message) => {
    expect(checkTicker(ticker)).toEqual(reason);
    let thrown: unknown;
    try {
      validateTicker(ticker);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvalidTickerError);
    const err = thrown as InvalidTickerError;
    expect(err.message).toBe(message);
    expect(err.reason).toEqual(reason);
    expect(err.ticker).toBe(ticker);
  });

  it("counts the limit in UTF-8 bytes, and checks length first", () => {
    expect(MAX_TICKER_LEN).toBe(24);
    // 13 characters but 25 bytes: refused for length before the bad character.
    expect(checkTicker("A" + "É".repeat(12))).toEqual({
      kind: "TooLong",
      len: 25,
    });
    // 12 characters, 23 bytes: within the limit, so the character refuses it.
    expect(checkTicker("A" + "É".repeat(11))).toEqual({
      kind: "BadChar",
      char: "É",
      index: 1,
    });
  });
});

const SIGNER = new Uint8Array(20).fill(0xff);
const ZERO_SIGNER = new Uint8Array(20);

function market(ticker: string): CreateMarket {
  return {
    market: 42,
    imBps: 1000,
    mmBps: 500,
    takerFeeBps: 5,
    makerFeeBps: 2,
    signer: SIGNER,
    fundingIntervalMs: 60000n,
    maxFundingRateBps: 100,
    poolId: 0,
    szDecimals: 0,
    ticker,
  };
}

const TYPO = "TEST3.";
const TYPO_MESSAGE =
  "ticker may hold only A-Z, 0-9 and '-', found '.' at character 5";

function propose(action: AdminAction): Action {
  return {
    type: "ProposeAdminAction",
    data: {
      proposer: new Uint8Array(20).fill(0xa1),
      registryVersion: 1n,
      action,
    },
  };
}

function approve(action: AdminAction): Action {
  return {
    type: "ApproveAdminAction",
    data: {
      approver: new Uint8Array(20).fill(0xa2),
      proposalId: 7n,
      registryVersion: 1n,
      threshold: 2,
      proposer: new Uint8Array(20).fill(0xa1),
      createdHeight: 1n,
      createdMs: 1n,
      expiryMs: 2n,
      action,
      contentHash: new Uint8Array(32),
    },
  };
}

const single = (ticker: string): AdminAction => ({
  kind: "CreateMarket",
  value: { ...market(ticker), signer: ZERO_SIGNER },
});

const batch = (ticker: string): AdminAction => ({
  kind: "Batch",
  value: [
    { kind: "CreateMarket", value: { ...market("BTC"), signer: ZERO_SIGNER } },
    {
      kind: "CreateMarket",
      value: { ...market(ticker), market: 43, signer: ZERO_SIGNER },
    },
  ],
});

const shapes: [string, (ticker: string) => Action][] = [
  ["direct CreateMarket", (t) => ({ type: "CreateMarket", data: market(t) })],
  ["proposed CreateMarket", (t) => propose(single(t))],
  ["proposed Batch item", (t) => propose(batch(t))],
  ["approved CreateMarket", (t) => approve(single(t))],
  ["approved Batch item", (t) => approve(batch(t))],
];

describe("every encode path refuses a bad ticker", () => {
  const key = new Uint8Array(32).fill(7);

  describe.each(shapes)("%s", (_name, build) => {
    it("encodePayloadBytes refuses TEST3.", () => {
      expect(() => encodePayloadBytes(build(TYPO))).toThrow(
        new InvalidTickerError(TYPO, { kind: "BadChar", char: ".", index: 5 }),
      );
    });

    it("signAndEncode refuses TEST3.", () => {
      expect(() =>
        signAndEncode(UNBOUND_CHAIN_ID, build(TYPO), 1n, key),
      ).toThrow(TYPO_MESSAGE);
    });

    it("encodeSignedTx refuses TEST3.", () => {
      expect(() =>
        encodeSignedTx(build(TYPO), 1n, new Uint8Array(32), new Uint8Array(64)),
      ).toThrow(InvalidTickerError);
    });

    it("ExchangeClient.signTx refuses TEST3.", async () => {
      const client = new ExchangeClient({
        gatewayUrl: "",
        chainId: "exchange-devnet-1",
      });
      client.setPrivateKey(key);
      await expect(client.signTx(build(TYPO))).rejects.toThrow(
        InvalidTickerError,
      );
    });

    it("still encodes a good ticker", () => {
      expect(() => encodePayloadBytes(build("TEST3"))).not.toThrow();
    });
  });
});

describe("read paths never check the ticker", () => {
  it("decodes a market created before the rule", () => {
    // Bytes for a TEST3. market can no longer come from this SDK, so build them
    // from a good ticker of the same length and patch the one byte.
    const tx = signAndEncode(
      UNBOUND_CHAIN_ID,
      { type: "CreateMarket", data: market("TEST3X") },
      1n,
      new Uint8Array(32).fill(7),
    );
    const at = indexOf(tx, new TextEncoder().encode("TEST3X"));
    tx[at + 5] = ".".charCodeAt(0);
    const { action } = decodeTx(tx);
    if (action.type !== "CreateMarket") throw new Error("type narrowing");
    expect(action.data.ticker).toBe(TYPO);
  });

  it("recomputes the content hash of a proposal already on chain", () => {
    expect(
      adminProposalContentHash({
        chainId: UNBOUND_CHAIN_ID,
        proposalId: 7n,
        registryVersion: 1n,
        threshold: 2,
        proposer: new Uint8Array(20).fill(0xa1),
        createdHeight: 1n,
        createdMs: 1n,
        expiryMs: 2n,
        action: single(TYPO),
      }),
    ).toHaveLength(32);
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  throw new Error("needle not found");
}

describe("the refused character is quoted as the engine quotes it", () => {
  // The engine formats the character with Rust's `{:?}`.
  it.each([
    ["'A", "ticker must start with a capital letter A-Z, not '\\''"],
    [
      "A\\",
      "ticker may hold only A-Z, 0-9 and '-', found '\\\\' at character 1",
    ],
    [
      "A\t",
      "ticker may hold only A-Z, 0-9 and '-', found '\\t' at character 1",
    ],
    [
      "A​",
      "ticker may hold only A-Z, 0-9 and '-', found '\\u{200b}' at character 1",
    ],
    ['A"', "ticker may hold only A-Z, 0-9 and '-', found '\"' at character 1"],
    ["A😀", "ticker may hold only A-Z, 0-9 and '-', found '😀' at character 1"],
  ])("%j", (ticker, message) => {
    expect(() => validateTicker(ticker)).toThrow(message);
    expect(tickerRefusalMessage(checkTicker(ticker)!)).toBe(message);
  });
});
