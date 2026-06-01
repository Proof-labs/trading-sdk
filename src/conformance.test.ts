// Cross-language conformance runner (TypeScript) — SCAFFOLD, currently skipped.
//
// Asserts this SDK reproduces the checked-in vectors in `../conformance/`,
// which the Rust core generates (`crates/spec`, `gen-vectors`) and the Rust +
// Python runners already pass. Getting this green is the third leg of the
// cross-language guarantee. See `conformance/README.md` for the full plan.
//
// Why it is `describe.skip` today (handoff TODOs, in priority order):
//
//   1. No public payload encoder. `encodePayload` in `codec.ts` is module-
//      private; the codec family needs the *payload* bytes, not a full signed
//      envelope. Export a thin `encodePayloadBytes(action): Uint8Array` (or
//      export `encodePayload` and `encode`) and call it from `runCodec` below.
//
//   2. Adapter gap. Vector `input` is the core's snake_case field dict with
//      JSON arrays of u8 for byte fields and plain JSON numbers for integers.
//      This SDK's `Action` is a camelCase discriminated union whose integer
//      fields are `bigint` and whose byte fields are `Uint8Array`. `toAction`
//      below covers only the seed action types — finish it for all 27 (or
//      replace it with a generated map).
//
//   3. Missing action. The core emits an `OracleUpdateComposite` (0x14) vector
//      that this SDK does not implement (no `ActionType` entry). Its case will
//      throw in `toAction` — that divergence is the *point* of the vector; add
//      the action to `types.ts`/`codec.ts`, do not delete the vector.
//
// Once 1–3 are done, change `describe.skip` to `describe` and add the suite to
// CI alongside the Rust and Python runners.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

import { signAndEncode } from "./codec.js";
import { pubkeyToOwner, bytesToHex } from "./crypto.js";
import {
  ActionType,
  Side,
  TimeInForce,
  type Action,
  type ActionTypeValue,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "conformance");

interface Case {
  case: string;
  [k: string]: unknown;
}

function cases(file: string): Case[] {
  const body = readFileSync(join(VECTORS, file), "utf8");
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Case);
}

const SIDE: Record<string, Side> = { Buy: Side.Buy, Sell: Side.Sell };
const TIF: Record<string, TimeInForce> = {
  Gtc: TimeInForce.Gtc,
  Ioc: TimeInForce.Ioc,
  Fok: TimeInForce.Fok,
};

/** u8-array (vector byte field) → Uint8Array. */
function bytes(v: unknown): Uint8Array {
  return Uint8Array.from(v as number[]);
}

/** JSON number/string → bigint (vector integers are plain JSON numbers). */
function big(v: unknown): bigint {
  return BigInt(v as number | string);
}

/**
 * Adapter: core snake_case `input` dict → this SDK's `Action` union.
 *
 * TODO(handoff): only the seed action types are wired. Extend to all 27.
 * Throwing on an unknown type is intentional — it surfaces coverage gaps and
 * the deliberately-missing `OracleUpdateComposite` (0x14).
 */
function toAction(actionType: ActionTypeValue, input: Record<string, unknown>): Action {
  switch (actionType) {
    case ActionType.PlaceOrder:
      return {
        type: "PlaceOrder",
        data: {
          market: input.market as number,
          owner: bytes(input.owner),
          side: SIDE[input.side as string],
          price: big(input.price),
          quantity: big(input.quantity),
          clientOrderId:
            input.client_order_id == null ? null : big(input.client_order_id),
          postOnly: input.post_only as boolean,
          reduceOnly: input.reduce_only as boolean,
          timeInForce: TIF[input.time_in_force as string],
        },
      };
    case ActionType.CancelOrder:
      return {
        type: "CancelOrder",
        data: { orderId: big(input.order_id), owner: bytes(input.owner) },
      };
    case ActionType.MarketOrder:
      return {
        type: "MarketOrder",
        data: {
          market: input.market as number,
          owner: bytes(input.owner),
          side: SIDE[input.side as string],
          quantity: big(input.quantity),
          clientOrderId:
            input.client_order_id == null ? null : big(input.client_order_id),
        },
      };
    case ActionType.ClosePosition:
      return {
        type: "ClosePosition",
        data: { market: input.market as number, owner: bytes(input.owner) },
      };
    // TODO(handoff): OracleUpdate (0x03) and the remaining 22 action types.
    default:
      throw new Error(
        `toAction: action_type 0x${actionType.toString(16)} not wired ` +
          `(see conformance/README.md handoff TODOs)`,
      );
  }
}

describe.skip("conformance vectors (TypeScript)", () => {
  it("codec: action fields → payload bytes", () => {
    for (const c of cases("codec.ndjson")) {
      const action = toAction(
        c.action_type as ActionTypeValue,
        c.input as Record<string, unknown>,
      );
      // TODO(handoff #1): need a public payload-only encoder.
      //   const payload = encodePayloadBytes(action);
      //   expect(bytesToHex(payload)).toBe((c.expect as { payload_hex: string }).payload_hex);
      void action;
      throw new Error("blocked on encodePayload export — see header TODO #1");
    }
  });

  it("signing: (payload,key) → envelope; pubkey → owner", () => {
    for (const c of cases("signing.ndjson")) {
      if (c.kind === "sign") {
        // signAndEncode takes a typed Action, not raw payload bytes; to use the
        // signing vectors as-is we need a sign-from-payload entry point, or
        // re-derive the action. TODO(handoff): add `signEnvelopeFromPayload`.
        throw new Error("blocked on sign-from-payload entry point");
      } else if (c.kind === "owner") {
        const owner = pubkeyToOwner(bytes(c.pubkey));
        expect(bytesToHex(owner)).toBe(c.expect_owner_hex as string);
      } else {
        throw new Error(`unknown signing kind: ${String(c.kind)}`);
      }
    }
  });

  it("nonce: (last, now_ms…) → allocated sequence", () => {
    // TODO(handoff): the TS client allocates nonces inline (Date.now-based);
    // factor out a pure `nonceStep(last, nowMs) = max(nowMs, last+1)` mirroring
    // Python's `NonceAllocator.step` and Rust's `nonce_step`, then pin it here.
    for (const c of cases("nonce.ndjson")) {
      const nowMs = c.now_ms as number[];
      let last = c.last as number;
      const out: number[] = [];
      for (const now of nowMs) {
        last = Math.max(now, last + 1); // inline until nonceStep is extracted
        out.push(last);
      }
      expect(out).toEqual(c.expect as number[]);
    }
  });
});
