import { describe, expect, it } from "vitest";
import {
  ADL_SKIP_REASONS,
  LIQUIDATION_MODES,
  LIQUIDATION_PROGRESS_OUTCOMES,
  LIQUIDATION_REFUSALS,
  decodeLiquidationEvent,
} from "./liquidation-events.js";
import type { TxEvent } from "./types.js";

// Attribute lists mirror exchange-wire's own ABCI expectations for each
// event, in the engine's write order.
const OWNER_AB = "ab".repeat(20);
const OWNER_CD = "cd".repeat(20);

function txEvent(type: string, attrs: [string, string][]): TxEvent {
  return {
    type,
    attributes: attrs.map(([key, value]) => ({ key, value })),
  };
}

const partialFee = (overrides: Record<string, string> = {}) =>
  txEvent(
    "partial_liquidation_fee",
    Object.entries({
      owner: OWNER_AB,
      market: "7",
      pool_id: "2",
      fill_id: "99",
      config_sequence: "8",
      assessed: "5",
      collected: "3",
      waived: "2",
      ...overrides,
    }),
  );

const positionLiquidated = (overrides: Record<string, string> = {}) =>
  txEvent(
    "position_liquidated",
    Object.entries({
      owner: OWNER_AB,
      market: "7",
      side: "sell",
      mode: "partial",
      size_before: "100",
      size_closed: "12",
      size_after: "88",
      penalty_collected: "9",
      penalty_waived: "3",
      equity: "-5",
      maintenance: "500",
      binding_outcome: "4:yes,9:no",
      config_sequence: "2",
      ...overrides,
    }),
  );

const liquidationFailed = (code: string, refusal: string) =>
  txEvent("liquidation_failed", [
    ["owner", OWNER_CD],
    ["code", code],
    ["refusal", refusal],
  ]);

const adlSkipped = (overrides: Record<string, string> = {}) =>
  txEvent(
    "adl_counterparty_skipped",
    Object.entries({
      owner: OWNER_AB,
      market: "7",
      pool_id: "1",
      size: "3",
      reason: "stale_oracle_dependency",
      ...overrides,
    }),
  );

describe("decodeLiquidationEvent", () => {
  it("decodes LiquidationConfigSet into the configuration it carries", () => {
    const event = txEvent("liquidation_config_set", [
      ["sequence", "2"],
      ["target_ratio_bps", "10500"],
      ["full_close_numerator", "2"],
      ["full_close_denominator", "3"],
      ["partial_penalty_bps", "100"],
      ["max_book_orders", "20"],
      ["max_committed_fills", "10"],
      ["proposal_id", "7"],
    ]);
    expect(decodeLiquidationEvent(event)).toEqual({
      type: "LiquidationConfigSet",
      sequence: 2n,
      config: {
        targetRatioBps: 10_500,
        fullCloseThreshold: { numerator: 2, denominator: 3 },
        partialPenaltyBps: 100,
        maxBookOrders: 20,
        maxCommittedFills: 10,
      },
      proposalId: 7n,
    });
  });

  it("decodes PartialLiquidationFee", () => {
    expect(decodeLiquidationEvent(partialFee())).toEqual({
      type: "PartialLiquidationFee",
      owner: OWNER_AB,
      market: 7,
      poolId: 2,
      fillId: 99n,
      configSequence: 8n,
      assessed: 5n,
      collected: 3n,
      waived: 2n,
    });
  });

  it("decodes every LiquidationProgressReported outcome", () => {
    expect(LIQUIDATION_PROGRESS_OUTCOMES).toHaveLength(14);
    for (const outcome of LIQUIDATION_PROGRESS_OUTCOMES) {
      const event = txEvent("liquidation_progress_reported", [
        ["owner", OWNER_AB],
        ["outcome", outcome],
        ["config_sequence", "4"],
      ]);
      expect(decodeLiquidationEvent(event)).toEqual({
        type: "LiquidationProgressReported",
        owner: OWNER_AB,
        outcome,
        configSequence: 4n,
      });
    }
  });

  it("decodes PositionLiquidated with its binding outcome", () => {
    expect(decodeLiquidationEvent(positionLiquidated())).toEqual({
      type: "PositionLiquidated",
      owner: OWNER_AB,
      market: 7,
      side: "sell",
      mode: "partial",
      sizeBefore: 100n,
      sizeClosed: 12n,
      sizeAfter: 88n,
      penaltyCollected: 9n,
      penaltyWaived: 3n,
      equity: -5n,
      maintenance: 500n,
      bindingOutcome: [
        { eventId: 4, branch: "Yes" },
        { eventId: 9, branch: "No" },
      ],
      configSequence: 2n,
    });
  });

  it("decodes every PositionLiquidated mode and an empty binding outcome", () => {
    expect(LIQUIDATION_MODES).toEqual(["partial", "full", "insolvent"]);
    for (const mode of LIQUIDATION_MODES) {
      expect(
        decodeLiquidationEvent(
          positionLiquidated({
            mode,
            side: "buy",
            size_closed: "100",
            size_after: "0",
            binding_outcome: "",
            equity: "0",
          }),
        ),
      ).toMatchObject({
        mode,
        side: "buy",
        sizeAfter: 0n,
        bindingOutcome: [],
        equity: 0n,
      });
    }
  });

  it("keeps the signed 64-bit equity range exact", () => {
    for (const equity of ["-9223372036854775808", "9223372036854775807"]) {
      expect(
        decodeLiquidationEvent(positionLiquidated({ equity })),
      ).toMatchObject({ equity: BigInt(equity) });
    }
  });

  it("decodes a position closed past its size", () => {
    expect(
      decodeLiquidationEvent(
        positionLiquidated({ size_closed: "120", size_after: "0" }),
      ),
    ).toMatchObject({ sizeClosed: 120n, sizeAfter: 0n });
  });

  it("decodes LiquidationFailed with every refusal and with none", () => {
    expect(LIQUIDATION_REFUSALS).toHaveLength(3);
    for (const refusal of LIQUIDATION_REFUSALS) {
      expect(decodeLiquidationEvent(liquidationFailed("111", refusal))).toEqual(
        {
          type: "LiquidationFailed",
          owner: OWNER_CD,
          code: 111,
          refusal,
        },
      );
    }
    // An engine error rather than a refusal: its own code, an empty refusal.
    expect(decodeLiquidationEvent(liquidationFailed("22", ""))).toEqual({
      type: "LiquidationFailed",
      owner: OWNER_CD,
      code: 22,
      refusal: null,
    });
  });

  it("decodes AdlCounterpartySkipped", () => {
    expect(ADL_SKIP_REASONS).toEqual(["stale_oracle_dependency"]);
    expect(decodeLiquidationEvent(adlSkipped())).toEqual({
      type: "AdlCounterpartySkipped",
      owner: OWNER_AB,
      market: 7,
      poolId: 1,
      size: 3n,
      reason: "stale_oracle_dependency",
    });
  });

  it("passes through values a later engine may add", () => {
    expect(
      decodeLiquidationEvent(
        txEvent("liquidation_progress_reported", [
          ["owner", OWNER_AB],
          ["outcome", "partly_done"],
          ["config_sequence", "4"],
        ]),
      ),
    ).toMatchObject({ outcome: "partly_done" });
    expect(
      decodeLiquidationEvent(
        positionLiquidated({
          mode: "partly",
          size_after: "87",
          binding_outcome: "9:no,4:yes",
        }),
      ),
    ).toMatchObject({
      mode: "partly",
      sizeAfter: 87n,
      bindingOutcome: [
        { eventId: 9, branch: "No" },
        { eventId: 4, branch: "Yes" },
      ],
    });
    for (const [code, refusal] of [
      ["111", "busy"],
      ["22", "invalid_maker"],
      ["111", ""],
      ["0", ""],
    ] as const) {
      expect(
        decodeLiquidationEvent(liquidationFailed(code, refusal)),
      ).toMatchObject({
        code: Number(code),
        refusal: refusal === "" ? null : refusal,
      });
    }
    expect(
      decodeLiquidationEvent(adlSkipped({ reason: "stale" })),
    ).toMatchObject({ reason: "stale" });
  });

  it("keeps u64 amounts above 2^53 exact", () => {
    const max = "18446744073709551615";
    const decoded = decodeLiquidationEvent(
      partialFee({ assessed: max, collected: max, waived: "0", fill_id: max }),
    );
    expect(decoded).toMatchObject({
      fillId: 2n ** 64n - 1n,
      assessed: 2n ** 64n - 1n,
    });
  });

  it("accepts attributes as a plain object and ignores chain coordinates", () => {
    const decoded = decodeLiquidationEvent({
      type: "liquidation_progress_reported",
      attributes: {
        owner: OWNER_AB,
        outcome: "deferred",
        config_sequence: "4",
        block_height: "100",
        execution_ordinal: "1",
        event_ordinal: "3",
        event_key: "100:1:3",
      },
    });
    expect(decoded).toMatchObject({ outcome: "deferred" });
  });

  it("returns null for any other event type", () => {
    expect(decodeLiquidationEvent(txEvent("trade_executed", []))).toBeNull();
    expect(decodeLiquidationEvent(txEvent("toString", []))).toBeNull();
    // proof-wire 7.0.0 removed the full-close penalty receipt.
    expect(
      decodeLiquidationEvent(txEvent("full_liquidation_fee", [])),
    ).toBeNull();
  });

  it.each<[string, TxEvent, RegExp]>([
    [
      "an assessment that is not collected + waived",
      partialFee({ waived: "1" }),
      /assessed is not collected \+ waived/,
    ],
    [
      "a missing attribute",
      txEvent("liquidation_progress_reported", [["owner", OWNER_CD]]),
      /outcome is missing/,
    ],
    [
      "a negative amount",
      partialFee({ collected: "-3" }),
      /collected is not a decimal unsigned integer/,
    ],
    [
      "a leading zero",
      partialFee({ fill_id: "099" }),
      /fill_id is not a decimal unsigned integer/,
    ],
    [
      "a u64 overflow",
      partialFee({ config_sequence: "18446744073709551616" }),
      /config_sequence exceeds/,
    ],
    ["a pool id above u8", partialFee({ pool_id: "256" }), /pool_id exceeds/],
    [
      "an uppercase owner",
      partialFee({ owner: OWNER_AB.toUpperCase() }),
      /owner is not a 20-byte lowercase hex address/,
    ],
    [
      "a duplicated attribute",
      txEvent("liquidation_progress_reported", [
        ["owner", OWNER_AB],
        ["owner", OWNER_CD],
        ["outcome", "failed"],
        ["config_sequence", "4"],
      ]),
      /owner is duplicated/,
    ],
    [
      "a configuration the wire refuses",
      txEvent("liquidation_config_set", [
        ["sequence", "2"],
        ["target_ratio_bps", "10000"],
        ["full_close_numerator", "2"],
        ["full_close_denominator", "3"],
        ["partial_penalty_bps", "100"],
        ["max_book_orders", "20"],
        ["max_committed_fills", "10"],
        ["proposal_id", "7"],
      ]),
      /config is invalid: targetRatioBps/,
    ],
    [
      "a capitalised side",
      positionLiquidated({ side: "Sell" }),
      /side has unknown value "Sell"/,
    ],
    [
      "an equity with a leading zero",
      positionLiquidated({ equity: "-05" }),
      /equity is not a decimal signed integer/,
    ],
    [
      "a negative zero equity",
      positionLiquidated({ equity: "-0" }),
      /equity is not a decimal signed integer/,
    ],
    [
      "an equity below the signed 64-bit range",
      positionLiquidated({ equity: "-9223372036854775809" }),
      /equity is outside the signed 64-bit range/,
    ],
    [
      "a binding outcome with a void branch",
      positionLiquidated({ binding_outcome: "4:void" }),
      /binding_outcome has malformed entry "4:void"/,
    ],
    [
      "a binding outcome with a trailing comma",
      positionLiquidated({ binding_outcome: "4:yes," }),
      /binding_outcome has malformed entry ""/,
    ],
    [
      "a binding outcome event id above u32",
      positionLiquidated({ binding_outcome: "4294967296:yes" }),
      /binding_outcome event id exceeds/,
    ],
    [
      "conflicting branches for one event",
      positionLiquidated({ binding_outcome: "4:yes,4:no" }),
      /binding_outcome event id 4 is repeated/,
    ],
    [
      "a repeated event",
      positionLiquidated({ binding_outcome: "4:yes,4:yes" }),
      /binding_outcome event id 4 is repeated/,
    ],
    [
      "an empty liquidation mode",
      positionLiquidated({ mode: "" }),
      /mode is empty/,
    ],
    ["an empty skip reason", adlSkipped({ reason: "" }), /reason is empty/],
    [
      "a missing refusal",
      txEvent("liquidation_failed", [
        ["owner", OWNER_CD],
        ["code", "111"],
      ]),
      /refusal is missing/,
    ],
    [
      "a skipped pool id above u8",
      adlSkipped({ pool_id: "256" }),
      /pool_id exceeds/,
    ],
  ])("refuses %s", (_name, event, message) => {
    expect(() => decodeLiquidationEvent(event)).toThrow(message);
  });
});
