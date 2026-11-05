import { describe, expect, it } from "vitest";
import { decodeTx, encodeSignedTx } from "./codec.js";
import { Side, type Action } from "./types.js";
const owner = new Uint8Array(20).fill(7);
const stopLoss = { triggerPrice: 90n, maxSlippageBps: 75, clientTriggerId: 1n };
const takeProfit = {
  triggerPrice: 110n,
  maxSlippageBps: 120,
  clientTriggerId: 2n,
};
const action = (): Extract<Action, { type: "AtomicBasketOrder" }> => ({
  type: "AtomicBasketOrder",
  data: {
    owner,
    legs: [
      {
        market: 1,
        side: Side.Buy,
        price: 100n,
        quantity: 5n,
        stopLoss,
        takeProfit,
      },
    ],
  },
});
const encode = (value: Action) =>
  encodeSignedTx(value, 1n, new Uint8Array(32), new Uint8Array(64));
describe("atomic order protection", () => {
  it("round-trips both limbs through the authoritative WASM codec", () => {
    const decoded = decodeTx(encode(action())).action;
    expect(decoded.type).toBe("AtomicBasketOrder");
    if (decoded.type !== "AtomicBasketOrder") throw Error("wrong action");
    expect(decoded.data.legs[0].stopLoss).toEqual(stopLoss);
    expect(decoded.data.legs[0].takeProfit).toEqual(takeProfit);
  });
  it("rejects reduce-only protection before signing", () => {
    const value = action();
    value.data.legs[0].reduceOnly = true;
    expect(() => encode(value)).toThrow(/reduceOnly/);
  });
  it("validates every leg and rejects duplicate trigger ids", () => {
    const value = action();
    value.data.legs.push({
      market: 2,
      side: Side.Buy,
      price: 100n,
      quantity: 1n,
      stopLoss,
      takeProfit: { ...takeProfit, clientTriggerId: 1n },
    });
    expect(() => encode(value)).toThrow(/must differ/);
  });
});
