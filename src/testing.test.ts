import { describe, it, expect } from "vitest";
import { decode as decodeMessagePack } from "@msgpack/msgpack";

import * as main from "./index.js";
import { encodeSignedTx, encodePayloadBytes, decodeTx } from "./codec.js";
import {
  registerTestActions,
  TestActionType,
  type TestAction,
} from "./testing.js";
import type { Action } from "./types.js";

const signer = new Uint8Array(20).fill(7);

describe("@proof/trading-sdk/testing", () => {
  it("is not reachable from the main entry", () => {
    expect(
      (main.ActionType as Record<string, number>).RunLiquidationSweep,
    ).toBeUndefined();
    expect(
      (main.ActionType as Record<string, number>).RunFundingTick,
    ).toBeUndefined();
    expect("registerTestActions" in main).toBe(false);
  });

  it("encodes RunLiquidationSweep (0x11) and RunFundingTick (0x12) once registered", () => {
    const sweep: TestAction = { type: "RunLiquidationSweep", data: { signer } };
    expect(() => encodePayloadBytes(sweep as Action)).toThrow();

    registerTestActions();
    registerTestActions(); // idempotent

    const wire = encodeSignedTx(
      sweep as Action,
      1n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    const envelope = decodeMessagePack(wire) as unknown[];
    expect(envelope[1]).toBe(TestActionType.RunLiquidationSweep);
    expect(decodeMessagePack(envelope[3] as Uint8Array)).toEqual([
      Array.from(signer),
    ]);

    const tick: TestAction = {
      type: "RunFundingTick",
      data: { market: 3, signer },
    };
    const tickPayload = decodeMessagePack(encodePayloadBytes(tick as Action));
    expect(tickPayload).toEqual([3, Array.from(signer)]);

    const decoded = decodeTx(
      encodeSignedTx(
        tick as Action,
        1n,
        new Uint8Array(32),
        new Uint8Array(64),
      ),
    );
    expect(decoded.action).toEqual(tick);
  });
});
