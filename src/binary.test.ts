import { describe, expect, it } from "vitest";

import {
  BINARY_PRICE_MAX,
  BinaryPriceError,
  binaryPositionView,
  yesOrder,
  yesSide,
  type NoOrder,
} from "./binary.js";
import { Side, TimeInForce, type TriggerLimb } from "./types.js";

const limb = (triggerPrice: bigint): TriggerLimb => ({
  triggerPrice,
  maxSlippageBps: 150,
  clientTriggerId: 9n,
});

const no = (side: Side, price: bigint): NoOrder => ({
  market: 70_000,
  side,
  price,
  quantity: 25n,
  clientOrderId: 11n,
  postOnly: true,
  reduceOnly: true,
  timeInForce: TimeInForce.Ioc,
});

describe("No orders on an event's one book (S1)", () => {
  it("buying No sells Yes at the mirrored price and carries every flag", () => {
    expect(yesOrder(no(Side.Buy, 400_000n))).toEqual({
      ...no(Side.Buy, 400_000n),
      side: Side.Sell,
      price: 600_000n,
    });
  });

  it("selling No buys Yes, reduce-only carried over (S4)", () => {
    const yes = yesOrder(no(Side.Sell, 300_000n));
    expect([yes.side, yes.price, yes.reduceOnly]).toEqual([
      Side.Buy,
      700_000n,
      true,
    ]);
  });

  it("refuses a No price with no mirror", () => {
    for (const price of [0n, BINARY_PRICE_MAX, BINARY_PRICE_MAX + 1n]) {
      expect(() => yesOrder(no(Side.Buy, price))).toThrow(BinaryPriceError);
    }
    expect(yesOrder(no(Side.Buy, 1n)).price).toBe(999_999n);
  });
});

describe("No stops and take-profits (S3)", () => {
  // Long No at 0.50 = short Yes at 0.50. A stop at No ≤ 0.30 is a stop at
  // Yes ≥ 0.70; a take-profit at No ≥ 0.80 is a take-profit at Yes ≤ 0.20.
  // Short No = long Yes: a stop at No ≥ 0.70 is a stop at Yes ≤ 0.30.
  const table: Array<[string, Side, bigint, bigint, bigint, bigint]> = [
    ["long No", Side.Buy, 300_000n, 800_000n, 700_000n, 200_000n],
    ["short No", Side.Sell, 700_000n, 200_000n, 300_000n, 800_000n],
  ];
  for (const [label, side, sl, tp, yesSl, yesTp] of table) {
    it(`${label}: each limb keeps its role at the mirrored trigger`, () => {
      const yes = yesOrder({
        ...no(side, 500_000n),
        reduceOnly: false,
        stopLoss: limb(sl),
        takeProfit: limb(tp),
      });
      expect(yes.stopLoss).toEqual(limb(yesSl));
      expect(yes.takeProfit).toEqual(limb(yesTp));
    });
  }

  it("refuses a limb with no mirror", () => {
    expect(() =>
      yesOrder({ ...no(Side.Buy, 500_000n), stopLoss: limb(BINARY_PRICE_MAX) }),
    ).toThrow(/trigger price/);
  });
});

describe("positions read as No (S2, S4)", () => {
  it("a short Yes is No at the mirrored entry; a long Yes stays Yes", () => {
    expect(
      binaryPositionView({ side: "Sell", entryPrice: 600_000n, size: 40n }),
    ).toEqual({ outcome: "No", entryPrice: 400_000n, size: 40n });
    expect(
      binaryPositionView({ side: Side.Buy, entryPrice: 600_000n, size: 40n }),
    ).toEqual({ outcome: "Yes", entryPrice: 600_000n, size: 40n });
  });

  it("netting reads through: No shrinks, then flips to Yes past zero", () => {
    // Short 40 Yes at 0.60 (No at 0.40); buying 25 Yes leaves short 15; the
    // engine keeps the entry, so it still reads No at 0.40. Buying 30 more
    // flips to long 15 Yes at the fill price.
    const steps = [
      { side: "Sell" as const, entryPrice: 600_000n, size: 15n },
      { side: "Buy" as const, entryPrice: 550_000n, size: 15n },
    ];
    expect(steps.map(binaryPositionView)).toEqual([
      { outcome: "No", entryPrice: 400_000n, size: 15n },
      { outcome: "Yes", entryPrice: 550_000n, size: 15n },
    ]);
  });

  it("refuses an entry above $1", () => {
    expect(() =>
      binaryPositionView({
        side: "Sell",
        entryPrice: BINARY_PRICE_MAX + 1n,
        size: 1n,
      }),
    ).toThrow(BinaryPriceError);
  });
});

describe("a side that is neither Buy nor Sell", () => {
  // A mistyped side from a JavaScript caller must never become the opposite trade.
  it.each(["buy", "sell", "", "Long", 0, 3, undefined])(
    "refuses %s",
    (side) => {
      expect(() => yesSide(side as unknown as Side)).toThrow(TypeError);
      expect(() =>
        binaryPositionView({
          side: side as unknown as Side,
          entryPrice: 600_000n,
          size: 40n,
        }),
      ).toThrow(TypeError);
    },
  );
});
