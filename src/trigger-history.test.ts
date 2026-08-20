import { describe, expect, it } from "vitest";
import {
  decodePositionTriggerHistoryPage,
  decodeTriggerMarketHistoryPage,
  positionTriggerHistorySearchParams,
  triggerMarketHistorySearchParams,
} from "./trigger-history.js";

const OWNER = "aabbccdd00112233445566778899aabbccddeeff";

function executedEvent() {
  return {
    event_key: "101:18446744073709551615:0",
    block_height: "101",
    execution_ordinal: "18446744073709551615",
    event_ordinal: "0",
    block_time: "2026-04-19T20:20:00.123456789Z",
    event_type: "position_trigger_executed",
    owner: OWNER,
    market: "7",
    payload: {
      event_key: "101:18446744073709551615:0",
      block_height: "101",
      execution_ordinal: "18446744073709551615",
      event_ordinal: "0",
      owner: OWNER,
      market: "7",
      position_epoch: "3",
      group_id: "18446744073709551615",
      limb_id: "11",
      client_group_id: "0",
      client_trigger_id: "0",
      limb_kind: "stop_loss",
      trigger_price: "95000",
      frozen_mark: "94000",
      limit_price: "93000",
      requested_quantity: "4",
      filled_quantity: "3",
      residual_quantity: "1",
      execution_order_id: "18446744073709551615",
      total_fee: "-7",
      result: "partial",
      reason: "no_eligible_liquidity",
    },
  };
}

function setEvent() {
  return {
    event_key: "100:1:0",
    block_height: "100",
    execution_ordinal: "1",
    event_ordinal: "0",
    block_time: "2026-04-19T20:10:00Z",
    event_type: "position_triggers_set",
    owner: OWNER,
    market: "7",
    payload: {
      event_key: "100:1:0",
      block_height: "100",
      execution_ordinal: "1",
      event_ordinal: "0",
      owner: OWNER,
      market: "7",
      position_epoch: "3",
      group_id: "9",
      client_group_id: "0",
      stop_limb_id: "10",
      stop_client_trigger_id: "0",
      take_profit_limb_id: "11",
      take_profit_client_trigger_id: "0",
      accepted_height: "100",
      active_from_height: "101",
      replaced_group_id: "0",
    },
  };
}

function marketEvent(
  type: "trigger_market_deferred" | "trigger_market_resumed",
) {
  const height = type === "trigger_market_resumed" ? "201" : "200";
  return {
    event_key: `${height}:4:0`,
    block_height: height,
    execution_ordinal: "4",
    event_ordinal: "0",
    block_time: `2026-04-19T20:${type === "trigger_market_resumed" ? "51" : "50"}:00Z`,
    event_type: type,
    owner: null,
    market: "7",
    payload: {
      event_key: `${height}:4:0`,
      block_height: height,
      execution_ordinal: "4",
      event_ordinal: "0",
      market: "7",
      ...(type === "trigger_market_resumed"
        ? { previous_reason: "mark_stale" }
        : { reason: "mark_stale" }),
    },
  };
}

describe("TR-6 trigger history decoder", () => {
  it("decodes the exact owner envelope without rounding coordinates or ids", () => {
    const page = decodePositionTriggerHistoryPage(
      {
        trigger_events: [executedEvent(), setEvent()],
        next_cursor: "dHJpZ2dlci0xopaque",
      },
      OWNER.toUpperCase(),
      7,
    );
    expect(page.nextCursor).toBe("dHJpZ2dlci0xopaque");
    expect(page.triggerEvents[0].executionOrdinal).toBe("18446744073709551615");
    expect(page.triggerEvents[0].payload.execution_order_id).toBe(
      "18446744073709551615",
    );
    expect(page.triggerEvents[0].payload.total_fee).toBe("-7");
  });

  it("keeps shared market transitions in their distinct envelope", () => {
    const page = decodeTriggerMarketHistoryPage(
      {
        trigger_market_events: [
          marketEvent("trigger_market_resumed"),
          marketEvent("trigger_market_deferred"),
        ],
        next_cursor: "",
      },
      7,
    );
    expect(page.triggerMarketEvents.map((event) => event.eventType)).toEqual([
      "trigger_market_resumed",
      "trigger_market_deferred",
    ]);
    expect(
      page.triggerMarketEvents.every((event) => event.owner === null),
    ).toBe(true);
  });

  it("fails closed on malformed envelopes, numeric ids and identity drift", () => {
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_market_events: [], next_cursor: "" },
        OWNER,
      ),
    ).toThrow(/unexpected or missing/);

    const numeric = executedEvent();
    (numeric.payload as Record<string, unknown>).execution_order_id =
      18_446_744_073_709_551_615;
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [numeric], next_cursor: "" },
        OWNER,
      ),
    ).toThrow(/must remain a string/);

    const drift = executedEvent();
    drift.payload.event_key = "101:1:0";
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [drift], next_cursor: "" },
        OWNER,
      ),
    ).toThrow(/identity disagrees/);

    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [setEvent(), executedEvent()], next_cursor: "" },
        OWNER,
      ),
    ).toThrow(/newest-first/);

    const ownerDuplicated = marketEvent("trigger_market_deferred");
    ownerDuplicated.owner = OWNER;
    expect(() =>
      decodeTriggerMarketHistoryPage(
        { trigger_market_events: [ownerDuplicated], next_cursor: "" },
        7,
      ),
    ).toThrow(/owner does not match/);

    const impossibleTerminal = executedEvent();
    impossibleTerminal.payload.result = "filled";
    impossibleTerminal.payload.reason = "";
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [impossibleTerminal], next_cursor: "" },
        OWNER,
      ),
    ).toThrow(/result, quantities, and reason disagree/);

    const wrongMarketReason = marketEvent("trigger_market_deferred");
    wrongMarketReason.payload.reason = "below_maintenance";
    expect(() =>
      decodeTriggerMarketHistoryPage(
        { trigger_market_events: [wrongMarketReason], next_cursor: "" },
        7,
      ),
    ).toThrow(/unknown payload.reason/);
  });

  it("serializes every stable filter and treats cursor as opaque", () => {
    const owner = positionTriggerHistorySearchParams({
      market: 7,
      from: 1_700_000_000_001n,
      to: "2026-04-19T20:51:00Z",
      limit: 200,
      cursor: "opaque+/=token",
    });
    expect(Object.fromEntries(owner)).toEqual({
      from: "1700000000001",
      to: "2026-04-19T20:51:00Z",
      limit: "200",
      cursor: "opaque+/=token",
      market: "7",
    });
    expect(
      Object.fromEntries(triggerMarketHistorySearchParams({ limit: 1 })),
    ).toEqual({
      limit: "1",
    });
    expect(() => positionTriggerHistorySearchParams({ cursor: "" })).toThrow(
      /non-empty opaque/,
    );
    expect(() =>
      triggerMarketHistorySearchParams({ from: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(/safe/);
  });
});
