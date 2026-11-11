// Reads whose response type is in proof-wire decode in the Rust core. Each
// vector is `rmp_serde::to_vec` of the wire type, as the engine serves it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { decodeSigningMessage, encodePayloadBytes } from "./codec.js";
import { signingMessage } from "./crypto.js";
import { decodeAdminAction } from "./governance-query.js";
import { ActionType, Outcome } from "./types.js";

/** One 24-field `MarketConfig` row from the Rust-produced snapshot vector. */
const MARKET =
  "dc001801cd03e8cd01f40502ce0036ee8064a4506572700000c200cd7530906401c000aa4f7261636c654f6e6c79000005a3425443cfffffffffffffffff";
/** Event 700 as exchange-core `query_event` serves it (one binary book). */
const EVENT =
  "9acd02bcce00011170b757696c6c2074686520466564206375742072617465733fcf0000019df90ef400cd03e8a754726164696e67cf0000019dc95fec0000c090";
/** `proof_wire::query::AccountInfo` with one position and every trailer. */
const ACCOUNT =
  "9acf0020000000000001919edc0014ccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccab07a453656c6ccf0000000f8a9c2b8003fbd1fc18cd07d0cd0fa0d1fc18000c00cf0020000000000001d0d6cd07d0cd0fa0009192cd02bca24e6ffdcfffffffffffffffff05";

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const originalFetch = globalThis.fetch;

function serve(hex: string): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: b64(hex) }), { status: 200 }),
  ) as unknown as typeof fetch;
}

const client = () =>
  new ExchangeClient({ gatewayUrl: "http://g", chainId: "c" });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("queryMarkets", () => {
  it("decodes the wire MarketConfig list", async () => {
    serve(`91${MARKET}`);
    expect(await client().queryMarkets()).toEqual([
      {
        market: 1,
        imBps: 1000,
        mmBps: 500,
        takerFeeBps: 5,
        makerFeeBps: 2,
        fundingIntervalMs: 3_600_000n,
        maxFundingRateBps: 100,
        kind: "Perp",
        maxPositionSize: 0n,
        defaultTtlMs: 0n,
        netDeltaMargin: false,
        poolId: 0,
        markPriceMaxOracleAgeMs: 30_000n,
        feeTiers: [],
        tickSize: 100n,
        lotSize: 1n,
        primaryOracleSigner: undefined,
        oracleStalenessMs: 0n,
        markSourceMode: "OracleOnly",
        maxMarkSpreadBps: 0,
        cexCompositeStalenessMs: 0n,
        szDecimals: 5,
        ticker: "BTC",
        maxOpenInterest: 18_446_744_073_709_551_615n,
      },
    ]);
  });

  it("ignores a field a later engine appends to the row", async () => {
    serve(`91${MARKET.replace(/^dc0018/, "dc0019")}63`);
    const [later] = await client().queryMarkets();
    serve(`91${MARKET}`);
    expect(later).toEqual((await client().queryMarkets())[0]);
  });

  it("refuses a row with a float where the wire has an integer", async () => {
    // fundingIntervalMs (ce0036ee80) as float64 3600000.0
    serve(`91${MARKET.replace("ce0036ee80", "cb414b774000000000")}`);
    await expect(client().queryMarkets()).rejects.toThrow(/Markets decode/);
  });
});

describe("queryEvents / queryEvent", () => {
  const event = {
    eventId: 700,
    ebyMarket: 70000,
    question: "Will the Fed cut rates?",
    settlementMs: 1_778_000_000_000n,
    resolutionWindowMs: 1000n,
    status: { kind: "Trading" },
    createdMs: 1_777_200_000_000n,
    resolvedMs: 0n,
    attachedConditionals: [],
  };

  it("decodes the one-book EventInfo", async () => {
    serve(`91${EVENT}`);
    expect(await client().queryEvents()).toEqual([event]);
    serve(EVENT);
    const one = await client().queryEvent(700);
    expect(one).toEqual(event);
    expect(one && "ebnMarket" in one).toBe(false);
  });

  it("decodes a resolved event's outcome", async () => {
    // status "Trading" -> {"Resolved": "Yes"}
    serve(EVENT.replace("a754726164696e67", "81a85265736f6c766564a3596573"));
    expect((await client().queryEvent(700))?.status).toEqual({
      kind: "Resolved",
      outcome: Outcome.Yes,
    });
  });

  it("reads nil as no event", async () => {
    serve("c0");
    expect(await client().queryEvent(700)).toBeNull();
  });

  it("refuses the two-book record", async () => {
    serve(EVENT.replace(/^9acd02bcce00011170/, "9bcd02bcce00011170ce00011171"));
    await expect(client().queryEvent(700)).rejects.toThrow(/Event decode/);
  });
});

describe("queryAccount", () => {
  it("decodes the wire AccountInfo losslessly", async () => {
    serve(ACCOUNT);
    expect(await client().queryAccount("ab".repeat(20))).toEqual({
      balance: 9_007_199_254_740_993n,
      positions: [
        {
          owner: new Uint8Array(20).fill(0xab),
          market: 7,
          side: "Sell",
          entryPrice: 66_750_000_000n,
          size: 3n,
          lastFundingIndex: -5n,
          upnlNow: -1_000n,
          mmNow: 2_000n,
          imNow: 4_000n,
          pnlIfFires: -1_000n,
          pnlIfDies: 0n,
          fundingSince: 12n,
          adlScore: 0n,
          positionEpoch: 9_007_199_254_740_993n,
        },
      ],
      equity: -42n,
      totalMm: 2_000n,
      totalIm: 4_000n,
      marginRatioBps: 0n,
      bindingScenario: [{ eventId: 700, branch: "No" }],
      feesAccrued: -3n,
      volume30dMicroUsdc: 18_446_744_073_709_551_615n,
    });
  });

  it("ignores a field a later engine appends to the record", async () => {
    serve(`${ACCOUNT.replace(/^9a/, "9b")}63`);
    const later = await client().queryAccount("ab".repeat(20));
    serve(ACCOUNT);
    expect(later).toEqual(await client().queryAccount("ab".repeat(20)));
  });

  it("refuses trailing bytes", async () => {
    serve(`${ACCOUNT}00`);
    await expect(client().queryAccount("ab".repeat(20))).rejects.toThrow(
      /Account decode/,
    );
  });
});

describe("SetOperatorReceiptRegistry operatorKeys + operatorOwners", () => {
  const value = {
    deploymentId: new Uint8Array(32).fill(0xcd),
    epoch: 1n,
    threshold: 1,
    operatorKeys: [new Uint8Array(32).fill(0xb8)],
    operatorOwners: [new Uint8Array(20).fill(0x77)],
  };

  it("decodes on the proposal read", () => {
    const keys = Array.from(value.operatorKeys[0]);
    const owners = Array.from(value.operatorOwners[0]);
    expect(
      decodeAdminAction({
        SetOperatorReceiptRegistry: [
          Array.from(value.deploymentId),
          1,
          1,
          [keys],
          [owners],
        ],
      }),
    ).toEqual({ kind: "SetOperatorReceiptRegistry", value });
  });

  it("refuses an unreachable threshold on read and encode", () => {
    const keys = Array.from(value.operatorKeys[0]);
    const owners = Array.from(value.operatorOwners[0]);
    expect(() =>
      decodeAdminAction({
        SetOperatorReceiptRegistry: [
          Array.from(value.deploymentId),
          1,
          0,
          [keys],
          [owners],
        ],
      }),
    ).toThrow(/threshold 0 is outside 1..=1/);
    expect(() =>
      encodePayloadBytes({
        type: "ProposeAdminAction",
        data: {
          proposer: new Uint8Array(20),
          registryVersion: 2n,
          action: {
            kind: "SetOperatorReceiptRegistry",
            value: { ...value, threshold: 2 },
          },
        },
      }),
    ).toThrow(/threshold 2 is outside 1..=1/);
  });

  it("round-trips through decodeSigningMessage", () => {
    const payload = encodePayloadBytes({
      type: "ProposeAdminAction",
      data: {
        proposer: new Uint8Array(20),
        registryVersion: 2n,
        action: { kind: "SetOperatorReceiptRegistry", value },
      },
    });
    const decoded = decodeSigningMessage(
      signingMessage(
        new Uint8Array(32),
        ActionType.ProposeAdminAction,
        0n,
        payload,
      ),
    );
    expect(decoded.decodeError).toBeNull();
    expect(decoded.action?.data).toMatchObject({
      action: { kind: "SetOperatorReceiptRegistry", value },
    });
  });
});

// ---------------------------------------------------------------------------
// Wire-12 bridge custody reads (`/v2/bridge/*`). Each fixture is
// `query_v2::encode` (rmp-serde named maps) of the pinned wire view,
// generated from the Rust core.
// ---------------------------------------------------------------------------

/** `BridgeStatus`: halted, both payout addresses set, epoch 3, 2-of-2. */
const BRIDGE_STATUS =
  "86a668616c746564c3af7061796f75745f6d756c7469736967c420a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2aa6f70735f77616c6c6574c420b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3ae72656769737472795f65706f636803b272656769737472795f7468726573686f6c6402ae6f70657261746f725f636f756e7402";
/** `BridgeStatus`: nothing governed yet — every `Option` decodes absent. */
const BRIDGE_STATUS_MINIMAL =
  "86a668616c746564c2af7061796f75745f6d756c7469736967c0aa6f70735f77616c6c6574c0ae72656769737472795f65706f6368c0b272656769737472795f7468726573686f6c64c0ae6f70657261746f725f636f756e74c0";
/** `OperatorRegistry` at epoch 3: two members, the second stored pre-12
 *  (no owner). */
const BRIDGE_REGISTRY =
  "84ad6465706c6f796d656e745f6964c420a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a565706f636803a97468726573686f6c6402a76d656d626572739282a36b6579c4201111111111111111111111111111111111111111111111111111111111111111a56f776e6572c414555555555555555555555555555555555555555582a36b6579c4202222222222222222222222222222222222222222222222222222222222222222a56f776e6572c0";
/** One `PendingWithdrawal` (id 103, pending) with lease, payout report and
 *  two Paid votes; `next_cursor` 104. */
const PENDING_WITHDRAWALS =
  "82a4726f77739184aa7769746864726177616c86ad7769746864726177616c5f696467a56f776e6572c414ababababababababababababababababababababa6616d6f756e74ce004c4b40b2736f6c616e615f64657374696e6174696f6ec420cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcda6737461747573a770656e64696e67ae726571756573745f6865696768742aa56c6561736583a6686f6c646572c4145555555555555555555555555555555555555555af61637175697265645f6865696768742bb1657870697265735f61745f686569676874cc8fae7061796f75745f7265706f7274739184a6686f6c646572c4145555555555555555555555555555555555555555a57661756c74c420a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2b87371756164735f7472616e73616374696f6e5f696e64657807ae72656769737472795f65706f636803a5766f74657382ae72656769737472795f65706f636803a5766f7465739282a5766f746572c4201111111111111111111111111111111111111111111111111111111111111111a97369676e6174757265c4407777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777782a5766f746572c4202222222222222222222222222222222222222222222222222222222222222222a97369676e6174757265c44088888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888ab6e6578745f637572736f7268";
/** The exhausted withdrawals page: no rows, `next_cursor` nil. */
const PENDING_WITHDRAWALS_EXHAUSTED =
  "82a4726f777390ab6e6578745f637572736f72c0";
/** One `PendingDeposit` (one observation, one vote, populated locator);
 *  `next_cursor` is the opaque store-key bytes deadbeef. */
const PENDING_DEPOSITS =
  "82a4726f77739184ad736f6c616e615f74785f736967c44099999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999a76c6f6361746f7282a9746f705f696e64657802ab696e6e65725f696e64657805ae72656769737472795f65706f636803ac6f62736572766174696f6e739183a56f776e6572c4146666666666666666666666666666666666666666b1616d6f756e745f6d6963726f5f75736463ce000f4240a5766f7465739182a5766f746572c4201111111111111111111111111111111111111111111111111111111111111111a97369676e6174757265c44077777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777ab6e6578745f637572736f7294ccdeccadccbeccef";
/** The exhausted deposits page. */
const PENDING_DEPOSITS_EXHAUSTED = "82a4726f777390ab6e6578745f637572736f72c0";

describe("queryBridgeStatus", () => {
  it("decodes the governance view", async () => {
    serve(BRIDGE_STATUS);
    expect(await client().queryBridgeStatus()).toEqual({
      halted: true,
      payoutMultisig: new Uint8Array(32).fill(0xa2),
      opsWallet: new Uint8Array(32).fill(0xb3),
      registryEpoch: 3n,
      registryThreshold: 2,
      operatorCount: 2,
    });
  });

  it("leaves ungoverned fields absent", async () => {
    serve(BRIDGE_STATUS_MINIMAL);
    expect(await client().queryBridgeStatus()).toEqual({
      halted: false,
      payoutMultisig: undefined,
      opsWallet: undefined,
      registryEpoch: undefined,
      registryThreshold: undefined,
      operatorCount: undefined,
    });
  });
});

describe("queryBridgeRegistry", () => {
  it("decodes the roster, tolerating a pre-12 member with no owner", async () => {
    serve(BRIDGE_REGISTRY);
    expect(await client().queryBridgeRegistry()).toEqual({
      deploymentId: new Uint8Array(32).fill(0xa1),
      epoch: 3n,
      threshold: 2,
      members: [
        {
          key: new Uint8Array(32).fill(0x11),
          owner: new Uint8Array(20).fill(0x55),
        },
        { key: new Uint8Array(32).fill(0x22), owner: undefined },
      ],
    });
  });
});

describe("queryPendingWithdrawals", () => {
  it("decodes one page with lease, payout report and votes", async () => {
    serve(PENDING_WITHDRAWALS);
    expect(await client().queryPendingWithdrawals()).toEqual({
      rows: [
        {
          withdrawal: {
            id: 103n,
            owner: new Uint8Array(20).fill(0xab),
            amount: 5_000_000n,
            solanaDestination: new Uint8Array(32).fill(0xcd),
            status: "Pending",
            requestHeight: 42n,
          },
          lease: {
            holder: new Uint8Array(20).fill(0x55),
            acquiredHeight: 43n,
            expiresAtHeight: 143n,
          },
          payoutReports: [
            {
              holder: new Uint8Array(20).fill(0x55),
              vault: new Uint8Array(32).fill(0xa2),
              squadsTransactionIndex: 7,
              registryEpoch: 3n,
            },
          ],
          votes: {
            registryEpoch: 3n,
            votes: [
              {
                voter: new Uint8Array(32).fill(0x11),
                signature: new Uint8Array(64).fill(0x77),
              },
              {
                voter: new Uint8Array(32).fill(0x22),
                signature: new Uint8Array(64).fill(0x88),
              },
            ],
          },
        },
      ],
      nextCursor: 104n,
    });
  });

  it("decodes the exhausted page", async () => {
    serve(PENDING_WITHDRAWALS_EXHAUSTED);
    expect(await client().queryPendingWithdrawals()).toEqual({
      rows: [],
      nextCursor: null,
    });
  });
});

describe("queryPendingDeposits", () => {
  it("decodes one page and surfaces the opaque cursor as hex", async () => {
    serve(PENDING_DEPOSITS);
    expect(await client().queryPendingDeposits()).toEqual({
      rows: [
        {
          solanaTxSig: new Uint8Array(64).fill(0x99),
          locator: { topIndex: 2, innerIndex: 5 },
          registryEpoch: 3n,
          observations: [
            {
              owner: new Uint8Array(20).fill(0x66),
              amountMicroUsdc: 1_000_000n,
              votes: [
                {
                  voter: new Uint8Array(32).fill(0x11),
                  signature: new Uint8Array(64).fill(0x77),
                },
              ],
            },
          ],
        },
      ],
      // The raw store-key bytes, hex-encoded exactly as the route serves
      // them — an opaque token to pass back verbatim.
      nextCursor: "deadbeef",
    });
  });

  it("decodes the exhausted page", async () => {
    serve(PENDING_DEPOSITS_EXHAUSTED);
    expect(await client().queryPendingDeposits()).toEqual({
      rows: [],
      nextCursor: null,
    });
  });
});
