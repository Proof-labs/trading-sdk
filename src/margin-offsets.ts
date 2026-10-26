import type {
  MarginOffsetPair,
  SetMarginOffsetPolicy,
  TxEvent,
} from "./types.js";

/** Canonical proof-wire capacity; the Rust suite pins the same value. */
export const MAX_MARGIN_OFFSET_PAIRS = 52;
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

function unsignedNumber(
  value: unknown,
  field: string,
  maximum = U32_MAX,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${field} must be an unsigned integer at most ${maximum}`);
  }
  return value;
}

function sequence(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U64_MAX) {
    throw new Error(`${field} must be a nonzero u64 bigint`);
  }
  return value;
}

export function validateSetMarginOffsetPolicy(
  policy: SetMarginOffsetPolicy,
): void {
  if (policy.predecessor !== null) sequence(policy.predecessor, "predecessor");
  if (
    !Array.isArray(policy.pairs) ||
    policy.pairs.length > MAX_MARGIN_OFFSET_PAIRS
  ) {
    throw new Error(
      `pairs must contain at most ${MAX_MARGIN_OFFSET_PAIRS} entries`,
    );
  }
  let previous: number | undefined;
  for (const pair of policy.pairs) {
    validateMarginOffsetPair(pair);
    if (previous !== undefined && pair.conditional <= previous) {
      throw new Error(
        "pairs must have strictly increasing, unique conditionals",
      );
    }
    previous = pair.conditional;
  }
}

function validateMarginOffsetPair(pair: MarginOffsetPair): void {
  unsignedNumber(pair.perpetual, "perpetual");
  unsignedNumber(pair.conditional, "conditional");
  unsignedNumber(pair.settlementReference, "settlementReference");
  unsignedNumber(pair.rate, "rate", 9_999);
  if (pair.rate === 0) throw new Error("rate must be in 1..=9999 basis points");
  if (pair.perpetual === pair.conditional)
    throw new Error("pair markets must differ");
  if (pair.settlementReference !== pair.perpetual)
    throw new Error("settlementReference must equal perpetual");
  if (pair.resolution !== "RemoveOnResolution")
    throw new Error("unknown resolution treatment");
}

export interface MarginOffsetPolicySetEvent {
  type: "MarginOffsetPolicySet";
  sequence: bigint;
  pairCount: number;
  proposalId: bigint;
}

export interface MarginOffsetPairConfiguredEvent {
  type: "MarginOffsetPairConfigured";
  sequence: bigint;
  index: number;
  pair: MarginOffsetPair;
}

export type MarginOffsetEvent =
  MarginOffsetPolicySetEvent | MarginOffsetPairConfiguredEvent;

/** Decode the named scalar attributes emitted by the engine. */
export function decodeMarginOffsetEvent(
  event: TxEvent,
): MarginOffsetEvent | null {
  if (
    event.type !== "margin_offset_policy_set" &&
    event.type !== "margin_offset_pair_configured"
  )
    return null;
  const attributes = new Map<string, string>();
  for (const { key, value } of event.attributes) {
    if (attributes.has(key))
      throw new Error(`duplicate offset attribute ${key}`);
    attributes.set(key, value);
  }
  const current = sequence(
    integerAttribute(attributes, "sequence"),
    "sequence",
  );
  if (event.type === "margin_offset_policy_set") {
    return {
      type: "MarginOffsetPolicySet",
      sequence: current,
      pairCount: numberAttribute(
        attributes,
        "pair_count",
        MAX_MARGIN_OFFSET_PAIRS,
      ),
      // A proposal id may be any u64, including zero on a genesis-seeded
      // registry; unlike the policy sequence it has no non-zero floor.
      proposalId: integerAttribute(attributes, "proposal_id"),
    };
  }
  const resolution = attributes.get("resolution");
  if (resolution !== "remove_on_resolution")
    throw new Error("unknown offset resolution treatment");
  const pair: MarginOffsetPair = {
    perpetual: numberAttribute(attributes, "perpetual_market"),
    conditional: numberAttribute(attributes, "conditional_market"),
    settlementReference: numberAttribute(
      attributes,
      "settlement_reference_market",
    ),
    rate: numberAttribute(attributes, "rate_bps", 9_999),
    resolution: "RemoveOnResolution",
  };
  validateMarginOffsetPair(pair);
  return {
    type: "MarginOffsetPairConfigured",
    sequence: current,
    index: numberAttribute(attributes, "index", MAX_MARGIN_OFFSET_PAIRS - 1),
    pair,
  };
}

function integerAttribute(
  attributes: Map<string, string>,
  key: string,
): bigint {
  const value = attributes.get(key);
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`invalid offset attribute ${key}`);
  const decoded = BigInt(value);
  if (decoded > U64_MAX) throw new Error(`offset attribute ${key} exceeds u64`);
  return decoded;
}

function numberAttribute(
  attributes: Map<string, string>,
  key: string,
  maximum = U32_MAX,
): number {
  const value = integerAttribute(attributes, key);
  if (value > BigInt(maximum))
    throw new Error(`offset attribute ${key} exceeds ${maximum}`);
  return Number(value);
}
