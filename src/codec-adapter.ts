/**
 * Adapter between the TypeScript `Action` shape (camelCase fields, numeric
 * enums, `Uint8Array` byte fields, `bigint` u64s) and the JSON shape the Rust
 * core's `encode_payload` / `decode_payload` expect (snake_case fields, wire
 * enum forms). Field *order* is owned by Rust — this only translates names and
 * enum representations, so it replaced the ~770 lines of positional index
 * juggling that used to live in `codec.ts` with a data-driven transform.
 *
 * Correctness is covered by the codec round-trip tests (`codec.test.ts`), the
 * cross-language conformance vectors (`conformance.test.ts`), and the direct
 * WASM-vs-vectors differential (`wasm-codec.test.ts`).
 */

import {
  ActionType,
  Outcome,
  Side,
  TimeInForce,
  type Action,
  type ActionTypeValue,
  type EventOracleSource,
  type PriceComparison,
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
    // Nullish fields are dropped, never passed across as a JS null/undefined:
    // serde applies `#[serde(default)]` / `Option::None` to a *missing* key,
    // while a present null fails deserialization into non-Option defaulted
    // fields ("invalid type: unit value" for `post_only`, `time_in_force`, …).
    // Dropping reproduces the legacy codec's `?? default` nullish coalescing;
    // for `Option` fields a missing key and an explicit null both encode as
    // nil, so the bytes are identical either way.
    if (v === null || v === undefined) continue;
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
  const fields = convertObject(
    action.data as unknown as Record<string, unknown>,
  );

  // `CreateMarket.max_open_interest` is a non-optional u64 in the Rust/WASM
  // core. The public TS input intentionally accepts omission/null as the
  // operator-facing spelling of "uncapped", so normalize both before crossing
  // the serde_wasm_bindgen boundary. This also makes the WASM migration path
  // emit the same canonical 12-field payload as the current TS codec.
  if (action.type === "CreateMarket" && fields.max_open_interest == null) {
    fields.max_open_interest = 0n;
  }

  return {
    actionType,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Decode direction: WASM `decode_payload` output → TS `Action`
// ---------------------------------------------------------------------------

/** action_type byte → `Action["type"]` name (inverse of `ActionType`). */
const ACTION_TYPE_NAMES = Object.fromEntries(
  Object.entries(ActionType).map(([name, byte]) => [byte, name]),
) as Record<number, Action["type"]>;

/** snake_case override → camelCase (inverse of `FIELD_OVERRIDES`). */
const FIELD_OVERRIDES_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_OVERRIDES).map(([camel, snake]) => [snake, camel]),
);

function snakeToCamel(key: string): string {
  return (
    FIELD_OVERRIDES_REVERSE[key] ??
    key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
  );
}

/** enum variant name → numeric value (inverse of `NUMERIC_ENUM_FIELDS`). */
const MARK_SOURCE_MODE_VALUES: Record<string, number> = {
  OracleOnly: 0,
  Median: 1,
};

/** Decode an `EventOracleSource` from serde's `{ Variant: {...} }` / string form. */
function eventOracleSourceFromWasm(v: unknown): EventOracleSource | null {
  if (v === null || v === undefined) return null;
  if (v === "RelayerAttested") return { kind: "RelayerAttested" };
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("UnderlyingPriceVsStrike" in obj) {
      const f = obj.UnderlyingPriceVsStrike as Record<string, unknown>;
      return {
        kind: "UnderlyingPriceVsStrike",
        strikePrice: BigInt(f.strike_price as string | number | bigint),
        comparison: f.comparison as PriceComparison,
      };
    }
    if ("MarketOracle" in obj) {
      const f = obj.MarketOracle as Record<string, unknown>;
      return {
        kind: "MarketOracle",
        market: Number(f.market),
        strikePrice: BigInt(f.strike_price as string | number | bigint),
        comparison: f.comparison as PriceComparison,
      };
    }
  }
  throw new Error(`unknown EventOracleSource: ${JSON.stringify(v)}`);
}

// Optional action fields typed `?: T` (no `| null`) must decode as `undefined`
// when absent, unlike the `?: T | null` fields (which stay `null`). These are
// the ones that encode as an absent/nil wire value rather than a default.
const UNDEFINED_WHEN_ABSENT = new Set([
  "oracleSource",
  "description",
  "rules",
  "poolId",
  "maxSlippageBps",
]);

function fromWasmValue(camelKey: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return UNDEFINED_WHEN_ABSENT.has(camelKey) ? undefined : null;
  }
  // serde-wasm-bindgen serializes u8 byte fields as a Uint8Array — pass it
  // through before the generic object branch would iterate its indices.
  if (value instanceof Uint8Array) return value;
  if (camelKey === "oracleSource") return eventOracleSourceFromWasm(value);
  if (camelKey === "markSourceMode" && typeof value === "string") {
    return MARK_SOURCE_MODE_VALUES[value];
  }
  const enumMap = NUMERIC_ENUM_FIELDS[camelKey];
  if (enumMap && typeof value === "string") return enumMap[value];
  if (Array.isArray(value)) {
    // A non-empty all-numbers array is a byte field (owner/signer/…) → bytes;
    // an array of objects (e.g. legs) recurses; an empty array stays `[]`.
    if (value.length > 0 && value.every((x) => typeof x === "number")) {
      return Uint8Array.from(value as number[]);
    }
    return value.map((v) =>
      v && typeof v === "object"
        ? fromWasmObject(v as Record<string, unknown>)
        : v,
    );
  }
  if (typeof value === "object") {
    return fromWasmObject(value as Record<string, unknown>);
  }
  return value; // bigint / number / boolean / plain string
}

function fromWasmObject(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const camel = snakeToCamel(k);
    out[camel] = fromWasmValue(camel, v);
  }
  return out;
}

/**
 * Translate `decode_payload`'s output back into a TS `Action`.
 */
export function fromWasmFields(
  actionType: ActionTypeValue,
  fields: unknown,
): Action {
  const type = ACTION_TYPE_NAMES[actionType];
  if (!type) throw new Error(`unknown action_type: ${actionType}`);
  return {
    type,
    data: fromWasmObject(fields as Record<string, unknown>),
  } as unknown as Action;
}
