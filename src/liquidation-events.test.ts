import { describe, expect, it } from "vitest";
import {
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

  it("decodes PositionLiquidated", () => {
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
    for (const mode of LIQUIDATION_MODES) {
      expect(
        decodeLiquidationEvent(
          positionLiquidated({ mode, binding_outcome: "" }),
        ),
      ).toMatchObject({ mode, bindingOutcome: [] });
    }
  });

  it("decodes LiquidationFailed with and without a refusal", () => {
    for (const refusal of LIQUIDATION_REFUSALS) {
      expect(
        decodeLiquidationEvent(
          txEvent("liquidation_failed", [
            ["owner", OWNER_CD],
            ["code", "111"],
            ["refusal", refusal],
          ]),
        ),
      ).toEqual({
        type: "LiquidationFailed",
        owner: OWNER_CD,
        code: 111,
        refusal,
      });
    }
    expect(
      decodeLiquidationEvent(
        txEvent("liquidation_failed", [
          ["owner", OWNER_CD],
          ["code", "37"],
          ["refusal", ""],
        ]),
      ),
    ).toMatchObject({ code: 37, refusal: null });
  });

  it("decodes AdlCounterpartySkipped", () => {
    expect(
      decodeLiquidationEvent(
        txEvent("adl_counterparty_skipped", [
          ["owner", OWNER_AB],
          ["market", "7"],
          ["pool_id", "1"],
          ["size", "3"],
          ["reason", "stale_oracle_dependency"],
        ]),
      ),
    ).toEqual({
      type: "AdlCounterpartySkipped",
      owner: OWNER_AB,
      market: 7,
      poolId: 1,
      size: 3n,
      reason: "stale_oracle_dependency",
    });
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
      "an unknown outcome",
      txEvent("liquidation_progress_reported", [
        ["owner", OWNER_AB],
        ["outcome", "partly_done"],
        ["config_sequence", "4"],
      ]),
      /outcome has unknown value "partly_done"/,
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
      "an unknown mode",
      positionLiquidated({ mode: "gentle" }),
      /mode has unknown value "gentle"/,
    ],
    [
      "an i64 overflow",
      positionLiquidated({ equity: "-9223372036854775809" }),
      /equity exceeds i64/,
    ],
    [
      "a malformed binding outcome",
      positionLiquidated({ binding_outcome: "4:Yes" }),
      /binding_outcome has malformed entry "4:Yes"/,
    ],
    [
      "an unknown refusal",
      txEvent("liquidation_failed", [
        ["owner", OWNER_AB],
        ["code", "111"],
        ["refusal", "busy"],
      ]),
      /refusal has unknown value "busy"/,
    ],
  ])("refuses %s", (_name, event, message) => {
    expect(() => decodeLiquidationEvent(event)).toThrow(message);
  });
});
