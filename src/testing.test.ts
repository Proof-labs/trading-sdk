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

describe("@proof-labs/trading-sdk/testing", () => {
  it("is not reachable from the main entry", () => {
    expect(
      (main.ActionType as Record<string, number>).RunFundingTick,
    ).toBeUndefined();
    expect("registerTestActions" in main).toBe(false);
  });

  it("encodes RunFundingTick (0x12) once registered", () => {
    const tick: TestAction = {
      type: "RunFundingTick",
      data: { market: 3, signer },
    };
    expect(() => encodePayloadBytes(tick as Action)).toThrow();

    registerTestActions();
    registerTestActions(); // idempotent

    const wire = encodeSignedTx(
      tick as Action,
      1n,
      new Uint8Array(32),
      new Uint8Array(64),
    );
    const envelope = decodeMessagePack(wire) as unknown[];
    expect(envelope[1]).toBe(TestActionType.RunFundingTick);
    expect(decodeMessagePack(envelope[3] as Uint8Array)).toEqual([
      3,
      Array.from(signer),
    ]);

    const decoded = decodeTx(wire);
    expect(decoded.action).toEqual(tick);
  });
});
