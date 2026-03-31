import { describe, it, expect } from "vitest";
import { encodeTx, decodeTx, peekActionType } from "./codec.js";
import { ActionType, Side, type Action } from "./types.js";

const OWNER = new Uint8Array(20).fill(0xaa);

describe("codec", () => {
  it("round-trips PlaceOrder", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 10000n,
        quantity: 50n,
      },
    };

    const bytes = encodeTx(action, 42n);
    const { action: decoded, seq } = decodeTx(bytes);

    expect(seq).toBe(42n);
    expect(decoded.type).toBe("PlaceOrder");
    if (decoded.type === "PlaceOrder") {
      expect(decoded.data.market).toBe(1);
      expect(decoded.data.price).toBe(10000n);
      expect(decoded.data.quantity).toBe(50n);
      expect(decoded.data.side).toBe(Side.Buy);
    }
  });

  it("round-trips CancelOrder", () => {
    const action: Action = {
      type: "CancelOrder",
      data: { orderId: 999n, owner: OWNER },
    };

    const bytes = encodeTx(action, 1n);
    const { action: decoded } = decodeTx(bytes);

    expect(decoded.type).toBe("CancelOrder");
    if (decoded.type === "CancelOrder") {
      expect(decoded.data.orderId).toBe(999n);
    }
  });

  it("round-trips OracleUpdate", () => {
    const signer = new Uint8Array(20).fill(0x03);
    const action: Action = {
      type: "OracleUpdate",
      data: { market: 1, price: 5000n, signer },
    };

    const bytes = encodeTx(action, 7n);
    const { action: decoded } = decodeTx(bytes);

    expect(decoded.type).toBe("OracleUpdate");
    if (decoded.type === "OracleUpdate") {
      expect(decoded.data.market).toBe(1);
      expect(decoded.data.price).toBe(5000n);
    }
  });

  it("peeks action type", () => {
    const action: Action = {
      type: "CancelOrder",
      data: { orderId: 1n, owner: OWNER },
    };
    const bytes = encodeTx(action, 1n);
    expect(peekActionType(bytes)).toBe(ActionType.CancelOrder);
  });

  it("encodes side as string to match Rust serde wire format", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    };
    const bytes = encodeTx(action, 1n);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // Payload must contain "Buy" as a msgpack fixstr (a3 42 75 79)
    expect(hex).toContain("a3427579");

    // Sell variant
    const sellAction: Action = {
      type: "PlaceOrder",
      data: { ...action.data, side: Side.Sell },
    };
    const sellHex = Array.from(encodeTx(sellAction, 1n))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // Must contain "Sell" as a msgpack fixstr (a4 53 65 6c 6c)
    expect(sellHex).toContain("a453656c6c");
  });

  it("encoding is deterministic", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: 1,
        owner: OWNER,
        side: Side.Buy,
        price: 100n,
        quantity: 10n,
      },
    };
    const a = encodeTx(action, 1n);
    const b = encodeTx(action, 1n);
    expect(a).toEqual(b);
  });
});
