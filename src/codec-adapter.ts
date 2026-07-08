/**
 * Adapter between the TypeScript `Action` shape (camelCase fields, numeric
 * enums, `Uint8Array` byte fields, `bigint` u64s) and the JSON shape the Rust
 * core's `encode_payload` / `decode_payload` expect (snake_case fields, wire
 * enum forms). Field *order* is owned by Rust — this only translates names and
 * enum representations, so it replaces the ~770 lines of positional index
 * juggling in `codec.ts` with a data-driven transform.
 *
 * Validated against the legacy hand-written codec by a differential test
 * (`codec-adapter.test.ts`); nothing here is trusted until it reproduces the
 * legacy bytes for every action.
 */

import {
  ActionType,
  Outcome,
  Side,
  TimeInForce,
  type Action,
  type ActionTypeValue,
  type EventOracleSource,
} from "./types.js";

/** camelCase → snake_case for field names (matches Rust serde field idents). */
function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/**
 * Field names whose mechanical camel→snake conversion does not match the Rust
 * struct ident. Populated as the differential test surfaces mismatches.
 */
const FIELD_OVERRIDES: Record<string, string> = {
  // `camelToSnake` keeps a digit attached to the preceding letters
  // (`min30d_volume…`); the Rust ident splits before the number.
  min30dVolumeMicroUsdc: "min_30d_volume_micro_usdc",
};

/**
 * Field names that carry a numeric TS enum which serializes as its variant
 * *name* on the wire. `EnumType[value]` yields the name (numeric enums have a
 * reverse mapping); `EnumType[name]` yields the number for the inverse.
 */
const NUMERIC_ENUM_FIELDS: Record<
  string,
  Record<string | number, string | number>
> = {
  side: Side,
  timeInForce: TimeInForce,
  outcome: Outcome,
};

/**
 * Encode an `EventOracleSource` for `serde_wasm_bindgen` deserialization.
 * Externally-tagged enum: the unit variant is a bare string, struct variants
 * are `{ Variant: { snake_case_fields } }` (a MAP — serde_wasm_bindgen
 * deserializes struct variants from maps, not the positional arrays rmp-serde
 * emits on the wire).
 */
function eventOracleSourceToWasm(
  src: EventOracleSource | null | undefined,
): unknown {
  if (src === null || src === undefined) return null;
  switch (src.kind) {
    case "RelayerAttested":
      return "RelayerAttested";
    case "UnderlyingPriceVsStrike":
      return {
        UnderlyingPriceVsStrike: {
          strike_price: src.strikePrice,
          comparison: src.comparison,
        },
      };
    case "MarketOracle":
      return {
        MarketOracle: {
          market: src.market,
          strike_price: src.strikePrice,
          comparison: src.comparison,
        },
      };
  }
}

/**
 * `MarkSourceMode` is a plain serde enum, so `serde_wasm_bindgen` wants the
 * variant *name* (the numeric `0 | 1` the SDK exposes is only rmp-serde's
 * compact wire index). `encode_payload` re-emits it as that index, so the
 * output still matches the legacy codec.
 */
const MARK_SOURCE_MODE_NAMES: Record<number, string> = {
  0: "OracleOnly",
  1: "Median",
};

function convertValue(camelKey: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (camelKey === "oracleSource") {
    return eventOracleSourceToWasm(value as EventOracleSource);
  }
  if (camelKey === "markSourceMode" && typeof value === "number") {
    return MARK_SOURCE_MODE_NAMES[value];
  }
  const enumMap = NUMERIC_ENUM_FIELDS[camelKey];
  if (enumMap && typeof value === "number") {
    return enumMap[value];
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    // Arrays of nested objects (e.g. AtomicBasketOrder.legs) recurse; arrays of
    // scalars pass through.
    return value.map((v) =>
      v && typeof v === "object" && !(v instanceof Uint8Array)
        ? convertObject(v as Record<string, unknown>)
        : v,
    );
  }
  if (typeof value === "object") {
    return convertObject(value as Record<string, unknown>);
  }
  return value;
}

function convertObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const snake = FIELD_OVERRIDES[k] ?? camelToSnake(k);
    out[snake] = convertValue(k, v);
  }
  return out;
}

/**
 * Translate a TS `Action` into `(actionType, fields)` for `encode_payload`.
 */
export function toWasmFields(action: Action): {
  actionType: ActionTypeValue;
  fields: Record<string, unknown>;
} {
  const actionType = ActionType[action.type];
  return {
    actionType,
    fields: convertObject(action.data as unknown as Record<string, unknown>),
  };
}
