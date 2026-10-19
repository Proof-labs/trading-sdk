import { describe, expect, it } from "vitest";
import {
  LIQUIDATION_PROGRESS_OUTCOMES,
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

describe("decodeLiquidationEvent", () => {
  it("decodes LiquidationConfigSet into the configuration it carries", () => {
    const event = txEvent("liquidation_config_set", [
      ["sequence", "2"],
      ["target_ratio_bps", "10500"],
      ["full_close_numerator", "2"],
      ["full_close_denominator", "3"],
      ["partial_penalty_bps", "100"],
      ["max_book_orders", "20"],
      ["max_candidate_prefixes", "20"],
      ["max_committed_fills", "10"],
      ["max_state_reads", "10000"],
      ["max_state_read_bytes", "1000000"],
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
        maxCandidatePrefixes: 20,
        maxCommittedFills: 10,
        maxStateReads: 10_000,
        maxStateReadBytes: 1_000_000,
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

  it("decodes FullLiquidationFee, one per completed full close", () => {
    const event = txEvent("full_liquidation_fee", [
      ["owner", OWNER_CD],
      ["config_sequence", "2"],
      ["closed_notional", "700"],
      ["assessed", "7"],
      ["collected", "4"],
      ["waived", "3"],
    ]);
    expect(decodeLiquidationEvent(event)).toEqual({
      type: "FullLiquidationFee",
      owner: OWNER_CD,
      configSequence: 2n,
      closedNotional: 700n,
      assessed: 7n,
      collected: 4n,
      waived: 3n,
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
  });

  it.each<[string, TxEvent, RegExp]>([
    [
      "an assessment that is not collected + waived",
      partialFee({ waived: "1" }),
      /assessed is not collected \+ waived/,
    ],
    [
      "a missing attribute",
      txEvent("full_liquidation_fee", [["owner", OWNER_CD]]),
      /config_sequence is missing/,
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
        ["max_candidate_prefixes", "20"],
        ["max_committed_fills", "10"],
        ["max_state_reads", "10000"],
        ["max_state_read_bytes", "1000000"],
        ["proposal_id", "7"],
      ]),
      /config is invalid: targetRatioBps/,
    ],
  ])("refuses %s", (_name, event, message) => {
    expect(() => decodeLiquidationEvent(event)).toThrow(message);
  });
});
