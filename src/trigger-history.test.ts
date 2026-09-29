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
      source_order_id: "840",
    },
  };
}

function pendingCoordinates(height: string, ordinal: string, event: string) {
  return {
    event_key: `${height}:${ordinal}:${event}`,
    block_height: height,
    execution_ordinal: ordinal,
    event_ordinal: event,
    block_time: "2026-04-19T20:05:00Z",
    owner: OWNER,
    market: "7",
  };
}

function pendingAttachEvent() {
  return {
    ...pendingCoordinates("99", "7", "0"),
    event_type: "pending_triggers_attached",
    payload: {
      event_key: "99:7:0",
      block_height: "99",
      execution_ordinal: "7",
      event_ordinal: "0",
      owner: OWNER,
      market: "7",
      order_id: "2001",
      client_order_id: "77",
      stop_loss: "trigger_price=50000,max_slippage_bps=100,client_trigger_id=5",
      take_profit: "",
    },
  };
}

function pendingDiscardEvent(
  reason: "install_rejected" | "order_cancelled" | "position_closed",
) {
  return {
    ...pendingCoordinates("102", "9", "1"),
    event_type: "pending_triggers_discarded",
    payload: {
      event_key: "102:9:1",
      block_height: "102",
      execution_ordinal: "9",
      event_ordinal: "1",
      owner: OWNER,
      market: "7",
      order_id: "2001",
      reason,
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
    // Deliberately a NUMBER (not a string) to prove the decoder rejects it; the
    // magnitude is illustrative (u64::MAX-shaped), so its precision is moot.
    // eslint-disable-next-line no-loss-of-precision
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

  it("decodes the pending lifecycle, install_rejected included", () => {
    const page = decodePositionTriggerHistoryPage(
      {
        trigger_events: [
          pendingDiscardEvent("install_rejected"),
          pendingAttachEvent(),
        ],
        next_cursor: "",
      },
      OWNER,
      7,
    );
    expect(page.triggerEvents.map((event) => event.eventType)).toEqual([
      "pending_triggers_discarded",
      "pending_triggers_attached",
    ]);
    const attached = page.triggerEvents[1];
    expect(attached.payload.order_id).toBe("2001");
    expect(attached.payload.stop_loss).toContain("trigger_price=50000");
    expect(attached.payload.take_profit).toBe("");

    // The one silent protection-loss path: the fill stands, the bracket does
    // not. The reason survives decoding verbatim.
    const rejected = page.triggerEvents[0];
    expect(rejected.payload.reason).toBe("install_rejected");
  });

  it("fails closed on impossible pending payloads", () => {
    const noLimbs = pendingAttachEvent();
    noLimbs.payload.stop_loss = "";
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [noLimbs], next_cursor: "" },
        OWNER,
        7,
      ),
    ).toThrow(/pending attach carries no trigger limbs/);

    const mangledLimb = pendingAttachEvent();
    mangledLimb.payload.stop_loss =
      "trigger_price=50000,max_slippage_bps=100,client_trigger_id=";
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [mangledLimb], next_cursor: "" },
        OWNER,
        7,
      ),
    ).toThrow(/not the wire limb render/);

    const zeroOrder = pendingAttachEvent();
    zeroOrder.payload.order_id = "0";
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [zeroOrder], next_cursor: "" },
        OWNER,
        7,
      ),
    ).toThrow(/order_id is out of range/);

    const unknownReason = pendingDiscardEvent("order_cancelled");
    unknownReason.payload.reason = "because";
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [unknownReason], next_cursor: "" },
        OWNER,
        7,
      ),
    ).toThrow(/unknown payload.reason/);
  });

  it("surfaces the additive set/invalidated attributes and bounds them", () => {
    const invalidated = (reason?: string) => ({
      ...pendingCoordinates("103", "2", "0"),
      event_type: "position_triggers_invalidated",
      payload: {
        event_key: "103:2:0",
        block_height: "103",
        execution_ordinal: "2",
        event_ordinal: "0",
        owner: OWNER,
        market: "7",
        position_epoch: "3",
        group_id: "9",
        ...(reason === undefined ? {} : { invalidation_reason: reason }),
      },
    });
    const page = decodePositionTriggerHistoryPage(
      {
        trigger_events: [invalidated("3"), setEvent()],
        next_cursor: "",
      },
      OWNER,
      7,
    );
    expect(page.triggerEvents[0].payload.invalidation_reason).toBe("3");
    expect(
      (page.triggerEvents[1].payload as { source_order_id?: string })
        .source_order_id,
    ).toBe("840");

    // The engine's u8 attribute domain: 256 cannot be an invalidation reason.
    expect(() =>
      decodePositionTriggerHistoryPage(
        { trigger_events: [invalidated("256")], next_cursor: "" },
        OWNER,
        7,
      ),
    ).toThrow(/invalidation_reason is out of range/);
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
