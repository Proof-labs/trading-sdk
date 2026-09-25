/**
 * F7 governed admin actions that are PENDING ENGINE MERGE:
 *
 * | inner tag     | action                  | exchange draft PR                          |
 * | ------------- | ----------------------- | ------------------------------------------ |
 * | 17 / `0x11`   | `SetLiquidationConfig`  | #796 `feat/liquidation-config-record`      |
 * | 18 / `0x12`   | `FundInsuranceFund`     | #798 `feat/en-11-if-funding-action`        |
 * | 19 / `0x13`   | `UpdateTreasurySources` | #798 `feat/en-11-if-funding-action`        |
 *
 * The SDK's pinned proof-wire (v2.3.0) does not carry these arms, so the WASM
 * core cannot encode them and they are deliberately NOT members of the
 * `AdminAction` union: `propose`/`sign`/content-hash paths refuse them until a
 * proof-wire release does. This module gives operators and tooling the
 * validated payload types and the exact canonical inner-action bytes the
 * engine commits in a proposal's content hash, pinned in tests to the
 * engine's frozen `*_wire_vectors_frozen` hex on those branches. Once the
 * engine PRs merge and the wire tag is bumped, these move into `AdminAction`
 * and encode through the WASM core; this module then becomes a thin shim.
 */
import { Decoder } from "@msgpack/msgpack";

/** Inner admin tags claimed by the pending F7 actions (engine draft PRs). */
export const PENDING_F7_ADMIN_TAGS = {
  SetLiquidationConfig: 0x11,
  FundInsuranceFund: 0x12,
  UpdateTreasurySources: 0x13,
} as const;

/** Upper bound on the governed liquidation penalty, in bps (DEC-216,
 *  Decided 2026-09-24): `penaltyBps` is in `1..=100`. */
export const MAX_LIQUIDATION_PENALTY_BPS = 100;
/** The insurance and PLP shares of a collected penalty sum to this. */
export const LIQUIDATION_SPLIT_TOTAL_BPS = 10_000;
/** Registry bound, and per-side bound on one `UpdateTreasurySources`. */
export const MAX_TREASURY_SOURCES = 8;
/** Maximum per-pool allocations in one `FundInsuranceFund`. */
export const MAX_INSURANCE_FUNDING_ALLOCATIONS = 8;

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const ADDRESS_LEN = 20;

/** Payload of `SetLiquidationConfig` (inner tag 0x11, #796): the complete
 *  global liquidation configuration. Pending engine merge. */
export interface SetLiquidationConfig {
  /** Penalty in bps of the notional closed at the mark, `1..=100`
   *  (DEC-216). Zero is refused so a typo cannot switch the penalty off. */
  penaltyBps: number;
  /** Share of a collected penalty credited to the insurance fund, in bps. */
  insuranceShareBps: number;
  /** Share credited to the PLP, in bps. The two shares sum to 10 000. */
  plpShareBps: number;
}

/** One pool's share of a {@link FundInsuranceFund}, in microUSDC. */
export interface InsuranceFundAllocation {
  /** Insurance pool id (u8). */
  poolId: number;
  /** Non-zero; the allocations' sum is at most `i64::MAX`. */
  amount: bigint;
}

/** Payload of `FundInsuranceFund` (inner tag 0x12, #798). Debits a
 *  registered treasury source into insurance pools, atomically and at most
 *  once per `fundingId`. Pending engine merge. */
export interface FundInsuranceFund {
  /** Replay identity (u64); a second execution of the same id is refused. */
  fundingId: bigint;
  /** 20-byte source account. Must be in the treasury-source registry when
   *  the proposal executes (DEC-195); only the engine can check that. */
  source: Uint8Array;
  /** `1..=8` allocations in strictly ascending `poolId` order. */
  allocations: InsuranceFundAllocation[];
}

/** Payload of `UpdateTreasurySources` (inner tag 0x13, #798): adds and/or
 *  removes accounts in the treasury-source allowlist (DEC-195), the only
 *  accounts `FundInsuranceFund` may debit. Pending engine merge. */
export interface UpdateTreasurySources {
  /** Accounts to register: strictly ascending, at most 8, none zero. */
  add: Uint8Array[];
  /** Accounts to deregister: strictly ascending, at most 8, none zero. */
  remove: Uint8Array[];
}

/** A pending F7 admin action, tagged like `AdminAction`. */
export type PendingF7AdminAction =
  | { kind: "SetLiquidationConfig"; value: SetLiquidationConfig }
  | { kind: "FundInsuranceFund"; value: FundInsuranceFund }
  | { kind: "UpdateTreasurySources"; value: UpdateTreasurySources };

function checkU32(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > U32_MAX
  ) {
    throw new Error(`${what} must be an unsigned 32-bit integer`);
  }
  return value;
}

function checkU64(value: unknown, what: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new Error(`${what} must be an unsigned 64-bit bigint`);
  }
  return value;
}

function checkAddress(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== ADDRESS_LEN) {
    throw new Error(`${what} must be a 20-byte Uint8Array`);
  }
  if (value.every((b) => b === 0)) {
    throw new Error(`${what} must be non-zero`);
  }
  return value;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Mirror the engine's `validate_set_liquidation_config` (#796): a penalty in
 * `1..=MAX_LIQUIDATION_PENALTY_BPS` (DEC-216) and shares that sum to exactly
 * 10 000 bps. Pending engine merge.
 */
export function validateSetLiquidationConfig(
  action: SetLiquidationConfig,
): void {
  const penalty = checkU32(
    action?.penaltyBps,
    "SetLiquidationConfig.penaltyBps",
  );
  const insurance = checkU32(
    action.insuranceShareBps,
    "SetLiquidationConfig.insuranceShareBps",
  );
  const plp = checkU32(action.plpShareBps, "SetLiquidationConfig.plpShareBps");
  if (penalty === 0 || penalty > MAX_LIQUIDATION_PENALTY_BPS) {
    throw new Error(
      `SetLiquidationConfig: penaltyBps must be in 1..=${MAX_LIQUIDATION_PENALTY_BPS}`,
    );
  }
  if (insurance + plp !== LIQUIDATION_SPLIT_TOTAL_BPS) {
    throw new Error(
      `SetLiquidationConfig: insuranceShareBps + plpShareBps must equal ${LIQUIDATION_SPLIT_TOTAL_BPS}`,
    );
  }
}

/**
 * Mirror the engine's `validate_fund_insurance_fund` (#798): a non-zero
 * source, `1..=8` allocations in strictly ascending pool order, every amount
 * non-zero and the total at most `i64::MAX`. Returns the total debit.
 * Whether `source` is on the treasury-source allowlist (DEC-195) is state the
 * engine checks at execution; a caller can confirm it beforehand against the
 * financial snapshot's `treasurySources` slot. Pending engine merge.
 */
export function validateFundInsuranceFund(action: FundInsuranceFund): bigint {
  checkU64(action?.fundingId, "FundInsuranceFund.fundingId");
  checkAddress(action.source, "FundInsuranceFund.source");
  const allocations = action.allocations;
  if (
    !Array.isArray(allocations) ||
    allocations.length === 0 ||
    allocations.length > MAX_INSURANCE_FUNDING_ALLOCATIONS
  ) {
    throw new Error(
      `FundInsuranceFund: needs 1..=${MAX_INSURANCE_FUNDING_ALLOCATIONS} allocations`,
    );
  }
  let total = 0n;
  let previous = -1;
  for (const allocation of allocations) {
    const pool = checkU32(allocation?.poolId, "FundInsuranceFund.poolId");
    if (pool > 0xff) {
      throw new Error(
        "FundInsuranceFund.poolId must be an unsigned 8-bit integer",
      );
    }
    if (pool <= previous) {
      throw new Error(
        "FundInsuranceFund: allocations must be in strictly ascending pool order",
      );
    }
    previous = pool;
    const amount = checkU64(allocation.amount, "FundInsuranceFund.amount");
    if (amount === 0n) {
      throw new Error("FundInsuranceFund: allocation amount must be non-zero");
    }
    total += amount;
    if (total > I64_MAX) {
      throw new Error("FundInsuranceFund: total must not exceed i64::MAX");
    }
  }
  return total;
}

/**
 * Mirror the engine's `validate_update_treasury_sources` (#798): at least one
 * side non-empty, each side at most 8 accounts, strictly ascending,
 * duplicate-free and without the zero account, and the sides disjoint.
 * Registry membership and the post-change bound are engine state checks.
 * Pending engine merge.
 */
export function validateUpdateTreasurySources(
  action: UpdateTreasurySources,
): void {
  if (!Array.isArray(action?.add) || !Array.isArray(action.remove)) {
    throw new Error("UpdateTreasurySources: add and remove must be arrays");
  }
  if (action.add.length === 0 && action.remove.length === 0) {
    throw new Error(
      "UpdateTreasurySources: must add or remove at least one account",
    );
  }
  for (const [side, accounts] of [
    ["add", action.add],
    ["remove", action.remove],
  ] as const) {
    if (accounts.length > MAX_TREASURY_SOURCES) {
      throw new Error(
        `UpdateTreasurySources: ${side} list exceeds ${MAX_TREASURY_SOURCES} accounts`,
      );
    }
    accounts.forEach((account, i) => {
      checkAddress(account, `UpdateTreasurySources.${side}[${i}]`);
      if (i > 0 && compareBytes(accounts[i - 1], account) >= 0) {
        throw new Error(
          `UpdateTreasurySources: ${side} list must be strictly ascending and duplicate-free`,
        );
      }
    });
  }
  for (const account of action.add) {
    if (action.remove.some((other) => compareBytes(account, other) === 0)) {
      throw new Error(
        "UpdateTreasurySources: an account may not appear in both add and remove",
      );
    }
  }
}

/** Validate any pending F7 admin action against the engine's shape rules. */
export function validatePendingF7AdminAction(
  action: PendingF7AdminAction,
): void {
  switch (action?.kind) {
    case "SetLiquidationConfig":
      return validateSetLiquidationConfig(action.value);
    case "FundInsuranceFund":
      validateFundInsuranceFund(action.value);
      return;
    case "UpdateTreasurySources":
      return validateUpdateTreasurySources(action.value);
    default:
      throw new Error(
        `pending F7 admin action: unknown kind ${JSON.stringify((action as { kind?: unknown })?.kind)}`,
      );
  }
}

// --- canonical MessagePack (rmp-serde's minimal encoding) -------------------

class CanonicalWriter {
  private readonly bytes: number[] = [];

  uint(value: bigint): void {
    if (value < 0n || value > U64_MAX) throw new Error("uint out of range");
    if (value <= 0x7fn) {
      this.bytes.push(Number(value));
    } else if (value <= 0xffn) {
      this.bytes.push(0xcc, Number(value));
    } else if (value <= 0xffffn) {
      this.bytes.push(0xcd, ...this.be(value, 2));
    } else if (value <= 0xffff_ffffn) {
      this.bytes.push(0xce, ...this.be(value, 4));
    } else {
      this.bytes.push(0xcf, ...this.be(value, 8));
    }
  }

  array(length: number): void {
    if (length <= 15) this.bytes.push(0x90 | length);
    else if (length <= 0xffff)
      this.bytes.push(0xdc, length >> 8, length & 0xff);
    else throw new Error("array too long");
  }

  str(text: string): void {
    const utf8 = new TextEncoder().encode(text);
    if (utf8.length <= 31) this.bytes.push(0xa0 | utf8.length);
    else if (utf8.length <= 0xff) this.bytes.push(0xd9, utf8.length);
    else throw new Error("string too long");
    this.bytes.push(...utf8);
  }

  /** `AccountAddress([u8; 20])`: a 20-element integer array. */
  address(bytes: Uint8Array): void {
    this.array(bytes.length);
    for (const b of bytes) this.uint(BigInt(b));
  }

  /** Externally tagged enum variant: a one-entry map `{ name: payload }`. */
  variant(name: string): void {
    this.bytes.push(0x81);
    this.str(name);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private be(value: bigint, width: number): number[] {
    const out: number[] = [];
    for (let i = width - 1; i >= 0; i--) {
      out.push(Number((value >> BigInt(i * 8)) & 0xffn));
    }
    return out;
  }
}

/**
 * The canonical inner admin-action bytes (rmp-serde, externally tagged
 * variant map over the positional payload) that the engine's
 * `canonical_admin_action_bytes` produces and a proposal's content hash
 * commits. Validates first; never encodes a payload the engine would refuse.
 * Pending engine merge: not submittable through the SDK's propose path yet.
 */
export function encodePendingF7AdminAction(
  action: PendingF7AdminAction,
): Uint8Array {
  validatePendingF7AdminAction(action);
  const w = new CanonicalWriter();
  w.variant(action.kind);
  switch (action.kind) {
    case "SetLiquidationConfig": {
      const v = action.value;
      w.array(3);
      w.uint(BigInt(v.penaltyBps));
      w.uint(BigInt(v.insuranceShareBps));
      w.uint(BigInt(v.plpShareBps));
      break;
    }
    case "FundInsuranceFund": {
      const v = action.value;
      w.array(3);
      w.uint(v.fundingId);
      w.address(v.source);
      w.array(v.allocations.length);
      for (const allocation of v.allocations) {
        w.array(2);
        w.uint(BigInt(allocation.poolId));
        w.uint(allocation.amount);
      }
      break;
    }
    case "UpdateTreasurySources": {
      const v = action.value;
      w.array(2);
      for (const side of [v.add, v.remove]) {
        w.array(side.length);
        for (const account of side) w.address(account);
      }
      break;
    }
  }
  return w.finish();
}

function tuple(raw: unknown, size: number, what: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== size) {
    throw new Error(`pending F7 admin decode: ${what} is not a ${size}-tuple`);
  }
  return raw;
}

function list(raw: unknown, what: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error(`pending F7 admin decode: ${what} is not an array`);
  }
  return raw;
}

function toU64(raw: unknown, what: string): bigint {
  const n =
    typeof raw === "number" && Number.isSafeInteger(raw) ? BigInt(raw) : raw;
  if (typeof n !== "bigint" || n < 0n || n > U64_MAX) {
    throw new Error(`pending F7 admin decode: ${what} is not a u64`);
  }
  return n;
}

function toSmall(raw: unknown, max: number, what: string): number {
  const n = toU64(raw, what);
  if (n > BigInt(max)) {
    throw new Error(`pending F7 admin decode: ${what} is out of range`);
  }
  return Number(n);
}

function toAddress(raw: unknown, what: string): Uint8Array {
  const items = list(raw, what);
  if (items.length !== ADDRESS_LEN) {
    throw new Error(`pending F7 admin decode: ${what} is not 20 bytes`);
  }
  return Uint8Array.from(items.map((b) => toSmall(b, 0xff, what)));
}

/**
 * Decode canonical inner admin-action bytes for one of the pending F7
 * actions. Fails closed: the bytes must be a one-entry variant map naming a
 * pending action, the payload must have the exact positional shape, it must
 * pass the engine's shape rules, and re-encoding must reproduce the input
 * byte for byte (non-canonical encodings are refused).
 */
export function decodePendingF7AdminAction(
  bytes: Uint8Array,
): PendingF7AdminAction {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("pending F7 admin decode: input is not a Uint8Array");
  }
  const raw: unknown = new Decoder({
    useBigInt64: true,
    maxStrLength: 32,
    maxBinLength: 0,
    maxArrayLength: 32,
    maxMapLength: 1,
    maxExtLength: 0,
  }).decode(bytes);
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 1
  ) {
    throw new Error("pending F7 admin decode: not a single-variant map");
  }
  const [kind, payload] = Object.entries(raw)[0];
  let action: PendingF7AdminAction;
  switch (kind) {
    case "SetLiquidationConfig": {
      const p = tuple(payload, 3, kind);
      action = {
        kind,
        value: {
          penaltyBps: toSmall(p[0], U32_MAX, "penaltyBps"),
          insuranceShareBps: toSmall(p[1], U32_MAX, "insuranceShareBps"),
          plpShareBps: toSmall(p[2], U32_MAX, "plpShareBps"),
        },
      };
      break;
    }
    case "FundInsuranceFund": {
      const p = tuple(payload, 3, kind);
      action = {
        kind,
        value: {
          fundingId: toU64(p[0], "fundingId"),
          source: toAddress(p[1], "source"),
          allocations: list(p[2], "allocations").map((entry) => {
            const a = tuple(entry, 2, "allocation");
            return {
              poolId: toSmall(a[0], 0xff, "poolId"),
              amount: toU64(a[1], "amount"),
            };
          }),
        },
      };
      break;
    }
    case "UpdateTreasurySources": {
      const p = tuple(payload, 2, kind);
      action = {
        kind,
        value: {
          add: list(p[0], "add").map((a) => toAddress(a, "add")),
          remove: list(p[1], "remove").map((a) => toAddress(a, "remove")),
        },
      };
      break;
    }
    default:
      throw new Error(
        `pending F7 admin decode: ${JSON.stringify(kind)} is not a pending F7 action`,
      );
  }
  try {
    validatePendingF7AdminAction(action);
  } catch (e) {
    throw new Error(`pending F7 admin decode: ${(e as Error).message}`);
  }
  const canonical = encodePendingF7AdminAction(action);
  if (
    canonical.length !== bytes.length ||
    canonical.some((b, i) => b !== bytes[i])
  ) {
    throw new Error("pending F7 admin decode: bytes are not canonical");
  }
  return action;
}
