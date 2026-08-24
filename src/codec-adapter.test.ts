import { describe, expect, it } from "vitest";
import { fromWasmFields, toWasmFields } from "./codec-adapter.js";
import { ActionType, Side, TimeInForce, type Action } from "./types.js";

// These exercise the adapter's translation layer directly — no WASM involved.
// Round-trip correctness through the WASM core is covered by codec.test.ts
// and the conformance vectors.

describe("codec-adapter enum loudness", () => {
  it("throws by field name for an out-of-range numeric enum on encode", () => {
    const action = {
      type: "PlaceOrder",
      data: { side: 99 },
    } as unknown as Action;
    expect(() => toWasmFields(action)).toThrow(/unknown side enum value: 99/);
  });

  it("throws for an out-of-range markSourceMode on encode", () => {
    const action = {
      type: "CreateMarket",
      data: { markSourceMode: 7 },
    } as unknown as Action;
    expect(() => toWasmFields(action)).toThrow(
      /unknown markSourceMode value: 7/,
    );
  });

  it("accepts every declared enum variant on encode", () => {
    const action = {
      type: "PlaceOrder",
      data: { side: Side.Sell, timeInForce: TimeInForce.Fok },
    } as unknown as Action;
    expect(toWasmFields(action).fields).toEqual({
      side: "Sell",
      time_in_force: "Fok",
    });
  });

  it("throws by field name for an unknown enum variant on decode", () => {
    expect(() =>
      fromWasmFields(ActionType.PlaceOrder, { side: "Sideways" }),
    ).toThrow(/unknown side enum variant: Sideways/);
  });

  it("throws for an unknown markSourceMode variant on decode", () => {
    expect(() =>
      fromWasmFields(ActionType.CreateMarket, { mark_source_mode: "Vwap" }),
    ).toThrow(/unknown markSourceMode variant: Vwap/);
  });
});

describe("codec-adapter byte fields", () => {
  it("decodes a byte field from a plain number array by name", () => {
    const action = fromWasmFields(ActionType.PlaceOrder, {
      owner: [1, 2, 3],
    });
    expect((action.data as { owner: unknown }).owner).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  it("decodes an empty byte field to an empty Uint8Array, not []", () => {
    const action = fromWasmFields(ActionType.PlaceOrder, { owner: [] });
    expect((action.data as { owner: unknown }).owner).toEqual(
      new Uint8Array(0),
    );
  });

  it("does NOT byte-convert a numeric array on a non-byte field", () => {
    const action = fromWasmFields(ActionType.PlaceOrder, {
      future_market_ids: [1, 2, 300],
    });
    expect(
      (action.data as { futureMarketIds: unknown }).futureMarketIds,
    ).toEqual([1, 2, 300]);
  });

  it("throws loudly when a byte field carries non-u8 content", () => {
    expect(() =>
      fromWasmFields(ActionType.PlaceOrder, { owner: [1, 999] }),
    ).toThrow(/byte field owner: expected an array of u8/);
    expect(() =>
      fromWasmFields(ActionType.PlaceOrder, { owner: ["ff"] }),
    ).toThrow(/byte field owner: expected an array of u8/);
  });
});
