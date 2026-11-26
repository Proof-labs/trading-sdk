// Reads whose response type is in proof-wire decode in the Rust core. Each
// vector is `rmp_serde::to_vec` of the wire type, as the engine serves it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
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

describe("SetOperatorReceiptRegistry operatorKeys", () => {
  const value = {
    deploymentId: new Uint8Array(32).fill(0xcd),
    epoch: 1n,
    threshold: 1,
    operatorKeys: [new Uint8Array(32).fill(0xb8)],
  };

  it("decodes on the proposal read", () => {
    const keys = Array.from(value.operatorKeys[0]);
    expect(
      decodeAdminAction({
        SetOperatorReceiptRegistry: [
          Array.from(value.deploymentId),
          1,
          1,
          [keys],
        ],
      }),
    ).toEqual({ kind: "SetOperatorReceiptRegistry", value });
  });

  it("refuses an unreachable threshold on read and encode", () => {
    const keys = Array.from(value.operatorKeys[0]);
    expect(() =>
      decodeAdminAction({
        SetOperatorReceiptRegistry: [
          Array.from(value.deploymentId),
          1,
          0,
          [keys],
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

  it("refuses a roster that names a key twice", () => {
    expect(() =>
      encodePayloadBytes({
        type: "ProposeAdminAction",
        data: {
          proposer: new Uint8Array(20),
          registryVersion: 2n,
          action: {
            kind: "SetOperatorReceiptRegistry",
            value: {
              ...value,
              operatorKeys: [value.operatorKeys[0], value.operatorKeys[0]],
            },
          },
        },
      }),
    ).toThrow(/operatorKeys\[1\] duplicates an earlier key/);
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
// Bridge custody reads (`/v2/bridge/*`), serialized from the current
// query_v2 view shapes.
const wire = (value: unknown) =>
  Buffer.from(encode(value, { useBigInt64: true })).toString("hex");
const BRIDGE_STATUS = wire("Paused");
const BRIDGE_STATUS_BACKLOG = wire("WithdrawalBacklog");
const BRIDGE_PAYOUT_CONFIG = wire({
  payout_multisig: new Uint8Array(32).fill(0xb2),
  ops_wallet: new Uint8Array(32).fill(0xb3),
});
const BRIDGE_PAYOUT_CONFIG_UNSET = wire(null);
const BRIDGE_REGISTRY = wire({
  deployment_id: new Uint8Array(32).fill(0xa1),
  epoch: 3n,
  threshold: 2,
  members: [
    { key: new Uint8Array(32).fill(0x11) },
    { key: new Uint8Array(32).fill(0x22) },
  ],
});
const WITHDRAW_VOTE_1 = {
  voter: new Uint8Array(32).fill(0x11),
  registry_epoch: 3n,
  verdict: "paid",
  vault: new Uint8Array(32).fill(0xa2),
  squads_transaction_index: 7,
  signature: new Uint8Array(64).fill(0x77),
};
const WITHDRAW_VOTE_2 = {
  ...WITHDRAW_VOTE_1,
  voter: new Uint8Array(32).fill(0x22),
  verdict: "dead",
  signature: new Uint8Array(64).fill(0x88),
};
const PENDING_WITHDRAWALS = wire({
  rows: [
    {
      withdrawal: {
        withdrawal_id: 103n,
        owner: new Uint8Array(20).fill(0xab),
        amount: 5_000_000n,
        solana_destination: new Uint8Array(32).fill(0xcd),
        status: "pending",
        request_height: 42n,
        quarantined: false,
      },
      payout: {
        recorder: new Uint8Array(32).fill(0x11),
        vault: new Uint8Array(32).fill(0xa2),
        squads_transaction_index: 7,
        registry_epoch: 3n,
        recorded_at_ms: 1_700_000_000_000n,
      },
      votes: [WITHDRAW_VOTE_1, WITHDRAW_VOTE_2],
    },
  ],
  next_cursor: 104n,
});
const PENDING_WITHDRAWALS_EXHAUSTED = wire({ rows: [], next_cursor: null });
// An engine before the quarantine flag omits it; it reads as not quarantined.
const PENDING_WITHDRAWALS_QUARANTINED = wire({
  rows: [
    {
      withdrawal: {
        withdrawal_id: 9n,
        owner: new Uint8Array(20).fill(0xab),
        amount: 1n,
        solana_destination: new Uint8Array(32).fill(0xcd),
        status: "pending",
        request_height: 1n,
        quarantined: true,
      },
      payout: null,
      votes: [],
    },
  ],
  next_cursor: null,
});
const PENDING_DEPOSITS = wire({
  rows: [
    {
      solana_tx_sig: new Uint8Array(64).fill(0x99),
      locator: { top_index: 2, inner_index: 5 },
      votes: [
        {
          voter: new Uint8Array(32).fill(0x11),
          registry_epoch: 3n,
          owner: new Uint8Array(20).fill(0x66),
          amount_micro_usdc: 1_000_000n,
          signature: new Uint8Array(64).fill(0x77),
        },
      ],
    },
  ],
  next_cursor: {
    solana_tx_sig: new Uint8Array(64).fill(0x99),
    locator: { top_index: 2, inner_index: null },
  },
});
const PENDING_DEPOSITS_EXHAUSTED = wire({ rows: [], next_cursor: null });

describe("queryBridgeStatus", () => {
  it("decodes the paused bridge", async () => {
    serve(BRIDGE_STATUS);
    expect(await client().queryBridgeStatus()).toBe("Paused");
  });

  it("decodes the backlog alert", async () => {
    serve(BRIDGE_STATUS_BACKLOG);
    expect(await client().queryBridgeStatus()).toBe("WithdrawalBacklog");
  });
});

describe("queryBridgePayoutConfig", () => {
  it("decodes the governed vault and rent wallet", async () => {
    serve(BRIDGE_PAYOUT_CONFIG);
    expect(await client().queryBridgePayoutConfig()).toEqual({
      payoutMultisig: new Uint8Array(32).fill(0xb2),
      opsWallet: new Uint8Array(32).fill(0xb3),
    });
  });

  it("reads null while the quorum has not set one", async () => {
    serve(BRIDGE_PAYOUT_CONFIG_UNSET);
    expect(await client().queryBridgePayoutConfig()).toBeNull();
  });
});

describe("queryBridgeRegistry", () => {
  it("decodes the roster of operator keys", async () => {
    serve(BRIDGE_REGISTRY);
    expect(await client().queryBridgeRegistry()).toEqual({
      deploymentId: new Uint8Array(32).fill(0xa1),
      epoch: 3n,
      threshold: 2,
      members: [
        { key: new Uint8Array(32).fill(0x11) },
        { key: new Uint8Array(32).fill(0x22) },
      ],
    });
  });
});

describe("queryPendingWithdrawals", () => {
  it("decodes one page with the recorded payout and both verdicts", async () => {
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
            quarantined: false,
          },
          payout: {
            recorder: new Uint8Array(32).fill(0x11),
            vault: new Uint8Array(32).fill(0xa2),
            squadsTransactionIndex: 7,
            registryEpoch: 3n,
            recordedAtMs: 1_700_000_000_000n,
          },
          votes: [
            {
              voter: new Uint8Array(32).fill(0x11),
              signature: new Uint8Array(64).fill(0x77),
              registryEpoch: 3n,
              verdict: "Paid",
              vault: new Uint8Array(32).fill(0xa2),
              squadsTransactionIndex: 7,
            },
            {
              voter: new Uint8Array(32).fill(0x22),
              signature: new Uint8Array(64).fill(0x88),
              registryEpoch: 3n,
              verdict: "Dead",
              vault: new Uint8Array(32).fill(0xa2),
              squadsTransactionIndex: 7,
            },
          ],
        },
      ],
      nextCursor: 104n,
    });
  });

  it("surfaces a quarantined withdrawal", async () => {
    serve(PENDING_WITHDRAWALS_QUARANTINED);
    const page = await client().queryPendingWithdrawals();
    expect(page.rows[0].withdrawal.quarantined).toBe(true);
    expect(page.rows[0].payout).toBeUndefined();
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
  it("decodes one page and returns the cursor in the route's form", async () => {
    serve(PENDING_DEPOSITS);
    expect(await client().queryPendingDeposits()).toEqual({
      rows: [
        {
          solanaTxSig: new Uint8Array(64).fill(0x99),
          locator: { topIndex: 2, innerIndex: 5 },
          votes: [
            {
              voter: new Uint8Array(32).fill(0x11),
              registryEpoch: 3n,
              owner: new Uint8Array(20).fill(0x66),
              amountMicroUsdc: 1_000_000n,
              signature: new Uint8Array(64).fill(0x77),
            },
          ],
        },
      ],
      // The last scanned identity: the transfer signature, then the top
      // index (0x0002) and an absent inner index (0xFFFF), big-endian.
      nextCursor: "99".repeat(64) + "0002ffff",
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
